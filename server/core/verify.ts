import { randomUUID } from "node:crypto";
import type { SqliteDatabase } from "../db/connection";
import {
  countActiveOffers,
  delistMissing,
  listManualRequiredSources,
  markSourceManualRequired,
  markSourceSuccess,
  nowIso,
  recordCrawlRun,
  targetFromSource,
  upsertOffers,
  type ManualRequiredSource,
  type SourceRow,
} from "../db/repo";
import { shouldDelistMissing } from "./freshness";
import {
  NAME_SHIM,
  acquireProfileLock,
  extractOffersInPage,
  extractShopApiViaPage,
  gotoWithRetry,
  isCloudflareChallengeSnapshot,
  launchInteractiveVerificationContext,
  mapShopApiItems,
  pageSnapshot,
  saveProfileUserAgent,
  type BrowserPageSnapshot,
} from "../collectors/browser";
import { normalizeKeyFromTitle } from "./ids";
import { shopTokenFromUrl } from "../collectors/util";
import type { CollectorOffer } from "../collectors/types";

export type VerifyTargetStatus = "waiting" | "passed" | "collected" | "failed" | "timeout";

export interface VerifyTargetState {
  sourceId: string;
  name: string;
  url: string;
  status: VerifyTargetStatus;
  offers?: number;
  message?: string;
  startedAt?: string;
  finishedAt?: string;
}

export interface VerifySessionState {
  status: "idle" | "running";
  startedAt?: string;
  finishedAt?: string;
  targets: VerifyTargetState[];
  message?: string;
}

export interface VerifyDeps {
  launchContext?: (opts: { headless: boolean }) => Promise<any>;
  acquireLock?: () => Promise<() => void>;
  tabLimit?: number;
  pollMs?: number;
  tabTimeoutMs?: number;
  sessionTimeoutMs?: number;
}

export class VerifySessionAlreadyRunningError extends Error {
  constructor() {
    super("已有人工验证会话正在运行");
    this.name = "VerifySessionAlreadyRunningError";
  }
}

let state: VerifySessionState = { status: "idle", targets: [] };
let activeContext: any = null;
let cancelRequested = false;

function cloneState(): VerifySessionState {
  return JSON.parse(JSON.stringify(state)) as VerifySessionState;
}

function asSourceRow(source: ManualRequiredSource): SourceRow {
  return {
    id: source.id,
    name: source.name,
    name_source: "auto",
    base_url: source.base_url,
    entry_url: source.entry_url,
    collection_method: source.collection_method,
    collector_kind: source.collector_kind,
    kind_detected_at: null,
    kind_evidence: null,
    notes: null,
    enabled: 1,
    favorite: 0,
    favorited_at: null,
    consecutive_failures: 0,
    health_status: "manual_required",
  };
}

function terminal(status: VerifyTargetStatus): boolean {
  return status === "collected" || status === "failed" || status === "timeout";
}

function updateTarget(sourceId: string, patch: Partial<VerifyTargetState>): void {
  state = {
    ...state,
    targets: state.targets.map((target) => target.sourceId === sourceId ? { ...target, ...patch } : target),
  };
}

function finishSession(message?: string): void {
  state = { ...state, status: "idle", finishedAt: nowIso(), message };
}

function mapDomOffers(raw: Array<{ sourceTitle: string; price: number | null; status: string; url: string; tags: string[]; stockCount: number | null }>, source: ManualRequiredSource): CollectorOffer[] {
  return raw.map((offer) => ({
    ...offer,
    externalKey: `br:${normalizeKeyFromTitle(offer.sourceTitle)}`,
    sourceStoreName: source.name,
  }));
}

function isClosedTargetError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err ?? "");
  return /Target page, context or browser has been closed|Target closed|browser has been closed|context has been closed|page has been closed/i.test(message);
}

function verifyErrorMessage(err: unknown): string {
  return isClosedTargetError(err) ? "验证窗口已关闭" : err instanceof Error ? err.message : String(err);
}

async function evaluateWithNavigationRetry<T>(page: any, fn: () => T, attempts = 3): Promise<T> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return (await page.evaluate(fn)) as T;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!/Execution context was destroyed|Cannot find context|navigation/i.test(message) || attempt === attempts - 1) throw err;
      await page.waitForTimeout(500);
    }
  }
  throw new Error("页面执行失败");
}

