import { randomUUID } from "node:crypto";
import type { SqliteDatabase } from "../db/connection";
import type { Collector, CollectorOffer, ProbeAttempt } from "../collectors/types";
import { collectorFor, detectCollector, PendingCollectorError } from "../collectors";
import { collectBrowser, collectShopApiViaBrowser, isChallengeBlockedError } from "../collectors/browser";
import { normalizeHostname } from "../collectors/util";
import { httpClient, type HttpClient } from "./http";
import { withProxySession } from "./proxy";
import { shouldDelistMissing, type CollectionMethod } from "./freshness";
import { shouldFallbackToBrowser, isRetryableUpstreamError, isHostThrottledError } from "./waf";
import { canAutoUpdateStoreName, resolveStoreName } from "./sourceProbe";
import {
  type SourceRow, targetFromSource, upsertOffers, countActiveOffers, activeOfferIds, delistMissing,
  acquireSourceLock, renewSourceLock, releaseSourceLock, recordCrawlRun, markSourceSuccess, markSourceFailure, persistSourceKind, nowIso,
  markSourceManualRequired, updateSource,
} from "../db/repo";

export type SourceStatus = "success" | "partial" | "failed" | "skipped" | "manual_required";

export interface SourceResult {
  sourceId: string;
  sourceName: string;
  status: SourceStatus;
  offerCount: number;
  written: number;
  seenCount: number;
  delisted: number;
  message?: string;
}

export interface CollectDeps {
  http?: HttpClient;
  resolveCollector?: (kind: string | null, hostOrUrl: string) => Collector;
  browserCollector?: Collector;
  shopApiBrowserCollector?: Collector;
  ttlMs?: number;
  owner?: string;
}

const LOCK_TTL = 10 * 60 * 1000;
const RENEW_EVERY = 2 * 60 * 1000;

/** SHOP_NO_BROWSER_FALLBACK=1：整机不具备浏览器采集条件（无桌面/未装 Chromium）时全面禁用。 */
function browserDisabled(): boolean {
  return process.env.SHOP_NO_BROWSER_FALLBACK === "1";
}
const HIGH_CONFIDENCE_EVIDENCE = /^(接口指纹|域名注册表|URL 形态|HTML 指纹|HTML 价格锚点)/;

function canPersistDetectedKind(kind: string, evidence: string | null, status: SourceStatus, usedDetectOffers: boolean): boolean {
  if (kind === "auto" || kind === "pending" || kind === "unsupported") return false;
  const text = evidence ?? "";
  if (!text.trim()) return false;
  if (kind === "browser") return status === "success" && /^首页/.test(text);
  return status === "success" || usedDetectOffers || HIGH_CONFIDENCE_EVIDENCE.test(text);
}

function canFallbackToBrowser(kind: string): boolean {
  return kind !== "kami" && kind !== "dujiao" && kind !== "dujiaoHtml";
}

