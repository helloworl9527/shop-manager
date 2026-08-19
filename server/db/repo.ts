import type { SqliteDatabase } from "./connection";
import { syncFavoriteStoreForSource } from "./favoriteStores";
import type { CollectorOffer, CollectorTarget } from "../collectors/types";
import { classifyOffer } from "../catalog/catalog";
import { computeFreshnessFields, type CollectionMethod } from "../core/freshness";
import { buildOfferId, resolveExternalKey, urlCanonical } from "../core/ids";
import { normalizeHostname } from "../collectors/util";

export const nowIso = (): string => new Date().toISOString();

export interface SourceRow {
  id: string;
  name: string;
  name_source: string | null;
  base_url: string | null;
  entry_url: string;
  collection_method: string;
  collector_kind: string | null;
  kind_detected_at: string | null;
  kind_evidence: string | null;
  notes: string | null;
  enabled: number;
  favorite: number;
  favorited_at: string | null;
  consecutive_failures: number;
  health_status: string;
}

export function targetFromSource(s: SourceRow): CollectorTarget {
  let baseUrl = s.base_url || "";
  if (!baseUrl) {
    try {
      const u = new URL(s.entry_url);
      baseUrl = `${u.protocol}//${u.host}`;
    } catch {
      baseUrl = s.entry_url;
    }
  }
  const knownItemUrls = /\/item\/[^/?#]+/.test(s.entry_url) ? [s.entry_url] : undefined;
  return { sourceId: s.id, sourceName: s.name, sourceUrl: s.entry_url, baseUrl, knownItemUrls };
}

/** 纯函数：把采集结果构造成 raw_offers 行（含分类、id、测活字段）。便于单测。 */
export function buildOfferRow(input: {
  sourceId: string;
  sourceName: string;
  sourceStoreName?: string | null;
  method: CollectionMethod;
  offer: CollectorOffer;
  at: string;
}) {
  const { offer } = input;
  const externalKey = resolveExternalKey({ externalKey: offer.externalKey, url: offer.url, title: offer.sourceTitle });
  const id = buildOfferId(input.sourceId, externalKey);
  const canonical = classifyOffer(offer.sourceTitle, { tags: offer.tags });
  const fresh = computeFreshnessFields({
    method: input.method,
    status: offer.status,
    price: offer.price ?? null,
    url: offer.url,
    verifiedAt: input.at,
    hidden: false,
  });

  return {
    id,
    source_id: input.sourceId,
    source_name: input.sourceName,
    source_store_name: offer.sourceStoreName ?? input.sourceStoreName ?? null,
    source_title: offer.sourceTitle,
    source_offer_key: offer.externalKey ?? null,
    url: offer.url,
    url_canonical: urlCanonical(offer.url),
    price: offer.price ?? null,
    currency: offer.currency ?? "CNY",
    status: offer.status,
    source_status: fresh.source_status,
    effective_status: fresh.effective_status,
    freshness_status: fresh.freshness_status,
    availability_rank: fresh.availability_rank,
    tags: JSON.stringify(offer.tags ?? []),
    stock_count: offer.stockCount ?? null,
    stock_text: offer.stockText ?? null,
    canonical_product_id: canonical.id,
    category_slug: canonical.platform,
    verified_at: fresh.verified_at,
    expires_at: fresh.expires_at,
    source_priority: fresh.source_priority,
    confidence: fresh.confidence,
    at: input.at,
  };
}

const UPSERT_SQL = `
INSERT INTO raw_offers
 (id, source_id, source_name, source_store_name, source_title, source_offer_key, url, url_canonical,
  price, currency, status, source_status, effective_status, freshness_status, availability_rank,
  tags, stock_count, stock_text, hidden, canonical_product_id, category_slug,
  captured_at, source_updated_at, last_seen_at, verified_at, expires_at, source_priority, confidence,
  created_at, updated_at)
VALUES
 (@id, @source_id, @source_name, @source_store_name, @source_title, @source_offer_key, @url, @url_canonical,
  @price, @currency, @status, @source_status, @effective_status, @freshness_status, @availability_rank,
  @tags, @stock_count, @stock_text, 0, @canonical_product_id, @category_slug,
  @at, @at, @at, @verified_at, @expires_at, @source_priority, @confidence,
  @at, @at)
ON CONFLICT(id) DO UPDATE SET
  source_name=excluded.source_name, source_store_name=excluded.source_store_name,
  source_title=excluded.source_title, source_offer_key=excluded.source_offer_key,
  url=excluded.url, url_canonical=excluded.url_canonical,
  price=excluded.price, currency=excluded.currency,
  status=excluded.status, source_status=excluded.source_status,
  effective_status=excluded.effective_status, freshness_status=excluded.freshness_status,
  availability_rank=excluded.availability_rank,
  tags=excluded.tags, stock_count=excluded.stock_count, stock_text=excluded.stock_text, hidden=0,
  canonical_product_id=excluded.canonical_product_id, category_slug=excluded.category_slug,
  last_seen_at=excluded.last_seen_at, verified_at=excluded.verified_at, expires_at=excluded.expires_at,
  source_priority=excluded.source_priority, confidence=excluded.confidence,
  failure_reason=NULL, last_failed_at=NULL, updated_at=excluded.updated_at`;

export interface UpsertResult {
  seenIds: string[];
  written: number;
  received: number;
  /** 因标价 <= 0 被丢弃的条目数（教程/引流占位商品、DOM 误抓的分类与说明文字）。 */
  skippedZeroPrice: number;
}

/** 写入一批采集结果（调用方负责放进事务）。返回本次出现的 offer id 集合。 */
export function upsertOffers(
  db: SqliteDatabase,
  target: CollectorTarget,
  method: CollectionMethod,
  offers: CollectorOffer[],
): UpsertResult {
  const stmt = db.prepare(UPSERT_SQL);
  const at = nowIso();
  const seen = new Set<string>();
  let written = 0;
  let skipped = 0;
  for (const offer of offers) {
    // 标价 0（或负数）的条目对比价没有意义，且会霸占「按价格升序」的榜首把真实最低价挤掉。
    // 它们通常是：店铺的教程/引流占位商品，或 DOM 兜底采集把分类导航、页面说明当成了商品。
    // 不计入 seenIds → 库里的存量 0 元脏数据会被后续差集下架自然清理。
    if (offer.price !== null && offer.price !== undefined && offer.price <= 0) {
      skipped += 1;
      continue;
    }
    const row = buildOfferRow({
      sourceId: target.sourceId,
      sourceName: target.sourceName,
      sourceStoreName: target.sourceStoreName ?? null,
      method,
      offer,
      at,
    });
    if (seen.has(row.id)) continue; // 同一批内去重
    seen.add(row.id);
    const info = stmt.run(row);
    written += info.changes;
  }
  return { seenIds: [...seen], written, received: offers.length, skippedZeroPrice: skipped };
}

export function countActiveOffers(db: SqliteDatabase, sourceId: string): number {
  const r = db.prepare("SELECT COUNT(*) AS n FROM raw_offers WHERE source_id=? AND hidden=0").get(sourceId) as { n: number };
  return r.n;
}

/**
 * 差集下架：把本源下、本次未出现的非隐藏 offer 标为下架（只隐藏不删除）。返回受影响条数。
 * 不自管事务——调用方（orchestrator）已把 upsert + 下架包在同一个事务里，避免嵌套事务。
 */
/**
 * 该源当前在售报价的 id 集合。
 * 必须在 upsertOffers **之前**取快照——写入之后新旧 id 混在一起，就无法再判断
 * 「本次结果是否与库存记录属于同一套 id 体系」了（见 collectSource 里的 idSchemeChanged）。
 */
export function activeOfferIds(db: SqliteDatabase, sourceId: string): Set<string> {
  const rows = db.prepare("SELECT id FROM raw_offers WHERE source_id=? AND hidden=0").all(sourceId) as { id: string }[];
  return new Set(rows.map((r) => r.id));
}

export function delistMissing(db: SqliteDatabase, sourceId: string, seenIds: string[], at: string): number {
  const seen = new Set(seenIds);
  const rows = db.prepare("SELECT id FROM raw_offers WHERE source_id=? AND hidden=0").all(sourceId) as { id: string }[];
  const missing = rows.map((r) => r.id).filter((id) => !seen.has(id));
  if (!missing.length) return 0;
  const stmt = db.prepare(
    `UPDATE raw_offers SET hidden=1, status='out_of_stock', source_status='out_of_stock',
       effective_status='unavailable', availability_rank=3, verified_at=@at, last_failed_at=NULL,
       failure_reason='完整采集未再返回，疑似下架；再次返回自动恢复', updated_at=@at
     WHERE id=@id`,
  );
  for (const id of missing) stmt.run({ id, at });
  return missing.length;
}

// ---------------- 源级锁 ----------------

export function acquireSourceLock(db: SqliteDatabase, sourceId: string, owner: string, ttlMs: number, at: string): boolean {
  const until = new Date(new Date(at).getTime() + ttlMs).toISOString();
  const info = db
    .prepare(
      `UPDATE sources SET collector_lock_owner=@owner, collector_lock_until=@until, collector_lock_started_at=@at, updated_at=@at
       WHERE id=@id AND (collector_lock_until IS NULL OR collector_lock_until < @at)`,
    )
    .run({ id: sourceId, owner, until, at });
  return info.changes > 0;
}

export function renewSourceLock(db: SqliteDatabase, sourceId: string, owner: string, ttlMs: number): void {
  const at = nowIso();
  const until = new Date(new Date(at).getTime() + ttlMs).toISOString();
  db.prepare(
    `UPDATE sources SET collector_lock_until=@until, updated_at=@at WHERE id=@id AND collector_lock_owner=@owner`,
  ).run({ id: sourceId, owner, until, at });
}

export function releaseSourceLock(db: SqliteDatabase, sourceId: string, owner: string): void {
  db.prepare(
    `UPDATE sources SET collector_lock_owner=NULL, collector_lock_until=NULL, collector_lock_started_at=NULL, updated_at=@at
     WHERE id=@id AND collector_lock_owner=@owner`,
  ).run({ id: sourceId, owner, at: nowIso() });
}

export function clearStaleLocks(db: SqliteDatabase): number {
  const info = db
    .prepare(
      `UPDATE sources SET collector_lock_owner=NULL, collector_lock_until=NULL, collector_lock_started_at=NULL
       WHERE collector_lock_until IS NOT NULL AND collector_lock_until < @at`,
    )
    .run({ at: nowIso() });
  return info.changes;
}

// ---------------- 采集日志 / 健康 ----------------

export function recordCrawlRun(db: SqliteDatabase, run: {
  id: string; sourceId: string | null; sourceName: string | null; mode: string; status: string;
  startedAt: string; finishedAt: string; successCount: number; failureCount: number; message?: string | null;
  details?: Record<string, unknown>;
}): void {
  db.prepare(
    `INSERT INTO crawl_runs (id, source_id, source_name, mode, status, started_at, finished_at, success_count, failure_count, message, details)
     VALUES (@id, @sourceId, @sourceName, @mode, @status, @startedAt, @finishedAt, @successCount, @failureCount, @message, @details)`,
  ).run({
    id: run.id, sourceId: run.sourceId, sourceName: run.sourceName, mode: run.mode, status: run.status,
    startedAt: run.startedAt, finishedAt: run.finishedAt, successCount: run.successCount, failureCount: run.failureCount,
    message: run.message ?? null, details: JSON.stringify(run.details ?? {}),
  });
}

export function markSourceSuccess(db: SqliteDatabase, sourceId: string, status: string, at: string): void {
  const health = status === "partial" ? "partial" : "healthy";
  if (status === "partial") {
    db.prepare(
      `UPDATE sources SET health_status=@health, last_checked_at=@at, last_success_at=@at,
         updated_at=@at WHERE id=@id`,
    ).run({ id: sourceId, health, at });
  } else {
    db.prepare(
      `UPDATE sources SET health_status=@health, last_checked_at=@at, last_success_at=@at,
         consecutive_failures=0, last_error=NULL, updated_at=@at WHERE id=@id`,
    ).run({ id: sourceId, health, at });
  }
}

/** 最近若干轮采集的 message，最新在前。用于判断「连续多少轮采到 0 条」。 */
export function recentRunMessages(db: SqliteDatabase, sourceId: string, limit: number): (string | null)[] {
  return db
    .prepare("SELECT message FROM crawl_runs WHERE source_id=? ORDER BY started_at DESC, rowid DESC LIMIT ?")
    .all(sourceId, limit)
    .map((row: any) => (row?.message ?? null) as string | null);
}

/** 记录失败：累加 consecutive_failures，只影响来源健康；旧报价保留当前可见性。 */
export function markSourceFailure(db: SqliteDatabase, sourceId: string, message: string, at: string): number {
  const prev = (db.prepare("SELECT consecutive_failures AS n FROM sources WHERE id=?").get(sourceId) as { n: number } | undefined)?.n ?? 0;
  const consecutive = prev + 1;
  const health = consecutive >= 3 ? "failing" : "retrying";
  db.prepare(
    `UPDATE sources SET health_status=@health, last_checked_at=@at, last_error=@msg,
       consecutive_failures=@n, updated_at=@at WHERE id=@id`,
  ).run({ id: sourceId, health, at, msg: message, n: consecutive });

  db.prepare(`UPDATE raw_offers SET last_failed_at=@at, failure_reason=@msg, updated_at=@at WHERE source_id=@id`)
    .run({ id: sourceId, at, msg: message });
  return consecutive;
}

/** 标记等待人工验证：不增加连败、不污染旧报价、不触发失效降级。 */
export function markSourceManualRequired(db: SqliteDatabase, sourceId: string, message: string, at: string): void {
  db.prepare(
    `UPDATE sources SET health_status='manual_required', last_checked_at=@at, last_error=@msg,
       updated_at=@at WHERE id=@id`,
  ).run({ id: sourceId, at, msg: message });
}

// ---------------- 来源读写 ----------------

export function listEnabledSources(db: SqliteDatabase): SourceRow[] {
  return db
    .prepare("SELECT id, name, name_source, base_url, entry_url, collection_method, collector_kind, kind_detected_at, kind_evidence, notes, enabled, favorite, favorited_at, consecutive_failures, health_status FROM sources WHERE enabled=1")
    .all() as SourceRow[];
}

export function listSourcesNeedingKindMigration(db: SqliteDatabase): SourceRow[] {
  return db
    .prepare(
      `SELECT id, name, name_source, base_url, entry_url, collection_method, collector_kind, kind_detected_at, kind_evidence, notes, enabled, consecutive_failures
              , favorite, favorited_at, health_status
       FROM sources
       WHERE collector_kind IS NULL OR collector_kind='' OR collector_kind='auto'`,
    )
    .all() as SourceRow[];
}

/** 按规范化后的入口 URL 查重（用于添加店铺时防止重复链接）。 */
export function findSourceByEntryUrl(db: SqliteDatabase, entryUrl: string): SourceRow | undefined {
  const target = urlCanonical(entryUrl);
  if (!target) return undefined;
  const rows = db
    .prepare("SELECT id, name, name_source, base_url, entry_url, collection_method, collector_kind, kind_detected_at, kind_evidence, notes, enabled, favorite, favorited_at, consecutive_failures, health_status FROM sources")
    .all() as SourceRow[];
  return rows.find((s) => urlCanonical(s.entry_url) === target);
}

/**
 * 「整站型」采集器：入口填站内哪一页都会采到同一批全站商品
 * （独角/卡网都是调一个全站接口）。因此同一域名只应存在一个源，
 * 否则首页和分类页会各建一个源、采到完全相同的商品，前台就会重复显示。
 *
 * 反例：shopApi（链动小铺）同域名下 `/shop/<token>` 各是独立店铺，
 * browser 也可能针对站内不同页面，这两类允许同域名多源。
 */
const SITE_WIDE_KINDS = new Set(["kami", "dujiao", "dujiaoHtml", "publicProductsApi"]);

export function isSiteWideKind(kind: string | null | undefined): boolean {
  return SITE_WIDE_KINDS.has(String(kind ?? ""));
}

/** 找出同域名下已存在的整站型源；kind 非整站型时永远返回 undefined。 */
export function findSiteWideDuplicate(db: SqliteDatabase, entryUrl: string, kind: string | null | undefined): SourceRow | undefined {
  if (!isSiteWideKind(kind)) return undefined;
  const host = normalizeHostname(entryUrl);
  if (!host) return undefined;
  return listAllSources(db).find((s) => isSiteWideKind(s.collector_kind) && normalizeHostname(s.entry_url) === host);
}

export function listAllSources(db: SqliteDatabase): SourceRow[] {
  return db
    .prepare("SELECT id, name, name_source, base_url, entry_url, collection_method, collector_kind, kind_detected_at, kind_evidence, notes, enabled, favorite, favorited_at, consecutive_failures, health_status FROM sources")
    .all() as SourceRow[];
}

export function getSource(db: SqliteDatabase, id: string): SourceRow | undefined {
  return db
    .prepare("SELECT id, name, name_source, base_url, entry_url, collection_method, collector_kind, kind_detected_at, kind_evidence, notes, enabled, favorite, favorited_at, consecutive_failures, health_status FROM sources WHERE id=?")
    .get(id) as SourceRow | undefined;
}

export interface ManualRequiredSource {
  id: string;
  name: string;
  entry_url: string;
  base_url: string | null;
  collector_kind: string | null;
  collection_method: string;
  last_error: string | null;
  last_checked_at: string | null;
}

export function listManualRequiredSources(db: SqliteDatabase, sourceIds?: string[]): ManualRequiredSource[] {
  const params: Record<string, unknown> = {};
  const where = ["enabled=1", "health_status='manual_required'"];
  if (sourceIds?.length) {
    const ids = sourceIds.map((id, index) => {
      const key = `id${index}`;
      params[key] = id;
      return `@${key}`;
    });
    where.push(`id IN (${ids.join(",")})`);
  }
  return db
    .prepare(
      `SELECT id, name, entry_url, base_url, collector_kind, collection_method, last_error, last_checked_at
       FROM sources WHERE ${where.join(" AND ")} ORDER BY last_checked_at ASC, created_at ASC`,
    )
    .all(params) as ManualRequiredSource[];
}

const SOURCE_PATCH_COLUMNS: Record<string, string> = {
  name: "name", nameSource: "name_source", entryUrl: "entry_url", baseUrl: "base_url",
  collectorKind: "collector_kind", collectionMethod: "collection_method", notes: "notes",
  kindDetectedAt: "kind_detected_at", kindEvidence: "kind_evidence",
};

/** 局部更新店铺字段。返回是否命中。 */
export function updateSource(
  db: SqliteDatabase,
  id: string,
  patch: Partial<{ name: string; nameSource: string | null; entryUrl: string; baseUrl: string | null; collectorKind: string | null; collectionMethod: string; enabled: boolean; notes: string | null; kindDetectedAt: string | null; kindEvidence: string | null }>,
): boolean {
  const sets: string[] = [];
  const params: Record<string, unknown> = { id, at: nowIso() };
  for (const [key, col] of Object.entries(SOURCE_PATCH_COLUMNS)) {
    if (key in patch) {
      sets.push(`${col}=@${key}`);
      params[key] = (patch as any)[key];
    }
  }
  if ("enabled" in patch) {
    sets.push("enabled=@enabled");
    params.enabled = patch.enabled ? 1 : 0;
  }
  if (!sets.length) return false;
  sets.push("updated_at=@at");
  const info = db.prepare(`UPDATE sources SET ${sets.join(", ")} WHERE id=@id`).run(params);
  return info.changes > 0;
}

export function setSourceFavorite(db: SqliteDatabase, id: string, favorite: boolean): SourceRow | undefined {
  const current = getSource(db, id);
  if (!current) return undefined;
  const at = nowIso();
  const favoritedAt = favorite ? current.favorited_at ?? at : null;
  db.prepare(
    `UPDATE sources
     SET favorite=@favorite, favorited_at=@favoritedAt, updated_at=@at
     WHERE id=@id`,
  ).run({ id, favorite: favorite ? 1 : 0, favoritedAt, at });
  // 收藏页统一读 favorite_stores，这里不同步的话 ★ 点了不出现、取消了不消失。
  syncFavoriteStoreForSource(db, current, favorite);
  return getSource(db, id);
}

export function resetSourceForReidentify(db: SqliteDatabase, id: string): boolean {
  const at = nowIso();
  const info = db
    .prepare(
      `UPDATE sources
       SET collector_kind='auto', collection_method='http', kind_detected_at=NULL, kind_evidence=NULL,
           health_status=CASE WHEN health_status='manual_required' THEN 'unknown' ELSE health_status END,
           last_error=CASE WHEN health_status='manual_required' THEN NULL ELSE last_error END,
           updated_at=@at
       WHERE id=@id`,
    )
    .run({ id, at });
  return info.changes > 0;
}

export interface SourceKindUpdate {
  kind: string | null;
  evidence: string;
  at?: string;
  method?: string;
}

export function persistSourceKind(db: SqliteDatabase, id: string, update: SourceKindUpdate): boolean {
  const evidence = String(update.evidence ?? "").trim();
  if (!evidence) throw new Error("persistSourceKind 需要 kind_evidence");
  return updateSource(db, id, {
    collectorKind: update.kind,
    kindEvidence: evidence,
    kindDetectedAt: update.at ?? nowIso(),
    ...(update.method ? { collectionMethod: update.method } : {}),
  });
}

/** 删除店铺；deleteOffers=true 时连同其报价一并删除（否则报价 source_id 置空保留）。 */
export function deleteSource(db: SqliteDatabase, id: string, deleteOffers = false): { deletedOffers: number; deleted: boolean } {
  let deletedOffers = 0;
  const tx = db.transaction(() => {
    if (deleteOffers) {
      deletedOffers = db.prepare("DELETE FROM raw_offers WHERE source_id=?").run(id).changes;
    }
    const info = db.prepare("DELETE FROM sources WHERE id=?").run(id);
    return info.changes > 0;
  });
  const deleted = tx() as boolean;
  return { deletedOffers, deleted };
}

export function upsertSource(db: SqliteDatabase, s: {
  id: string; name: string; entryUrl: string; baseUrl?: string | null; collectorKind?: string | null; collectionMethod?: string; enabled?: boolean;
  nameSource?: string | null; notes?: string | null; kindDetectedAt?: string | null; kindEvidence?: string | null;
}): void {
  const at = nowIso();
  db.prepare(
    `INSERT INTO sources (id, name, name_source, base_url, entry_url, collection_method, collector_kind, kind_detected_at, kind_evidence, enabled, notes, created_at, updated_at)
     VALUES (@id, @name, @nameSource, @baseUrl, @entryUrl, @method, @kind, @kindDetectedAt, @kindEvidence, @enabled, @notes, @at, @at)
     ON CONFLICT(id) DO UPDATE SET name=excluded.name, name_source=excluded.name_source, base_url=excluded.base_url, entry_url=excluded.entry_url,
       collection_method=excluded.collection_method, collector_kind=excluded.collector_kind,
       kind_detected_at=COALESCE(excluded.kind_detected_at, kind_detected_at),
       kind_evidence=COALESCE(excluded.kind_evidence, kind_evidence),
       enabled=excluded.enabled, notes=COALESCE(excluded.notes, notes), updated_at=excluded.updated_at`,
  ).run({
    id: s.id, name: s.name, nameSource: s.nameSource ?? "auto", baseUrl: s.baseUrl ?? null, entryUrl: s.entryUrl,
    method: s.collectionMethod ?? "http", kind: s.collectorKind ?? null,
    kindDetectedAt: s.kindDetectedAt ?? null, kindEvidence: s.kindEvidence ?? null,
    enabled: s.enabled === false ? 0 : 1, notes: s.notes ?? null, at,
  });
}
