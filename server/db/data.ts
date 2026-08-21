import type { SqliteDatabase } from "./connection";
import { platformOptions } from "../catalog/catalog";

function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function platformSortCase(expr: string): string {
  const branches = platformOptions.map((platform, index) => `WHEN ${sqlString(platform)} THEN ${index}`).join(" ");
  return `CASE ${expr} ${branches} ELSE 99 END`;
}

/** 可公开展示（有效在售）谓词。 */
function listable(alias = "o"): string {
  return `
  ${alias}.hidden = 0
  AND ${alias}.shadowed = 0
  AND ${alias}.price IS NOT NULL
  AND ${alias}.url IS NOT NULL
  AND ${alias}.status != 'out_of_stock'
  AND ${alias}.effective_status NOT IN ('unavailable','stale','failed')`;
}

const LISTABLE = listable();

// 「有货」和「库存紧张」同档：两者都能买到，差别只是店家标的库存多少，
// 不该让一个 ¥682 有货的排在 ¥455 库存紧张的前面——这是比价工具，价格才是首要标准。
// 缺货(2) 与不可用/缺数据(3) 仍然排在后面。
const SALE_BUCKET = "CASE WHEN availability_rank <= 1 THEN 0 ELSE availability_rank END";

/** SALE_BUCKET 的 TS 版本，用于内存排序。 */
function saleBucket(availabilityRank: number): number {
  return availabilityRank <= 1 ? 0 : availabilityRank;
}

interface OfferJoinRow {
  id: string; search_group_id: string; effective_canonical_product_id: string | null;
  source_id: string | null; source_title: string; source_name: string; source_store_name: string | null;
  price: number; currency: string; status: string; availability_rank: number;
  url: string; stock_count: number | null; verified_at: string | null;
  display_name: string | null; platform: string | null; product_type: string | null; spec: string | null; aliases: string | null; category_slug: string | null;
}

export interface ProductCard {
  groupId: string;
  canonicalId: string | null;
  displayName: string;
  representativeTitle: string;
  matchedTitle: string | null;
  resultOfferId: string;
  resultTitle: string;
  resultStore: string;
  resultPrice: number;
  resultUrl: string;
  resultAvailabilityRank: number;
  resultVerifiedAt: string | null;
  platform: string;
  productType: string | null;
  spec: string | null;
  lowestPrice: number;
  currency: string;
  storeCount: number;
  inStockCount: number;
  representativeUrl: string;
}

export interface ProductListResult {
  items: ProductCard[];
  total: number;
  page: number;
  pageSize: number;
}

function queryOfferRows(
  db: SqliteDatabase,
  opts: { platform?: string; groupIds?: readonly string[]; favoriteOnly?: boolean; sourceId?: string } = {},
): OfferJoinRow[] {
  if (opts.groupIds && opts.groupIds.length === 0) return [];
  const where: string[] = [LISTABLE];
  const params: Record<string, unknown> = {};
  if (opts.platform) {
    where.push("COALESCE(c.platform, o.category_slug) = @platform");
    params.platform = opts.platform;
  }
  if (opts.groupIds) {
    const placeholders = opts.groupIds.map((groupId, index) => {
      const key = `group${index}`;
      params[key] = groupId;
      return `@${key}`;
    });
    where.push(`o.search_group_id IN (${placeholders.join(", ")})`);
  }
  applySourceFilters(where, params, opts);

  return db
    .prepare(
      `SELECT o.id, o.search_group_id, o.effective_canonical_product_id, o.source_id, o.source_title, o.source_name,
              o.source_store_name, o.price, o.currency, o.status, o.availability_rank, o.url, o.stock_count, o.verified_at,
              c.display_name, c.platform, c.product_type, c.spec, c.aliases, o.category_slug
       FROM raw_offers o
       LEFT JOIN canonical_products c ON c.id = o.effective_canonical_product_id
       WHERE ${where.join(" AND ")}`,
    )
    .all(params) as OfferJoinRow[];
}

