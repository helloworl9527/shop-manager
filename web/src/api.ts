// 后端 API 客户端。开发用 Vite 代理 /api → 后端；也可用 VITE_API_BASE 直连。
const BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? "";

async function http<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(json?.error || `HTTP ${res.status}`);
  return json as T;
}

export interface Source {
  id: string; name: string; name_source: "auto" | "manual" | null; entry_url: string; base_url: string | null;
  collector_kind: string | null; collection_method: string; enabled: number;
  kind_detected_at: string | null; kind_evidence: string | null;
  health_status: string; last_success_at: string | null; last_error: string | null;
  consecutive_failures: number; favorite: number; favorited_at: string | null;
  collector_lock_until: string | null; notes: string | null;
}

export interface SourceMethodDrift {
  id: string; name: string; entry_url: string; collection_method: string;
  collector_kind: string | null; health_status: string; last_error: string | null;
}

export interface Job {
  id: string; job_type: string; source_id: string | null; source_name: string | null;
  status: string; started_at: string | null; finished_at: string | null; last_error: string | null; created_at: string;
}

export interface CrawlRun {
  id: string; source_id: string | null; source_name: string | null; mode: string; status: string;
  started_at: string; finished_at: string | null; success_count: number; failure_count: number; message: string | null; details: string;
}

export interface ProbeAttempt {
  step: string; ok: boolean; ms: number; message?: string;
}

export interface SourceProbeOffer {
  sourceTitle: string; price: number | null; status: string; url: string; tags: string[]; stockCount: number | null; sourceStoreName?: string | null;
}

export interface SourceProbeResult {
  normalized: { rawUrl: string; entryUrl: string; baseUrl: string; shopToken: string | null };
  kind: string;
  evidence: string;
  storeName: string | null;
  offers: SourceProbeOffer[];
  attempts: ProbeAttempt[];
  duplicate: { id: string; name: string } | null;
}

export interface VerifyPendingSource {
  id: string; name: string; entry_url: string; base_url: string | null;
  collector_kind: string | null; collection_method: string;
  last_error: string | null; last_checked_at: string | null;
}

export interface VerifyTargetState {
  sourceId: string; name: string; url: string;
  status: "waiting" | "passed" | "collected" | "failed" | "timeout";
  offers?: number; message?: string; startedAt?: string; finishedAt?: string;
}

export interface VerifySessionState {
  status: "idle" | "running";
  startedAt?: string; finishedAt?: string; targets: VerifyTargetState[]; message?: string;
}

export interface ProductCard {
  groupId: string; canonicalId: string | null; displayName: string; platform: string;
  representativeTitle: string; matchedTitle: string | null; resultOfferId: string; resultTitle: string;
  resultStore: string; resultPrice: number; resultUrl: string; resultAvailabilityRank: number;
  resultVerifiedAt: string | null; productType: string | null; spec: string | null; lowestPrice: number; currency: string;
  storeCount: number; inStockCount: number; representativeUrl: string;
}
export interface ProductListResult { items: ProductCard[]; total: number; page: number; pageSize: number; }
export interface ProductOffer {
  id: string; sourceId: string | null; sourceName: string; sourceStoreName: string | null; sourceTitle: string; sourceFavorite: boolean;
  price: number | null; currency: string; status: string; availabilityRank: number;
  url: string; stockCount: number | null; stockText: string | null; tags: string[]; verifiedAt: string | null;
}

export interface Favorite {
  id: number; offerId: string; title: string; store: string | null; url: string | null;
  priceSnapshot: number | null; currency: string; statusSnapshot: string | null;
  canonicalProductId: string | null; note: string | null; createdAt: string;
  live: boolean; currentPrice: number | null; currentStatus: string | null; currentAvailabilityRank: number | null;
}

export interface FavoriteSourceSummary {
  id: string; name: string; entry_url: string; base_url: string | null;
  health_status: string; enabled: number; favorite: number; favorited_at: string | null;
  last_success_at: string | null; listable_product_count: number; latest_offer_at: string | null;
}

export interface FavoriteStore {
  id: string; url: string; name: string; name_source: string;
  category: string | null; note: string | null; source_id: string | null;
  collected: boolean; created_at: string; updated_at: string;
}

function qs(params: Record<string, string | number | boolean | undefined>): string {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") u.set(k, String(v));
  const s = u.toString();
  return s ? `?${s}` : "";
}