function writeVerifiedOffers(db: SqliteDatabase, source: ManualRequiredSource, offers: CollectorOffer[], startedAt: string): { status: "success" | "partial"; written: number; seenCount: number; delisted: number; message: string | null } {
  const target = targetFromSource(asSourceRow(source));
  const previousActive = countActiveOffers(db, source.id);
  const outcome = { written: 0, seenCount: 0, delisted: 0, message: null as string | null };

  const tx = db.transaction(() => {
    const r = upsertOffers(db, target, "browser", offers);
    outcome.written = r.written;
    outcome.seenCount = r.seenIds.length;
    if (shouldDelistMissing({ status: "success", fullSnapshot: true, seenCount: outcome.seenCount, previousActiveCount: previousActive })) {
      outcome.delisted = delistMissing(db, source.id, r.seenIds, nowIso());
    } else if (previousActive > 0 && outcome.seenCount < Math.max(1, Math.floor(previousActive * 0.5))) {
      outcome.message = "人工验证返回异常偏少，未做下架";
    }
  });
  tx();

  const finishedAt = nowIso();
  const status = outcome.message ? "partial" : "success";
  recordCrawlRun(db, {
    id: randomUUID(),
    sourceId: source.id,
    sourceName: source.name,
    mode: "browser-verify",
    status,
    startedAt,
    finishedAt,
    successCount: outcome.written,
    failureCount: 0,
    message: outcome.message,
    details: { manualVerify: true, received: offers.length, seenCount: outcome.seenCount, delisted: outcome.delisted, previousActive },
  });
  markSourceSuccess(db, source.id, status, finishedAt);
  return { status, ...outcome };
}

function recordVerifyTimeout(db: SqliteDatabase, source: ManualRequiredSource, startedAt: string, message: string): void {
  const finishedAt = nowIso();
  markSourceManualRequired(db, source.id, message, finishedAt);
  recordCrawlRun(db, {
    id: randomUUID(),
    sourceId: source.id,
    sourceName: source.name,
    mode: "browser-verify",
    status: "timeout",
    startedAt,
    finishedAt,
    successCount: 0,
    failureCount: 0,
    message,
    details: { manualVerify: true },
  });
  updateTarget(source.id, { status: "timeout", message, finishedAt });
}

function recordVerifyFailure(db: SqliteDatabase, source: ManualRequiredSource, startedAt: string, message: string): void {
  const finishedAt = nowIso();
  markSourceManualRequired(db, source.id, message, finishedAt);
  recordCrawlRun(db, {
    id: randomUUID(),
    sourceId: source.id,
    sourceName: source.name,
    mode: "browser-verify",
    status: "failed",
    startedAt,
    finishedAt,
    successCount: 0,
    failureCount: 0,
    message,
    details: { manualVerify: true },
  });
  updateTarget(source.id, { status: "failed", message, finishedAt });
}

async function collectFromVerifiedPage(page: any, source: ManualRequiredSource): Promise<CollectorOffer[]> {
  const target = targetFromSource(asSourceRow(source));
  const token = shopTokenFromUrl(source.entry_url);
  if (token) {
    const result = await extractShopApiViaPage(page, target.baseUrl, token);
    if (result.ok && result.items.length) return mapShopApiItems(result, target);
    return [];
  }
  const raw = await evaluateWithNavigationRetry<Array<{ sourceTitle: string; price: number | null; status: string; url: string; tags: string[]; stockCount: number | null }>>(page, extractOffersInPage);
  return mapDomOffers(raw, source);
}

async function processTarget(db: SqliteDatabase, context: any, source: ManualRequiredSource, deps: Required<Pick<VerifyDeps, "pollMs" | "tabTimeoutMs">>): Promise<void> {
  const startedAt = nowIso();
  const started = Date.now();
  updateTarget(source.id, { status: "waiting", startedAt, message: "等待人工验证" });
  let page: any = null;
  try {
    page = await context.newPage();
    await page.addInitScript(NAME_SHIM);
    const userAgent = await page.evaluate(() => navigator.userAgent).catch(() => "");
    if (typeof userAgent === "string") saveProfileUserAgent(userAgent);
    await gotoWithRetry(page, source.entry_url);

    let latestSnapshot: BrowserPageSnapshot | null = null;
    while (!cancelRequested) {
      if (Date.now() - started >= deps.tabTimeoutMs) {
        const message = latestSnapshot && !isCloudflareChallengeSnapshot(latestSnapshot)
          ? "人工验证超时，挑战已通过但未提取到商品"
          : "人工验证超时，仍停留在挑战页";
        recordVerifyTimeout(db, source, startedAt, message);
        return;
      }

      const snapshot = await pageSnapshot(page);
      latestSnapshot = snapshot;
      if (isCloudflareChallengeSnapshot(snapshot)) {
        updateTarget(source.id, { status: "waiting", message: "等待人工验证" });
      } else {
        updateTarget(source.id, { status: "passed", message: "挑战已通过，等待商品内容" });
        let offers: CollectorOffer[] = [];
        try {
          offers = await collectFromVerifiedPage(page, source);
        } catch (err) {
          if (isClosedTargetError(err)) throw err;
          offers = [];
        }
        if (offers.length) {
          const result = writeVerifiedOffers(db, source, offers, startedAt);
          updateTarget(source.id, {
            status: "collected",
            offers: offers.length,
            message: result.message ?? `已采到 ${offers.length} 条`,
            finishedAt: nowIso(),
          });
          return;
        }
      }
      await page.waitForTimeout(deps.pollMs);
    }
    if (/超时/.test(state.message ?? "")) {
      recordVerifyTimeout(db, source, startedAt, state.message || "人工验证会话超时");
    } else {
      updateTarget(source.id, { status: "failed", message: state.message || "验证已取消", finishedAt: nowIso() });
    }
  } catch (err) {
    recordVerifyFailure(db, source, startedAt, verifyErrorMessage(err));
  } finally {
    if (page) await page.close().catch(() => {});
  }
}