function applySourceFilters(
  where: string[],
  params: Record<string, unknown>,
  opts: { favoriteOnly?: boolean; sourceId?: string },
): void {
  if (opts.sourceId) {
    where.push("o.source_id = @sourceId");
    params.sourceId = opts.sourceId;
  }
  if (opts.favoriteOnly) {
    where.push("EXISTS (SELECT 1 FROM sources s WHERE s.id = o.source_id AND s.favorite = 1)");
  }
}

interface ProductCardRow {
  groupId: string;
  canonicalId: string | null;
  displayName: string;
  representativeTitle: string;
  matchedTitle: string | null;
  resultOfferId: string;
  resultTitle: string;
  resultStore: string;
  resultPrice: number;
  resultUrl: string;
  resultAvailabilityRank: number;
  resultVerifiedAt: string | null;
  platform: string;
  productType: string | null;
  spec: string | null;
  lowestPrice: number;
  currency: string;
  storeCount: number;
  inStockCount: number;
  representativeUrl: string;
  total: number;
}

interface ProductCardQueryRow extends Omit<ProductCardRow, "resultOfferId"> {
  resultOfferId: string | null;
}

function hasProductCard(row: ProductCardQueryRow): row is ProductCardRow {
  return row.resultOfferId !== null;
}

function productCardFromRow(row: ProductCardRow): ProductCard {
  return {
    groupId: row.groupId,
    canonicalId: row.canonicalId,
    displayName: row.displayName,
    representativeTitle: row.representativeTitle,
    matchedTitle: row.matchedTitle,
    resultOfferId: row.resultOfferId,
    resultTitle: row.resultTitle,
    resultStore: row.resultStore,
    resultPrice: row.resultPrice,
    resultUrl: row.resultUrl,
    resultAvailabilityRank: row.resultAvailabilityRank,
    resultVerifiedAt: row.resultVerifiedAt,
    platform: row.platform,
    productType: row.productType,
    spec: row.spec,
    lowestPrice: row.lowestPrice,
    currency: row.currency,
    storeCount: row.storeCount,
    inStockCount: row.inStockCount,
    representativeUrl: row.representativeUrl,
  };
}

/** 前台商品列表：按 search_group_id 聚合，代表取有货最低价。支持平台筛选。 */
export function listProducts(
  db: SqliteDatabase,
  opts: { platform?: string; q?: string; page?: number; pageSize?: number; favoriteOnly?: boolean; sourceId?: string } = {},
): ProductListResult {
  const page = Math.max(1, opts.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, opts.pageSize ?? 24));
  const where: string[] = [LISTABLE];
  const params: Record<string, unknown> = {
    limit: pageSize,
    offset: (page - 1) * pageSize,
  };
  if (opts.platform) {
    where.push("COALESCE(c.platform, o.category_slug) = @platform");
    params.platform = opts.platform;
  }
  applySourceFilters(where, params, opts);

  const rows = db
    .prepare(
      `WITH filtered AS (
         SELECT o.id, o.search_group_id, o.effective_canonical_product_id, o.source_title, o.source_name,
                o.source_store_name, o.price, o.currency, o.availability_rank, o.url, o.verified_at,
                c.display_name, c.platform, c.product_type, c.spec, o.category_slug,
                COALESCE(o.source_store_name, o.source_name) AS store_key
         FROM raw_offers o
         LEFT JOIN canonical_products c ON c.id = o.effective_canonical_product_id
         WHERE ${where.join(" AND ")}
       ),
       ranked AS (
         SELECT *,
                ROW_NUMBER() OVER (
                  PARTITION BY search_group_id
                  ORDER BY ${SALE_BUCKET} ASC, price ASC, id ASC
                ) AS rn
         FROM filtered
       ),
       grouped AS (
         SELECT search_group_id,
                COUNT(DISTINCT store_key) AS storeCount,
                SUM(CASE WHEN availability_rank <= 1 THEN 1 ELSE 0 END) AS inStockCount
         FROM filtered
         GROUP BY search_group_id
       ),
       cards AS (
         SELECT r.search_group_id AS groupId,
                r.effective_canonical_product_id AS canonicalId,
                COALESCE(r.display_name, r.source_title) AS displayName,
                r.source_title AS representativeTitle,
                NULL AS matchedTitle,
                r.id AS resultOfferId,
                r.source_title AS resultTitle,
                COALESCE(r.source_store_name, r.source_name) AS resultStore,
                r.price AS resultPrice,
                r.url AS resultUrl,
                r.availability_rank AS resultAvailabilityRank,
                r.verified_at AS resultVerifiedAt,
                COALESCE(r.platform, r.category_slug, '其他') AS platform,
                r.product_type AS productType,
                r.spec AS spec,
                r.price AS lowestPrice,
                r.currency AS currency,
                g.storeCount AS storeCount,
                g.inStockCount AS inStockCount,
                r.url AS representativeUrl
         FROM ranked r
         JOIN grouped g ON g.search_group_id = r.search_group_id
         WHERE r.rn = 1
       ),
       total_count AS (
         SELECT COUNT(*) AS total FROM grouped
       ),
       paged_cards AS (
         SELECT cards.*
         FROM cards
         ORDER BY ${platformSortCase("platform")} ASC, lowestPrice ASC, groupId ASC
         LIMIT @limit OFFSET @offset
       )
       SELECT paged_cards.*, total_count.total
       FROM total_count
       LEFT JOIN paged_cards ON 1=1`,
    )
    .all(params) as ProductCardQueryRow[];

  const cardRows = rows.filter(hasProductCard);
  return {
    items: cardRows.map(productCardFromRow),
    total: rows[0]?.total ?? 0,
    page,
    pageSize,
  };
}

