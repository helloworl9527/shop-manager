import type { SqliteDatabase } from "./connection";
import { nowIso } from "./repo";

export interface FavoriteView {
  id: number;
  offerId: string;
  title: string;
  store: string | null;
  url: string | null;
  priceSnapshot: number | null;
  currency: string;
  statusSnapshot: string | null;
  canonicalProductId: string | null;
  note: string | null;
  createdAt: string;
  // 回查现状
  live: boolean;
  currentPrice: number | null;
  currentStatus: string | null;
  currentAvailabilityRank: number | null;
}

interface OfferSnapshotRow {
  url_canonical: string | null; source_offer_key: string | null; source_id: string | null;
  source_store_name: string | null; source_name: string; source_title: string;
  effective_canonical_product_id: string | null; price: number | null; currency: string; status: string;
}

/** 收藏一个具体商品（offer 级）。带快照 + offer_id/url 双重去重，幂等。 */
export function addFavorite(db: SqliteDatabase, offerId: string, note?: string | null): { ok: boolean; created: boolean } {
  const o = db
    .prepare(
      `SELECT url_canonical, source_offer_key, source_id, source_store_name, source_name, source_title,
              effective_canonical_product_id, price, currency, status
       FROM raw_offers WHERE id=?`,
    )
    .get(offerId) as OfferSnapshotRow | undefined;
  if (!o) throw Object.assign(new Error("商品不存在"), { statusCode: 404 });

  // 已收藏？按 offer_id 或 (url, key) 判
  const existing = db
    .prepare(
      `SELECT id FROM favorites
       WHERE offer_id=@offerId
          OR (url_canonical_snapshot IS NOT NULL AND url_canonical_snapshot=@url
              AND ((source_offer_key_snapshot IS NULL AND @key IS NULL) OR source_offer_key_snapshot=@key))
       LIMIT 1`,
    )
    .get({ offerId, url: o.url_canonical, key: o.source_offer_key }) as { id: number } | undefined;
  if (existing) return { ok: true, created: false };

  const at = nowIso();
  db.prepare(
    `INSERT INTO favorites
      (offer_id, url_canonical_snapshot, source_offer_key_snapshot, source_id_snapshot, source_store_name_snapshot,
       title_snapshot, canonical_product_id_snapshot, price_snapshot, currency_snapshot, status_snapshot, note, created_at, updated_at)
     VALUES (@offerId, @url, @key, @sid, @store, @title, @cpid, @price, @currency, @status, @note, @at, @at)`,
  ).run({
    offerId, url: o.url_canonical, key: o.source_offer_key, sid: o.source_id,
    store: o.source_store_name ?? o.source_name, title: o.source_title,
    cpid: o.effective_canonical_product_id, price: o.price, currency: o.currency, status: o.status,
    note: note ?? null, at,
  });
  return { ok: true, created: true };
}

export function removeFavorite(db: SqliteDatabase, offerId: string): { removed: boolean } {
  const info = db.prepare("DELETE FROM favorites WHERE offer_id=?").run(offerId);
  return { removed: info.changes > 0 };
}

/** 列出收藏，回查现价/状态：先按 offer_id，未命中再按 (url, key) 重定位；都无则只读快照标失效。 */
export function listFavorites(db: SqliteDatabase): FavoriteView[] {
  const rows = db.prepare("SELECT * FROM favorites ORDER BY created_at DESC").all() as any[];
  const byId = db.prepare("SELECT id, price, status, availability_rank, url FROM raw_offers WHERE id=?");
  const byUrlKey = db.prepare(
    `SELECT id, price, status, availability_rank, url FROM raw_offers
     WHERE url_canonical=@url AND ((source_offer_key IS NULL AND @key IS NULL) OR source_offer_key=@key) AND hidden=0
     ORDER BY availability_rank ASC, price ASC LIMIT 1`,
  );
  return rows.map((f) => {
    let cur = byId.get(f.offer_id) as any;
    if (!cur && f.url_canonical_snapshot) cur = byUrlKey.get({ url: f.url_canonical_snapshot, key: f.source_offer_key_snapshot }) as any;
    return {
      id: f.id,
      offerId: f.offer_id,
      title: f.title_snapshot,
      store: f.source_store_name_snapshot,
      url: cur?.url ?? null,
      priceSnapshot: f.price_snapshot,
      currency: f.currency_snapshot || "CNY",
      statusSnapshot: f.status_snapshot,
      canonicalProductId: f.canonical_product_id_snapshot,
      note: f.note,
      createdAt: f.created_at,
      live: Boolean(cur),
      currentPrice: cur?.price ?? null,
      currentStatus: cur?.status ?? null,
      currentAvailabilityRank: cur?.availability_rank ?? null,
    };
  });
}

/** 返回已收藏的 offer_id 集合（供前端标星）。 */
export function favoriteOfferIds(db: SqliteDatabase): string[] {
  return (db.prepare("SELECT offer_id FROM favorites").all() as { offer_id: string }[]).map((r) => r.offer_id);
}