async function runPool(sources: ManualRequiredSource[], limit: number, fn: (source: ManualRequiredSource) => Promise<void>): Promise<void> {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, sources.length) }, async () => {
    while (!cancelRequested && cursor < sources.length) {
      const current = sources[cursor++];
      if (current) await fn(current);
    }
  });
  await Promise.all(workers);
}

async function runVerifySession(db: SqliteDatabase, sources: ManualRequiredSource[], deps: VerifyDeps): Promise<void> {
  const tabLimit = deps.tabLimit ?? 12;
  const pollMs = deps.pollMs ?? 2000;
  const tabTimeoutMs = deps.tabTimeoutMs ?? 5 * 60 * 1000;
  const sessionTimeoutMs = deps.sessionTimeoutMs ?? 10 * 60 * 1000;
  const release = await (deps.acquireLock ?? acquireProfileLock)();
  let sessionTimer: ReturnType<typeof setTimeout> | null = null;
  try {
    sessionTimer = setTimeout(() => {
      cancelRequested = true;
      state = { ...state, message: "人工验证会话超时" };
    }, sessionTimeoutMs);
    activeContext = await (deps.launchContext ?? launchInteractiveVerificationContext)({ headless: false });
    activeContext.on?.("close", () => {
      cancelRequested = true;
      if (!state.message) state = { ...state, message: "验证窗口已关闭" };
    });
    await runPool(sources, tabLimit, (source) => processTarget(db, activeContext, source, { pollMs, tabTimeoutMs }));

    if (cancelRequested) {
      for (const target of state.targets) {
        if (!terminal(target.status)) updateTarget(target.sourceId, { status: /超时/.test(state.message ?? "") ? "timeout" : "failed", message: state.message || "验证窗口已关闭", finishedAt: nowIso() });
      }
    }
    finishSession(state.message);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    for (const target of state.targets) {
      if (!terminal(target.status)) updateTarget(target.sourceId, { status: "failed", message, finishedAt: nowIso() });
    }
    finishSession(message);
  } finally {
    if (sessionTimer) clearTimeout(sessionTimer);
    if (activeContext) await activeContext.close().catch(() => {});
    activeContext = null;
    release();
  }
}

export function getVerifySessionState(): VerifySessionState {
  return cloneState();
}

export function listPendingVerifySources(db: SqliteDatabase): ManualRequiredSource[] {
  return listManualRequiredSources(db);
}

export function startVerifySession(db: SqliteDatabase, opts: { sourceIds?: string[]; deps?: VerifyDeps } = {}): VerifySessionState {
  if (state.status === "running") throw new VerifySessionAlreadyRunningError();
  const sources = listManualRequiredSources(db, opts.sourceIds);
  state = {
    status: "running",
    startedAt: nowIso(),
    targets: sources.map((source) => ({ sourceId: source.id, name: source.name, url: source.entry_url, status: "waiting", message: "排队等待验证" })),
  };
  cancelRequested = false;
  if (!sources.length) {
    finishSession("没有待验证站点");
    return cloneState();
  }
  void runVerifySession(db, sources, opts.deps ?? {});
  return cloneState();
}

export async function cancelVerifySession(): Promise<VerifySessionState> {
  if (state.status !== "running") return cloneState();
  state = { ...state, message: "已取消" };
  cancelRequested = true;
  return cloneState();
}

export function resetVerifySessionForTests(): void {
  state = { status: "idle", targets: [] };
  activeContext = null;
  cancelRequested = false;
}