/** 关键词搜索：返回具体 offer 卡片，不按 search_group 压缩。 */
export function searchOffers(
  db: SqliteDatabase,
  opts: { platform?: string; q: string; sort?: "relevance" | "price"; page?: number; pageSize?: number; favoriteOnly?: boolean; sourceId?: string },
): ProductListResult {
  const query = normalizeSearchQuery(opts.q);
  const page = Math.max(1, opts.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, opts.pageSize ?? 24));
  if (!query) return listProducts(db, { platform: opts.platform, page, pageSize, favoriteOnly: opts.favoriteOnly, sourceId: opts.sourceId });

  const rows = queryOfferRows(db, { platform: opts.platform, favoriteOnly: opts.favoriteOnly, sourceId: opts.sourceId });
  const searchQuery = parseSearchQuery(query);
  const matched = rows
    .map((row) => ({ row, score: scoreOfferMatch(row, searchQuery) }))
    .filter((item) => item.score > 0);

  matched.sort((a, b) => {
    if (opts.sort === "price") {
      return a.row.price - b.row.price
        || saleBucket(a.row.availability_rank) - saleBucket(b.row.availability_rank)
        || b.score - a.score;
    }
    return b.score - a.score
      || a.row.price - b.row.price
      || saleBucket(a.row.availability_rank) - saleBucket(b.row.availability_rank);
  });

  const total = matched.length;
  const start = (page - 1) * pageSize;
  const pageMatches = matched.slice(start, start + pageSize);
  const groupIds = [...new Set(pageMatches.map(({ row }) => row.search_group_id))];
  const groups = groupOffers(queryOfferRows(db, { platform: opts.platform, groupIds, favoriteOnly: opts.favoriteOnly, sourceId: opts.sourceId }));
  const cards = pageMatches.map(({ row }) => offerToCard(row, groups.get(row.search_group_id) ?? [row], searchQuery));
  return { items: cards, total, page, pageSize };
}

export interface ProductOffer {
  id: string; sourceId: string | null; sourceName: string; sourceStoreName: string | null; sourceTitle: string; sourceFavorite: boolean;
  price: number | null; currency: string; status: string; availabilityRank: number;
  url: string; stockCount: number | null; stockText: string | null; tags: string[]; verifiedAt: string | null;
}