export const api = {
  listProducts: (opts: { platform?: string; q?: string; page?: number; pageSize?: number; favoriteOnly?: boolean; sourceId?: string } = {}) =>
    http<ProductListResult>("GET", `/api/products${qs(opts)}`),
  search: (opts: { q?: string; platform?: string; sort?: string; page?: number; pageSize?: number; favoriteOnly?: boolean; sourceId?: string } = {}) =>
    http<ProductListResult & { engine?: string }>("GET", `/api/search${qs(opts)}`),
  getProductOffers: (canonicalId: string) =>
    http<{ canonical: any; offers: ProductOffer[] }>("GET", `/api/products/${encodeURIComponent(canonicalId)}/offers`),
  listFavorites: () => http<{ items: Favorite[] }>("GET", "/api/favorites").then((r) => r.items),
  favoriteIds: () => http<{ ids: string[] }>("GET", "/api/favorites/ids").then((r) => r.ids),
  addFavorite: (offerId: string) => http<{ ok: boolean; created: boolean }>("POST", "/api/favorites", { offerId }),
  removeFavorite: (offerId: string) => http<{ removed: boolean }>("DELETE", `/api/favorites/${encodeURIComponent(offerId)}`),
  listFavoriteStores: () => http<{ items: FavoriteStore[]; categories: string[] }>("GET", "/api/favorite-stores"),
  addFavoriteStore: (body: { url: string; name?: string; category?: string; note?: string }) =>
    http<{ row: FavoriteStore; created: boolean }>("POST", "/api/favorite-stores", body),
  updateFavoriteStore: (id: string, patch: { name?: string; category?: string | null; note?: string | null }) =>
    http<{ updated: boolean; row: FavoriteStore }>("PATCH", `/api/favorite-stores/${encodeURIComponent(id)}`, patch),
  removeFavoriteStore: (id: string) =>
    http<{ removed: boolean }>("DELETE", `/api/favorite-stores/${encodeURIComponent(id)}`),
  listSources: () => http<{ items: Source[] }>("GET", "/api/sources").then((r) => r.items),
  listFavoriteSources: () => http<{ items: FavoriteSourceSummary[] }>("GET", "/api/sources/favorites").then((r) => r.items),
  setSourceFavorite: (id: string, favorite: boolean) =>
    http<{ updated: boolean; source: Source }>("PATCH", `/api/sources/${id}`, { favorite }),
  auditSources: () => http<{ methodDrift: SourceMethodDrift[] }>("GET", "/api/sources/audit"),
  probeSource: (url: string) => http<SourceProbeResult>("POST", "/api/sources/probe", { url }),
  migrateSourceKinds: () => http<{ total: number; updated: number; items: Array<{ id: string; name: string; kind: string; evidence: string; updated: boolean }> }>("POST", "/api/sources/migrate-kinds"),
  addSource: (s: {
    name?: string; nameSource?: "auto" | "manual"; entryUrl: string; baseUrl?: string | null; collectorKind: string; collectionMethod?: string;
    kindEvidence?: string | null; kindDetectedAt?: string | null; enabled?: boolean; notes?: string | null;
    offers?: SourceProbeOffer[];
  }) =>
    http<{ source: Source }>("POST", "/api/sources", s).then((r) => r.source),
  updateSource: (id: string, patch: Record<string, unknown>) =>
    http<{ updated: boolean; source: Source }>("PATCH", `/api/sources/${id}`, patch),
  reidentifySource: (id: string) =>
    http<{ source: Source; job: { jobId: string; created: boolean; note?: string } }>("POST", `/api/sources/${id}/reidentify`),
  deleteSource: (id: string, deleteOffers = false) =>
    http<{ deleted: boolean; deletedOffers: number }>("DELETE", `/api/sources/${id}${deleteOffers ? "?deleteOffers=1" : ""}`),
  collect: (payload: { all?: boolean; sourceId?: string }) =>
    http<{ jobId: string; created: boolean; note?: string }>("POST", "/api/collect", payload),
  listJobs: () => http<{ items: Job[] }>("GET", "/api/jobs").then((r) => r.items),
  listCrawlRuns: (limit = 50) => http<{ items: CrawlRun[] }>("GET", `/api/crawl-runs?limit=${limit}`).then((r) => r.items),
  listVerifyPending: () => http<{ items: VerifyPendingSource[] }>("GET", "/api/verify/pending").then((r) => r.items),
  startVerify: (sourceIds?: string[]) => http<VerifySessionState>("POST", "/api/verify/start", sourceIds ? { sourceIds } : {}),
  verifyStatus: () => http<VerifySessionState>("GET", "/api/verify/status"),
  cancelVerify: () => http<VerifySessionState>("POST", "/api/verify/cancel"),
  reclassify: () => http<{ updated: number; distribution: Record<string, number> }>("POST", "/api/reclassify"),
};

export const COLLECTOR_KINDS = ["auto", "kami", "dujiao", "dujiaoHtml", "shopApi", "publicProductsApi", "genericHtml", "browser"] as const;
export const PLATFORMS = ["ChatGPT", "Claude", "Gemini", "Grok", "API/CDK", "邮箱", "接码", "其他"] as const;
