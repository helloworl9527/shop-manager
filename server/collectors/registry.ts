import type { CollectorKind, CollectorOffer, CollectorTarget, DetectResult, ProbeAttempt } from "./types";
import type { HttpClient } from "../core/http";
import { isNetworkError, isWafError } from "../core/waf";
import { collectKami } from "./kami";
import { collectDujiao } from "./dujiao";
import { collectDujiaoHtmlFromHtml } from "./dujiaoHtml";
import { collectGenericHtmlFromHtml } from "./genericHtml";
import { collectShopApi } from "./shopApi";
import { collectPublicProductsApi } from "./publicProductsApi";
import { collectProductsListApi } from "./productsListApi";
import { normalizeHostname, shopTokenFromUrl } from "./util";
import collectorHostsConfig from "../config/collector-hosts.json";

interface CollectorHostEntry {
  kind: CollectorKind;
  label?: string;
  hosts: string[];
}

interface CollectorHostsConfig {
  kinds?: CollectorHostEntry[];
  upstream?: Partial<Record<CollectorKind, string[]>>;
  overrides?: Record<string, CollectorKind>;
}

/**
 * 域名 → 采集器类型 注册表（镜像 PriceAI config/collectors.json）。
 * sources 表通常会显式存 collector_kind；此表用于 collector_kind='auto' 时按域名嗅探。
 */
export const COLLECTOR_HOSTS: Partial<Record<CollectorKind, string[]>> = {};

function configEntries(config: CollectorHostsConfig): CollectorHostEntry[] {
  if (config.upstream) {
    return Object.entries(config.upstream).map(([kind, hosts]) => ({
      kind: kind as CollectorKind,
      hosts: hosts ?? [],
    }));
  }
  return config.kinds ?? [];
}

for (const entry of configEntries(collectorHostsConfig as CollectorHostsConfig)) {
  COLLECTOR_HOSTS[entry.kind] = entry.hosts;
}

const HOST_TO_KIND = new Map<string, CollectorKind>();
for (const [kind, hosts] of Object.entries(COLLECTOR_HOSTS)) {
  for (const host of hosts ?? []) HOST_TO_KIND.set(normalizeHostname(host), kind as CollectorKind);
}
const HOST_OVERRIDES = new Map<string, CollectorKind>();
for (const [host, kind] of Object.entries((collectorHostsConfig as CollectorHostsConfig).overrides ?? {})) {
  const normalized = normalizeHostname(host);
  HOST_OVERRIDES.set(normalized, kind);
  HOST_TO_KIND.set(normalized, kind);
}

const IMPLEMENTED_KINDS = new Set<CollectorKind>(["kami", "dujiao", "dujiaoHtml", "shopApi", "publicProductsApi", "productsListApi", "genericHtml", "browser"]);
const PROBE_STEP_TIMEOUT_MS = 10_000;
const PROBE_CONCURRENCY = 3;
let activeProbes = 0;
const probeQueue: Array<() => void> = [];

/** 按域名推断采集器类型；未知返回 null（调用方按 unsupported 处理）。 */
export function inferCollectorKind(hostOrUrl: string, text = ""): CollectorKind | null {
  const host = normalizeHostname(hostOrUrl);
  const hit = registryHit(hostOrUrl);
  if (hit) return hit.kind;
  if (text.toLowerCase().includes("burstpro")) return "dujiao";
  return null;
}

function registryHit(hostOrUrl: string): { kind: CollectorKind; source: "override" | "upstream" } | null {
  const host = normalizeHostname(hostOrUrl);
  const override = HOST_OVERRIDES.get(host);
  if (override) return { kind: override, source: "override" };
  const hit = HOST_TO_KIND.get(host);
  return hit ? { kind: hit, source: "upstream" } : null;
}

function looksLikeArrayData(j: any): boolean {
  return Array.isArray(j) || Array.isArray(j?.data) || Array.isArray(j?.data?.list);
}

async function withProbeLimit<T>(fn: () => Promise<T>): Promise<T> {
  if (activeProbes >= PROBE_CONCURRENCY) {
    await new Promise<void>((resolve) => probeQueue.push(resolve));
  }
  activeProbes += 1;
  try {
    return await fn();
  } finally {
    activeProbes -= 1;
    probeQueue.shift()?.();
  }
}