/** 商品详情：某标准品下各店铺报价（有货优先、价格升序）。 */
export function getProductOffers(db: SqliteDatabase, canonicalId: string): { canonical: any; offers: ProductOffer[] } {
  const canonical = db.prepare("SELECT * FROM canonical_products WHERE id=?").get(canonicalId) ?? null;
  const rows = db
    .prepare(
      `SELECT o.id, o.source_id, o.source_name, o.source_store_name, o.source_title, o.price, o.currency, o.status,
              o.availability_rank, o.url, o.stock_count, o.stock_text, o.tags, o.verified_at,
              COALESCE(s.favorite, 0) AS source_favorite
       FROM raw_offers o
       LEFT JOIN sources s ON s.id = o.source_id
       WHERE o.effective_canonical_product_id=? AND o.hidden=0 AND o.shadowed=0
       ORDER BY ${SALE_BUCKET} ASC, price ASC`,
    )
    .all(canonicalId) as any[];
  const offers: ProductOffer[] = rows.map((r) => ({
    id: r.id, sourceId: r.source_id, sourceName: r.source_name, sourceStoreName: r.source_store_name, sourceTitle: r.source_title,
    sourceFavorite: Boolean(r.source_favorite),
    price: r.price, currency: r.currency, status: r.status, availabilityRank: r.availability_rank,
    url: r.url, stockCount: r.stock_count, stockText: r.stock_text ?? null, tags: safeJson(r.tags), verifiedAt: r.verified_at,
  }));
  return { canonical, offers };
}

export function listSourcesView(db: SqliteDatabase): any[] {
  return db
    .prepare(
      `SELECT id, name, name_source, base_url, entry_url, collection_method, collector_kind, kind_detected_at, kind_evidence, enabled, health_status,
              last_checked_at, last_success_at, consecutive_failures, last_error, favorite, favorited_at,
              collector_lock_until, notes, created_at, updated_at
       FROM sources ORDER BY favorite DESC, favorited_at DESC, created_at DESC`,
    )
    .all();
}

export interface FavoriteSourceSummary {
  id: string;
  name: string;
  entry_url: string;
  base_url: string | null;
  health_status: string;
  enabled: number;
  favorite: number;
  favorited_at: string | null;
  last_success_at: string | null;
  listable_product_count: number;
  latest_offer_at: string | null;
}

export function listFavoriteSources(db: SqliteDatabase): FavoriteSourceSummary[] {
  return db
    .prepare(
      `WITH listable_offers AS (
         SELECT o.source_id, o.search_group_id, COALESCE(o.verified_at, o.last_seen_at, o.captured_at) AS offer_at
         FROM raw_offers o
         WHERE ${LISTABLE}
       ),
       source_stats AS (
         SELECT source_id,
                COUNT(DISTINCT search_group_id) AS listable_product_count,
                MAX(offer_at) AS latest_offer_at
         FROM listable_offers
         GROUP BY source_id
       )
       SELECT s.id, s.name, s.entry_url, s.base_url, s.health_status, s.enabled, s.favorite,
              s.favorited_at, s.last_success_at,
              COALESCE(st.listable_product_count, 0) AS listable_product_count,
              st.latest_offer_at
       FROM sources s
       LEFT JOIN source_stats st ON st.source_id = s.id
       WHERE s.favorite = 1
       ORDER BY s.favorited_at DESC, s.name ASC`,
    )
    .all() as FavoriteSourceSummary[];
}

export function listSourceMethodDrift(db: SqliteDatabase): any[] {
  return db
    .prepare(
      `SELECT id, name, entry_url, collection_method, collector_kind, health_status, last_error
       FROM sources
       WHERE collection_method='browser' AND COALESCE(collector_kind, 'auto') != 'browser'
       ORDER BY updated_at DESC`,
    )
    .all();
}

export function listCrawlRuns(db: SqliteDatabase, opts: { sourceId?: string; limit?: number } = {}): any[] {
  const limit = Math.min(500, Math.max(1, opts.limit ?? 100));
  if (opts.sourceId) {
    return db.prepare("SELECT * FROM crawl_runs WHERE source_id=? ORDER BY started_at DESC LIMIT ?").all(opts.sourceId, limit);
  }
  return db.prepare("SELECT * FROM crawl_runs ORDER BY started_at DESC LIMIT ?").all(limit);
}

export function listJobs(db: SqliteDatabase, limit = 50): any[] {
  return db.prepare("SELECT * FROM collection_jobs ORDER BY created_at DESC LIMIT ?").all(Math.min(200, limit));
}

export function getJob(db: SqliteDatabase, id: string): any {
  return db.prepare("SELECT * FROM collection_jobs WHERE id=?").get(id) ?? null;
}