function isShopApiSource(source: SourceRow, resolvedKind: string): boolean {
  return resolvedKind === "shopApi" || source.collector_kind === "shopApi" || /\/(shop|item)\/[^/?#]+/.test(source.entry_url);
}

function persistenceMethod(source: SourceRow, resolvedKind: string): string {
  return resolvedKind === "browser" || source.collector_kind === "browser" ? "browser" : "http";
}

// 同域名并发。默认 1：多家店铺常挂在同一域名（如 20+ 家链动小铺同在 pay.ldxp.cn），
// 并发打同一域名极易触发整站限流/封 IP，得不偿失。
function hostConcurrencyLimit(): number {
  const value = Number(process.env.SHOP_COLLECT_HOST_CONCURRENCY ?? 1);
  return Number.isFinite(value) ? Math.max(1, Math.floor(value)) : 1;
}

// 同域名两次请求间隔。默认 1500ms：一次采集要打 info/categoryList/goodsList 多个接口，
// 间隔太小会在几秒内产生几百个请求，正是触发风控的原因。
function hostDelayMs(): number {
  const value = Number(process.env.SHOP_COLLECT_HOST_DELAY_MS ?? 1500);
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 1500;
}

// 浏览器采集并发。默认 1：每个无头 Chrome 约 300–600MB，2C/2.5G 级服务器上并发 2 就有 OOM 风险。
function browserConcurrency(): number {
  const value = Number(process.env.SHOP_BROWSER_CONCURRENCY ?? 1);
  return Number.isFinite(value) ? Math.max(1, Math.floor(value)) : 1;
}

function isManualRequiredSkip(source: SourceRow): boolean {
  return source.health_status === "manual_required";
}

function recordManualRequiredSkip(db: SqliteDatabase, source: SourceRow): SourceResult {
  const at = nowIso();
  const message = "等待人工验证，跳过自动采集";
  recordCrawlRun(db, {
    id: randomUUID(),
    sourceId: source.id,
    sourceName: source.name,
    mode: "browser",
    status: "skipped",
    startedAt: at,
    finishedAt: at,
    successCount: 0,
    failureCount: 0,
    message,
    details: { manualRequired: true },
  });
  return { sourceId: source.id, sourceName: source.name, status: "skipped", offerCount: 0, written: 0, seenCount: 0, delisted: 0, message };
}

/**
 * 记录「同域名已触发限流，本轮跳过」。
 * 走 skipped 而非 failed：域名在拒绝我们的出口 IP，不代表这些店铺本身坏了，
 * 因此不累加 consecutive_failures、不污染店铺健康状态。
 */
function recordHostThrottledSkip(db: SqliteDatabase, source: SourceRow, host: string): SourceResult {
  const at = nowIso();
  const message = `同域名（${host}）已触发限流/封禁，本轮跳过以免加深封禁`;
  recordCrawlRun(db, {
    id: randomUUID(),
    sourceId: source.id,
    sourceName: source.name,
    mode: source.collector_kind === "browser" ? "browser" : "http",
    status: "skipped",
    startedAt: at,
    finishedAt: at,
    successCount: 0,
    failureCount: 0,
    message,
    details: { hostThrottled: true, host },
  });
  return { sourceId: source.id, sourceName: source.name, status: "skipped", offerCount: 0, written: 0, seenCount: 0, delisted: 0, message };
}

/**
 * 采集单个店铺：取锁 → 采集 → 事务(upsert + 差集下架) → 记日志/健康 → finally 释放锁。
 *
 * 整个过程包在一个代理会话里：启用代理池时，这家店铺的全部请求（含浏览器采集）
 * 走同一个出口 IP，店铺之间才轮换出口。
 */
export async function collectSource(db: SqliteDatabase, source: SourceRow, deps: CollectDeps = {}): Promise<SourceResult> {
  return withProxySession(source.id, () => collectSourceInner(db, source, deps));
}

async function collectSourceInner(db: SqliteDatabase, source: SourceRow, deps: CollectDeps = {}): Promise<SourceResult> {
  const owner = deps.owner ?? `node-${randomUUID().slice(0, 8)}`;
  const ttl = deps.ttlMs ?? LOCK_TTL;
  const http = deps.http ?? httpClient;
  const startedAt = nowIso();
  const base = { sourceId: source.id, sourceName: source.name };

  if (!acquireSourceLock(db, source.id, owner, ttl, startedAt)) {
    return { ...base, status: "skipped", offerCount: 0, written: 0, seenCount: 0, delisted: 0, message: "源被占用（锁）" };
  }

  const initialMethod: CollectionMethod = source.collector_kind === "browser" ? "browser" : "http";
  let usedMethod: CollectionMethod = initialMethod;
  let fellBackToBrowser = false;
  let resolvedKind: string = source.collector_kind || "auto";
  let detectEvidence: string | null = source.kind_evidence ?? null;
  let detectAttempts: ProbeAttempt[] = [];
  let usedDetectOffers = false;
  let ranDetection = false;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  const startHeartbeat = () => {
    if (!heartbeat) heartbeat = setInterval(() => renewSourceLock(db, source.id, owner, ttl), RENEW_EVERY);
  };

  try {
    if (initialMethod === "browser") startHeartbeat();

    let target = targetFromSource(source);
    const hostOrUrl = source.entry_url || source.base_url || "";
    const storedKind = source.collector_kind || "auto";

    // 解析并执行某个具体类型的采集器。
    // browser 且 URL 命中 /shop|item/ → 走「浏览器过 WAF + 页面内调 shopApi」拿结构化数据，
    // 而非通用 DOM 提取（后者会把店铺公告/分类文字误当商品）。
    const runResolvedCollector = async (kind: string): Promise<CollectorOffer[]> => {
      if (kind === "browser") {
        // 禁用浏览器时，判定为 browser 等同于「没有可用的 HTTP 采集器」：
        // 直接记为待办，而不是去启动一个不存在的浏览器再报错。
        if (browserDisabled()) {
          throw new PendingCollectorError("采集器待办：该站点需浏览器采集，但本机已禁用浏览器（SHOP_NO_BROWSER_FALLBACK=1）。");
        }
        usedMethod = "browser";
        startHeartbeat();
        const isShopApi = /\/(shop|item)\/[^/?#]+/.test(target.sourceUrl);
        const browserCollector = isShopApi ? (deps.shopApiBrowserCollector ?? collectShopApiViaBrowser) : (deps.browserCollector ?? collectBrowser);
        return await browserCollector(target, httpClient);
      }
      return await collectorFor(kind, hostOrUrl)(target, http);
    };

    // 实地探测类型并采集：auto 源，或存量 kind 采空/采败后的自愈。设置 resolvedKind/evidence 等闭包状态。
    const runDetection = async (): Promise<CollectorOffer[]> => {
      ranDetection = true;
      const detected = await detectCollector(target, http);
      resolvedKind = detected.kind;
      detectEvidence = detected.evidence;
      detectAttempts = detected.attempts ?? [];
      if (detected.offers?.length) {
        usedDetectOffers = true;
        return detected.offers;
      }
      return await runResolvedCollector(detected.kind);
    };

    let collected: CollectorOffer[] | undefined;
    try {
      if (deps.resolveCollector) {
        collected = await deps.resolveCollector(source.collector_kind, hostOrUrl)(target, http); // 测试注入
      } else {
        const shouldDetect = !source.collector_kind || storedKind === "auto" || source.consecutive_failures >= 3;
        collected = shouldDetect ? await runDetection() : await runResolvedCollector(storedKind);
      }
    } catch (err) {
      const fallbackEnabled = !browserDisabled();
      if (fallbackEnabled && initialMethod !== "browser" && canFallbackToBrowser(resolvedKind) && shouldFallbackToBrowser(err)) {
        // HTTP 采集被验证码/风控拦截 → 自动改用浏览器采集器（除非用 SHOP_NO_BROWSER_FALLBACK=1 关闭）
        usedMethod = "browser";
        fellBackToBrowser = true;
        startHeartbeat(); // 浏览器采集较慢，续租源锁
        // 链动小铺/ShopApi 用「浏览器过 WAF + 页面内调接口」拿结构化数据；其它站用通用 DOM 提取
        const isShopApi = resolvedKind === "shopApi" || /\/(shop|item)\/[^/?#]+/.test(target.sourceUrl);
        const browserCollector = isShopApi ? (deps.shopApiBrowserCollector ?? collectShopApiViaBrowser) : (deps.browserCollector ?? collectBrowser);
        collected = await browserCollector(target, httpClient);
      } else if (!deps.resolveCollector && !ranDetection && !isChallengeBlockedError(err) && !isRetryableUpstreamError(err)) {
        // 注意：自愈与浏览器无关，故不受 SHOP_NO_BROWSER_FALLBACK 约束。
        // 早前它被 fallbackEnabled 一并关掉，导致禁用浏览器的部署失去「类型过期自动重识别」能力。
        // 自愈：存量 kind 采集失败（类型过期/误判/提取不到）→ 重新识别并重试一次。
        // 等价于「删除店铺重新添加」时走 auto 检测的效果，根治「批量重跑部分店铺失败、删除重加就好」。
        // 上游临时错误（限流/5xx/52x/超时）不在此列：类型没错，稍后重试即可，避免换错采集器与加倍打站点。
        collected = await runDetection();
      } else {
        throw err;
      }
    }

    // 自愈：存量 kind 采到 0 条，可能是类型过期。重新识别；仅当识别出的类型与原来不同才改用它，
    // 避免对本就没有上架商品的店铺做无谓的二次采集。
    if (!deps.resolveCollector && !ranDetection && (!collected || collected.length === 0)) {
      const detected = await detectCollector(target, http);
      ranDetection = true;
      resolvedKind = detected.kind;
      detectEvidence = detected.evidence;
      detectAttempts = detected.attempts ?? [];
      if (detected.offers?.length) {
        collected = detected.offers;
        usedDetectOffers = true;
      } else if (detected.kind !== storedKind) {
        collected = await runResolvedCollector(detected.kind);
      }
    }

    collected = collected ?? [];

    let sourceName = source.name;
    if (!deps.resolveCollector && ranDetection) {
      const storeName = await resolveStoreName(target, http, collected);
      if (canAutoUpdateStoreName(source, storeName)) {
        updateSource(db, source.id, { name: storeName, nameSource: "auto" });
        sourceName = storeName;
        target = { ...target, sourceName: storeName };
      }
    }

    const previousActive = countActiveOffers(db, source.id);
    const previousIds = activeOfferIds(db, source.id); // 必须在 upsert 前取，写入后新旧 id 就混在一起了
    const outcome = {
      written: 0,
      seenCount: 0,
      delisted: 0,
      skippedZeroPrice: 0,
      partialMessage: null as string | null,
    };

    const tx = db.transaction(() => {
      const r = upsertOffers(db, target, usedMethod, collected);
      outcome.written = r.written;
      outcome.seenCount = r.seenIds.length;
      outcome.skippedZeroPrice = r.skippedZeroPrice;

      // 用「实际入库条数」而非采集条数判空：整店都是标价 0 的占位商品时，
      // 采集看似有结果、实则一条可用报价都没有，此时同样不能删旧数据。
      if (outcome.seenCount === 0) {
        outcome.partialMessage = r.skippedZeroPrice > 0
          ? `采集结果为空（${r.skippedZeroPrice} 条标价 0 已丢弃）`
          : "采集结果为空";
        return;
      }
      // 采集器类型切换（如 browser DOM → shopApi 接口）会换掉 offer id 的生成体系
      // （DOM 用 `br:标题`，接口用 goods_key），于是新数据不覆盖旧数据、两批并存 → 前台重复显示。
      // 此时本次结果与库存记录的 id 交集为 0：旧记录永远不会再被"见到"，必须下架，
      // 且不能被下面「结果偏少」的保护挡住——新旧条数对不上正是换体系的正常表现。
      const idSchemeChanged = previousIds.size > 0 && outcome.seenCount > 0 && !r.seenIds.some((id) => previousIds.has(id));
      const delistOk = idSchemeChanged || shouldDelistMissing({ status: "success", fullSnapshot: true, seenCount: outcome.seenCount, previousActiveCount: previousActive });
      if (delistOk) {
        outcome.delisted = delistMissing(db, source.id, r.seenIds, nowIso());
        if (idSchemeChanged) outcome.partialMessage = `采集方式已变更，下架 ${outcome.delisted} 条旧体系报价`;
      } else if (previousActive > 0 && outcome.seenCount < Math.max(1, Math.floor(previousActive * 0.5))) {
        outcome.partialMessage = "返回异常偏少，未做下架"; // 保护性不下架
      }
    });
    tx();

    const finishedAt = nowIso();
    const status: SourceStatus = outcome.partialMessage ? "partial" : "success";
    recordCrawlRun(db, {
      id: randomUUID(), sourceId: source.id, sourceName, mode: usedMethod, status,
      startedAt, finishedAt, successCount: outcome.written, failureCount: 0,
      message: outcome.partialMessage ?? (fellBackToBrowser ? "HTTP 被风控，已自动改用浏览器采集" : null),
      details: {
        fullSnapshot: true,
        seenCount: outcome.seenCount,
        delisted: outcome.delisted,
        received: collected.length,
        skippedZeroPrice: outcome.skippedZeroPrice,
        previousActive,
        fellBackToBrowser,
        resolvedKind,
        evidence: detectEvidence,
        attempts: detectAttempts,
        usedDetectOffers,
      },
    });
    if (!deps.resolveCollector && canPersistDetectedKind(resolvedKind, detectEvidence, status, usedDetectOffers)) {
      persistSourceKind(db, source.id, {
        kind: resolvedKind,
        evidence: detectEvidence!,
        at: finishedAt,
        method: persistenceMethod(source, resolvedKind),
      });
    }
    if (!deps.resolveCollector && resolvedKind !== "browser" && source.collector_kind !== "browser" && usedMethod !== "browser" && source.collection_method === "browser") {
      updateSource(db, source.id, { collectionMethod: "http" });
    }
    markSourceSuccess(db, source.id, status, finishedAt);

    // 带上 partial 原因：runJob 会把它写进任务的 last_error，后台才看得到「为什么只是部分成功」。
    return {
      ...base, sourceName, status,
      offerCount: collected.length, written: outcome.written, seenCount: outcome.seenCount, delisted: outcome.delisted,
      ...(outcome.partialMessage ? { message: outcome.partialMessage } : {}),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const finishedAt = nowIso();
    if (usedMethod === "browser" && isChallengeBlockedError(err)) {
      if (!deps.resolveCollector) {
        persistSourceKind(db, source.id, {
          kind: isShopApiSource(source, resolvedKind) ? "shopApi" : resolvedKind === "browser" ? "browser" : source.collector_kind,
          method: persistenceMethod(source, resolvedKind),
          at: finishedAt,
          evidence: detectEvidence ?? `${resolvedKind} 回退浏览器采集后挑战未通过，等待人工验证`,
        });
      }
      markSourceManualRequired(db, source.id, message, finishedAt);
      recordCrawlRun(db, {
        id: randomUUID(), sourceId: source.id, sourceName: source.name, mode: usedMethod, status: "manual_required",
        startedAt, finishedAt, successCount: 0, failureCount: 0, message,
        details: { resolvedKind, evidence: detectEvidence, attempts: detectAttempts, fellBackToBrowser },
      });
      return { ...base, status: "manual_required", offerCount: 0, written: 0, seenCount: 0, delisted: 0, message };
    }
    if (!deps.resolveCollector && canPersistDetectedKind(resolvedKind, detectEvidence, "failed", usedDetectOffers)) {
      persistSourceKind(db, source.id, {
        kind: resolvedKind,
        evidence: detectEvidence!,
        at: finishedAt,
        method: persistenceMethod(source, resolvedKind),
      });
    }
    markSourceFailure(db, source.id, message, finishedAt);
    recordCrawlRun(db, {
      id: randomUUID(), sourceId: source.id, sourceName: source.name, mode: usedMethod, status: "failed",
      startedAt, finishedAt, successCount: 0, failureCount: 1, message, details: { resolvedKind, evidence: detectEvidence, attempts: detectAttempts, fellBackToBrowser },
    });
    return { ...base, status: "failed", offerCount: 0, written: 0, seenCount: 0, delisted: 0, message };
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    releaseSourceLock(db, source.id, owner);
  }
}

async function runPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await fn(items[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}

async function runPoolByHost<T, R>(
  items: T[],
  limit: number,
  perHostLimit: number,
  releaseDelayMs: number,
  hostOf: (item: T) => string,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  if (!items.length) return [];
  const results: R[] = new Array(items.length);
  const pending = items.map((_, index) => index);
  const hostActive = new Map<string, number>();
  let active = 0;
  let completed = 0;

  return await new Promise<R[]>((resolve, reject) => {
    let rejected = false;

    const finishHostSlot = (host: string) => {
      setTimeout(() => {
        hostActive.set(host, Math.max(0, (hostActive.get(host) ?? 1) - 1));
        schedule();
      }, releaseDelayMs);
    };

    const launch = (index: number, host: string) => {
      active += 1;
      hostActive.set(host, (hostActive.get(host) ?? 0) + 1);
      Promise.resolve(fn(items[index]!))
        .then((result) => {
          results[index] = result;
        })
        .catch((err) => {
          rejected = true;
          reject(err);
        })
        .finally(() => {
          active -= 1;
          completed += 1;
          finishHostSlot(host);
          if (!rejected && completed === items.length) resolve(results);
          if (!rejected) schedule();
        });
    };

    const schedule = () => {
      if (rejected) return;
      if (completed === items.length) return;

      let madeProgress = true;
      while (active < Math.min(limit, items.length) && madeProgress) {
        madeProgress = false;
        for (let pendingIndex = 0; pendingIndex < pending.length && active < Math.min(limit, items.length); pendingIndex += 1) {
          const index = pending[pendingIndex]!;
          const host = hostOf(items[index]!) || "__unknown__";
          if ((hostActive.get(host) ?? 0) >= perHostLimit) continue;
          pending.splice(pendingIndex, 1);
          pendingIndex -= 1;
          madeProgress = true;
          launch(index, host);
        }
      }
    };

    schedule();
  });
}

export interface RunAllResult {
  status: "success" | "partial";
  total: number;
  results: SourceResult[];
  skippedSources: string[];
  failedSources: string[];
  partialSources: string[];
  manualRequiredSources: string[];
}

/** 采集全部启用店铺（并发上限）。任一源非 success → 整体 partial，并按原因列出来源。 */
export async function runAllSources(
  db: SqliteDatabase,
  sources: SourceRow[],
  deps: CollectDeps & { concurrency?: number } = {},
): Promise<RunAllResult> {
  const concurrency = deps.concurrency ?? 15;
  const results: SourceResult[] = new Array(sources.length);
  const runnableSources = sources
    .map((source, index) => ({ source, index }))
    .filter(({ source, index }) => {
      if (!isManualRequiredSkip(source)) return true;
      results[index] = recordManualRequiredSkip(db, source);
      return false;
    });
  const httpSources = runnableSources.filter(({ source }) => source.collector_kind !== "browser");
  const browserSources = runnableSources.filter(({ source }) => source.collector_kind === "browser");

  // 同域名熔断：某域名一旦返回限流/封禁特征（429/52x/403），本轮跳过该域名其余店铺。
  // 否则同站几十家店会继续猛打一个已经在拒绝我们的域名，把封禁打得更深更久。
  const throttledHosts = new Set<string>();
  const hostOf = ({ source }: { source: SourceRow }) => normalizeHostname(source.entry_url || source.base_url || "");

  const httpResults = await runPoolByHost(
    httpSources,
    concurrency,
    hostConcurrencyLimit(),
    hostDelayMs(),
    hostOf,
    async (item) => {
      const host = hostOf(item);
      if (throttledHosts.has(host)) return recordHostThrottledSkip(db, item.source, host);
      const result = await collectSource(db, item.source, deps);
      if (result.status === "failed" && isHostThrottledError(result.message)) throttledHosts.add(host);
      return result;
    },
  );
  httpResults.forEach((result, index) => {
    results[httpSources[index]!.index] = result;
  });
  // 浏览器类低并发，避免开多个可见窗口 / 小内存服务器 OOM（SHOP_BROWSER_CONCURRENCY 可调，默认 2）
  const browserResults = await runPool(browserSources, Math.min(browserConcurrency(), concurrency), ({ source }) => collectSource(db, source, deps));
  browserResults.forEach((result, index) => {
    results[browserSources[index]!.index] = result;
  });

  const skippedSources = results.filter((r) => r.status === "skipped").map((r) => r.sourceId);
  const failedSources = results.filter((r) => r.status === "failed").map((r) => r.sourceId);
  const partialSources = results.filter((r) => r.status === "partial").map((r) => r.sourceId);
  const manualRequiredSources = sources.filter(isManualRequiredSkip).map((source) => source.id);
  const status = results.some((r) => r.status !== "success") ? "partial" : "success";
  return {
    status,
    total: results.length,
    results,
    skippedSources,
    failedSources,
    partialSources,
    manualRequiredSources,
  };
}