function runWithStepTimeout<T>(label: string, promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} 探测超时`)), PROBE_STEP_TIMEOUT_MS);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

async function withStepTimeout<T>(label: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await runWithStepTimeout(label, fn());
  } catch (err) {
    if (!/探测超时/.test(errMessage(err))) throw err;
    try {
      return await runWithStepTimeout(label, fn());
    } catch (retryErr) {
      throw new Error(`${errMessage(err)}；重试后${errMessage(retryErr)}`);
    }
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err ?? "");
}

function elapsedMs(started: number): number {
  return Math.max(0, Math.round(performance.now() - started));
}

async function attempt<T>(
  attempts: ProbeAttempt[],
  step: string,
  fn: () => Promise<T>,
  isMatch: (value: T) => boolean,
  hitMessage: string,
  missMessage = "未命中",
): Promise<{ value: T; matched: boolean }> {
  const started = performance.now();
  try {
    const value = await fn();
    const matched = isMatch(value);
    attempts.push({ step, ok: matched, ms: elapsedMs(started), message: matched ? hitMessage : missMessage });
    return { value, matched };
  } catch (err) {
    attempts.push({ step, ok: false, ms: elapsedMs(started), message: errMessage(err) });
    throw err;
  }
}

function browserEvidence(err: unknown): string | null {
  const message = errMessage(err);
  if (isWafError(err) || isNetworkError(err) || /HTTP 403|returned HTTP 403/i.test(message)) {
    return message;
  }
  return null;
}

function apiProbeHint(attempts: ProbeAttempt[]): string {
  const hints = attempts
    .filter((attempt) => /HTTP 403|returned HTTP 403|captcha|challenge|cloudflare|风控|验证/i.test(attempt.message ?? ""))
    .map((attempt) => `${attempt.step}: ${attempt.message}`);
  return hints.length ? `；接口探测线索：${hints.join("；")}` : "";
}

function htmlPriceAnchorCount(html: string): number {
  return (
    html.match(/[¥￥]\s*\d/g)?.length ?? 0
  ) + (
    html.match(/\d[\d,]*(?:\.\d{1,2})?\s*(?:CNY|RMB|元)/gi)?.length ?? 0
  );
}

function dujiaoHtmlEvidence(html: string): string | null {
  const buyLinks = html.match(/href=["'][^"']*\/buy\/\d+[^"']*["']/gi)?.length ?? 0;
  const hasLaravelLike = /csrf-token|laravel_session|livewire/i.test(html);
  if (buyLinks >= 3 && hasLaravelLike) return `HTML 指纹：/buy/N 链接 ${buyLinks} 个，包含 Laravel/Livewire 特征`;
  return null;
}

function knownKindResult(kind: CollectorKind, hostOrUrl: string, source: "override" | "upstream" = "upstream"): DetectResult {
  const sourceLabel = source === "override" ? "本地覆盖" : "域名注册表";
  if (IMPLEMENTED_KINDS.has(kind)) {
    const evidence = `${sourceLabel}命中：${normalizeHostname(hostOrUrl)} → ${kind}`;
    return { kind, evidence, attempts: [{ step: "hostRegistry", ok: true, ms: 0, message: evidence }] };
  }
  const evidence = `${sourceLabel}命中 ${kind}，但该采集器尚未实现`;
  return { kind: "pending", evidence, attempts: [{ step: "hostRegistry", ok: false, ms: 0, message: evidence }] };
}

async function collectKindTrial(target: CollectorTarget, kind: CollectorKind, http: HttpClient): Promise<CollectorOffer[]> {
  if (kind === "kami") return collectKami(target, http);
  if (kind === "dujiao") return collectDujiao(target, http);
  if (kind === "shopApi") return collectShopApi(target, http);
  if (kind === "publicProductsApi") return collectPublicProductsApi(target, http);
  if (kind === "productsListApi") return collectProductsListApi(target, http);
  if (kind === "dujiaoHtml") {
    const html = await http.fetchText(target.sourceUrl);
    return collectDujiaoHtmlFromHtml(target, html, http);
  }
  if (kind === "genericHtml") {
    const html = await http.fetchText(target.sourceUrl);
    return collectGenericHtmlFromHtml(target, html);
  }
  return [];
}

async function verifyRegistryHit(
  target: CollectorTarget,
  kind: CollectorKind,
  http: HttpClient,
  attempts: ProbeAttempt[],
  source: "override" | "upstream",
): Promise<{ offers: CollectorOffer[]; ms: number } | null> {
  const started = performance.now();
  const step = `hostRegistry:${kind}`;
  const sourceLabel = source === "override" ? "本地覆盖" : "注册表";
  try {
    const offers = await withStepTimeout(step, () => collectKindTrial(target, kind, http));
    const ms = elapsedMs(started);
    if (offers.length > 0) {
      attempts.push({ step, ok: true, ms, message: `${sourceLabel} ${kind} 已验证，试采 ${offers.length} 条` });
      return { offers, ms };
    }
    attempts.push({ step, ok: false, ms, message: `${sourceLabel} ${kind} 已失效（试采 0 条），继续探测` });
    return null;
  } catch (err) {
    const ms = elapsedMs(started);
    attempts.push({ step, ok: false, ms, message: `${sourceLabel} ${kind} 已失效：${errMessage(err)}，继续探测` });
    return null;
  }
}

/**
 * 未知域名时，按接口形态实地探测采集器类型——让 auto 对任意卡网/独角/链动小铺站点通用，
 * 不必再逐个把域名加进注册表（这是「换个域名就采不到」问题的根治）。
 */
async function detectCollectorInner(target: CollectorTarget, http: HttpClient): Promise<DetectResult> {
  const attempts: ProbeAttempt[] = [];
  const hostHit = registryHit(target.sourceUrl || target.baseUrl);
  let skipKind: CollectorKind | null = null;
  if (hostHit) {
    if (!IMPLEMENTED_KINDS.has(hostHit.kind) || hostHit.kind === "browser") {
      return knownKindResult(hostHit.kind, target.sourceUrl || target.baseUrl, hostHit.source);
    }
    const trial = await verifyRegistryHit(target, hostHit.kind, http, attempts, hostHit.source);
    if (trial) {
      const sourceLabel = hostHit.source === "override" ? "本地覆盖命中并验证" : "域名注册表命中并验证";
      const evidence = `${sourceLabel}：${normalizeHostname(target.sourceUrl || target.baseUrl)} → ${hostHit.kind}（试采 ${trial.offers.length} 条）`;
      return { kind: hostHit.kind, evidence, offers: trial.offers, attempts };
    }
    skipKind = hostHit.kind;
  }

  // URL 形态强信号：链动小铺 / ShopApi（/shop/<token> 或 /item/<key>）
  if (/\/(shop|item)\/[^/?#]+/.test(target.sourceUrl)) {
    const evidence = "URL 形态命中 /shop/<token> 或 /item/<key>";
    attempts.push({ step: "urlShape", ok: true, ms: 0, message: evidence });
    return { kind: "shopApi", evidence, attempts };
  }
  const base = target.baseUrl;
  // kami（卡网 / 异次元发卡）：/user/api/index/commodity
  if (skipKind !== "kami") try {
    const probe = await attempt(
      attempts,
      "kami",
      () => withStepTimeout("kami", () => http.fetchJson(`${base}/user/api/index/commodity?limit=1&page=1`)),
      looksLikeArrayData,
      "接口指纹命中 /user/api/index/commodity",
    );
    if (probe.matched) {
      return { kind: "kami", evidence: "接口指纹命中 /user/api/index/commodity", attempts };
    }
  } catch (err) {
    // 单个接口探测失败是非该类型站点的常见表现，不在这里短路为 browser。
  }
  // dujiao（独角数卡）：/api/v1/public/products
  if (skipKind !== "dujiao") try {
    const probe = await attempt(
      attempts,
      "dujiao",
      () => withStepTimeout("dujiao", () => http.fetchJson(`${base}/api/v1/public/products`)),
      looksLikeArrayData,
      "接口指纹命中 /api/v1/public/products",
    );
    if (probe.matched) {
      return { kind: "dujiao", evidence: "接口指纹命中 /api/v1/public/products", attempts };
    }
  } catch (err) {
    // 继续瀑布。
  }

  // productsListApi：/api/products → { data: { list: [...] } }
  if (skipKind !== "productsListApi") try {
    const probe = await attempt(
      attempts,
      "productsListApi",
      () => withStepTimeout("productsListApi", () => http.fetchJson(`${base}/api/products`)),
      (j: any) => Array.isArray(j?.data?.list) && j.data.list.length > 0 && j?.data?.list?.[0]?.base_price !== undefined,
      "接口指纹命中 /api/products（data.list + base_price）",
    );
    if (probe.matched) {
      return { kind: "productsListApi", evidence: "接口指纹命中 /api/products（data.list + base_price）", attempts };
    }
  } catch (err) {
    // 继续瀑布。
  }

  const token = shopTokenFromUrl(target.sourceUrl);
  if (token && skipKind !== "shopApi") {
    try {
      const probe = await attempt(
        attempts,
        "shopApi",
        () => withStepTimeout("shopApi", () => http.postJson(`${base}/shopApi/Shop/info`, { token, category_key: "" }, `${base}/shop/${token}`)),
        (info) => info?.code === 1 && Boolean(info?.data),
        "接口指纹命中 POST /shopApi/Shop/info",
      );
      if (probe.matched) {
        return { kind: "shopApi", evidence: "接口指纹命中 POST /shopApi/Shop/info", attempts };
      }
    } catch (err) {
      // 继续瀑布。
    }
  }

  let html = "";
  try {
    const probe = await attempt(
      attempts,
      "homepageHtml",
      () => withStepTimeout("homepage html", () => http.fetchText(target.sourceUrl)),
      (value) => String(value ?? "").length > 0,
      "首页 HTML 获取成功",
    );
    html = String(probe.value ?? "");
  } catch (err) {
    const evidence = browserEvidence(err);
    if (evidence) return { kind: "browser", evidence: `首页 HTML 探测需要浏览器兜底：${evidence}${apiProbeHint(attempts)}`, attempts };
    return { kind: "pending", evidence: `首页 HTML 探测失败：${errMessage(err)}`, attempts };
  }

  const dujiaoLike = dujiaoHtmlEvidence(html);
  const priceAnchors = htmlPriceAnchorCount(html);
  if (dujiaoLike && skipKind !== "dujiaoHtml") {
    const started = performance.now();
    const offers = await collectDujiaoHtmlFromHtml(target, html, http);
    if (offers.length > 0) {
      attempts.push({ step: "dujiaoHtmlTrial", ok: true, ms: elapsedMs(started), message: `试采 ${offers.length} 条` });
      return { kind: "dujiaoHtml", evidence: `${dujiaoLike}；dujiaoHtml 试采 ${offers.length} 条`, offers, attempts };
    }
    attempts.push({ step: "dujiaoHtmlTrial", ok: false, ms: elapsedMs(started), message: "未采到报价" });
    return { kind: "pending", evidence: `${dujiaoLike}；dujiaoHtml 未采到报价`, attempts };
  } else if (dujiaoLike) {
    attempts.push({ step: "dujiaoHtmlTrial", ok: false, ms: 0, message: "已跳过：注册表 dujiaoHtml 试采失败" });
  }
  if (priceAnchors >= 2 && skipKind !== "genericHtml") {
    const started = performance.now();
    const offers = collectGenericHtmlFromHtml(target, html);
    if (offers.length > 0) {
      attempts.push({ step: "genericHtmlTrial", ok: true, ms: elapsedMs(started), message: `试采 ${offers.length} 条` });
      return {
        kind: "genericHtml",
        evidence: `HTML 价格锚点 ${priceAnchors} 个；genericHtml 试采 ${offers.length} 条`,
        offers,
        attempts,
      };
    }
    attempts.push({ step: "genericHtmlTrial", ok: false, ms: elapsedMs(started), message: `HTML 价格锚点 ${priceAnchors} 个，但未采到报价` });
  } else if (priceAnchors >= 2) {
    attempts.push({ step: "genericHtmlTrial", ok: false, ms: 0, message: "已跳过：注册表 genericHtml 试采失败" });
  }

  const evidence = "未命中已实现 HTTP/HTML 采集器指纹，进入浏览器兜底";
  attempts.push({ step: "browserFallback", ok: true, ms: 0, message: evidence });
  return { kind: "browser", evidence, attempts };
}

export async function detectCollector(target: CollectorTarget, http: HttpClient): Promise<DetectResult> {
  return withProbeLimit(() => detectCollectorInner(target, http));
}

export async function probeCollectorKind(target: CollectorTarget, http: HttpClient): Promise<CollectorKind | null> {
  const result = await detectCollector(target, http);
  return result.kind === "pending" ? null : result.kind;
}