function safeJson(value: unknown): string[] {
  try {
    const v = JSON.parse(String(value ?? "[]"));
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function normalizeSearchQuery(q: string | undefined): string {
  return (q ?? "").trim().replace(/\s+/g, " ");
}

const GENERIC_ASCII_TERMS = new Set([
  "gpt", "plus", "pro", "api", "ai", "team", "max", "cdk", "go",
]);

const GENERIC_CJK_TERMS = new Set([
  "账号", "帐号", "会员", "邮箱", "接码", "卡密", "月卡", "成品号",
]);

interface TextMetrics {
  text: string;
  compact: string;
  tokens: string[];
}

interface SearchTerm {
  raw: string;
  kind: "ascii" | "cjk";
  generic: boolean;
  concrete: boolean;
  titleAllowed: boolean;
}

interface ParsedSearchQuery {
  raw: string;
  asciiText: string;
  compact: string;
  terms: SearchTerm[];
  hasNonGenericTerm: boolean;
}

interface SearchField {
  value: string;
  metrics: TextMetrics;
  weight: number;
}

interface SearchDocument {
  high: SearchField[];
  title: SearchField;
}

function normalizeForAsciiTokens(value: string): string {
  return value
    .toLowerCase()
    .replace(/gptplus/g, "gpt plus")
    .replace(/chat\s*gpt/g, "chatgpt")
    .replace(/[+]/g, " plus ")
    .replace(/[^a-z0-9#]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function buildTextMetrics(value: string | null | undefined): TextMetrics {
  const text = normalizeForAsciiTokens(value ?? "");
  const baseTokens = text ? text.split(" ") : [];
  const tokens = new Set<string>();
  for (const token of baseTokens) {
    if (!token) continue;
    tokens.add(token);
    if (token === "chatgpt") tokens.add("gpt");
  }
  return { text, compact: text.replace(/\s+/g, ""), tokens: [...tokens] };
}

function parseSearchQuery(query: string): ParsedSearchQuery {
  const raw = normalizeSearchQuery(query);
  const asciiText = normalizeForAsciiTokens(raw);
  const asciiTerms = asciiText
    ? [...new Set(asciiText.split(" ").filter(Boolean))]
    : [];
  const cjkTerms = [...new Set(raw.match(/[\u3400-\u9fff]{2,}/g) ?? [])].map((term) => term.toLowerCase());
  const hasNonGenericTerm = asciiTerms.some((term) => !GENERIC_ASCII_TERMS.has(term))
    || cjkTerms.some((term) => !GENERIC_CJK_TERMS.has(term));

  const terms: SearchTerm[] = [
    ...asciiTerms.map((term) => ({
      raw: term,
      kind: "ascii" as const,
      generic: GENERIC_ASCII_TERMS.has(term),
      concrete: term.length >= 4 && !GENERIC_ASCII_TERMS.has(term),
      titleAllowed: !GENERIC_ASCII_TERMS.has(term) || hasNonGenericTerm,
    })),
    ...cjkTerms.map((term) => ({
      raw: term,
      kind: "cjk" as const,
      generic: GENERIC_CJK_TERMS.has(term),
      concrete: term.length >= 2 && !GENERIC_CJK_TERMS.has(term),
      titleAllowed: (!GENERIC_CJK_TERMS.has(term) || hasNonGenericTerm) && term.length >= 2,
    })),
  ];

  return { raw, asciiText, compact: asciiText.replace(/\s+/g, ""), terms, hasNonGenericTerm };
}

function field(value: string | null | undefined, weight: number): SearchField | null {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) return null;
  return { value: trimmed, metrics: buildTextMetrics(trimmed), weight };
}

function buildSearchDocument(row: OfferJoinRow): SearchDocument {
  const aliases = safeJson(row.aliases).join(" ");
  const high = [
    field(row.display_name, 900),
    field(aliases, 860),
    field(row.platform, 820),
    field(row.product_type, 760),
    field(row.spec, 740),
    field([row.platform, row.display_name, aliases].filter(Boolean).join(" "), 700),
  ].filter((item): item is SearchField => Boolean(item));
  return {
    high,
    title: field(row.source_title, 420) ?? { value: "", metrics: buildTextMetrics(""), weight: 420 },
  };
}

function asciiTermMatches(metrics: TextMetrics, term: SearchTerm): boolean {
  if (term.concrete) return metrics.text.includes(term.raw) || metrics.compact.includes(term.raw);
  return metrics.tokens.includes(term.raw);
}

function cjkTermMatches(value: string, term: SearchTerm): boolean {
  return value.toLowerCase().includes(term.raw);
}

function termMatchesField(field: SearchField, term: SearchTerm): boolean {
  if (term.kind === "ascii") return asciiTermMatches(field.metrics, term);
  return cjkTermMatches(field.value, term);
}

function fieldPhraseScore(field: SearchField, query: ParsedSearchQuery, exactBonus: number, containsBonus: number): number {
  if (!query.asciiText) return 0;
  if (field.metrics.text === query.asciiText || field.metrics.compact === query.compact) {
    return field.weight + exactBonus;
  }
  if (query.compact.length >= 2 && (field.metrics.text.includes(query.asciiText) || field.metrics.compact.includes(query.compact))) {
    return field.weight + containsBonus;
  }
  return 0;
}

function scoreOfferMatch(row: OfferJoinRow, query: ParsedSearchQuery): number {
  if (!query.terms.length) return 0;
  const doc = buildSearchDocument(row);
  let score = 0;
  let highMatches = 0;
  let titleMatches = 0;

  for (const term of query.terms) {
    const highField = doc.high.find((candidate) => termMatchesField(candidate, term));
    const titleField = term.titleAllowed && termMatchesField(doc.title, term) ? doc.title : null;
    if (!highField && !titleField) return 0;

    if (highField) {
      highMatches += 1;
      score += highField.weight;
    }
    if (titleField) {
      titleMatches += 1;
      score += titleField.weight;
    }
  }

  const bestHighPhrase = Math.max(0, ...doc.high.map((candidate) => fieldPhraseScore(candidate, query, 5000, 2200)));
  const titlePhrase = query.terms.every((term) => term.titleAllowed)
    ? fieldPhraseScore(doc.title, query, 2600, 1100)
    : 0;
  score += bestHighPhrase + titlePhrase;
  if (highMatches === query.terms.length) score += 900;
  if (titleMatches === query.terms.length) score += 350;
  return score;
}

function groupOffers(rows: OfferJoinRow[]): Map<string, OfferJoinRow[]> {
  const groups = new Map<string, OfferJoinRow[]>();
  for (const row of rows) {
    const arr = groups.get(row.search_group_id) ?? [];
    arr.push(row);
    groups.set(row.search_group_id, arr);
  }
  return groups;
}

function matchesOfferTitle(value: string, query: ParsedSearchQuery): boolean {
  if (!query.terms.length) return false;
  const title = field(value, 1);
  if (!title) return false;
  return query.terms.every((term) => term.titleAllowed && termMatchesField(title, term));
}

function offerToCard(row: OfferJoinRow, group: OfferJoinRow[], query: ParsedSearchQuery | null): ProductCard {
  // 代表条目决定卡片上显示的 lowestPrice，同档内按价格取最低才对得起「最低价」这个名字
  group.sort((a, b) => saleBucket(a.availability_rank) - saleBucket(b.availability_rank) || a.price - b.price);
  const rep = group[0] ?? row;
  const stores = new Set(group.map((o) => o.source_store_name || o.source_name));
  const matchedTitle = query && matchesOfferTitle(row.source_title, query) ? row.source_title : null;

  return {
    groupId: row.search_group_id,
    canonicalId: row.effective_canonical_product_id,
    displayName: row.display_name || row.source_title,
    representativeTitle: rep.source_title,
    matchedTitle,
    resultOfferId: row.id,
    resultTitle: row.source_title,
    resultStore: row.source_store_name || row.source_name,
    resultPrice: row.price,
    resultUrl: row.url,
    resultAvailabilityRank: row.availability_rank,
    resultVerifiedAt: row.verified_at,
    platform: row.platform || row.category_slug || "其他",
    productType: row.product_type,
    spec: row.spec,
    lowestPrice: rep.price,
    currency: row.currency,
    storeCount: stores.size,
    inStockCount: group.filter((o) => o.availability_rank <= 1).length,
    representativeUrl: rep.url,
  };
}
