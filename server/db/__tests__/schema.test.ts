import { describe, it, expect, beforeEach } from "vitest";
import { openDatabase, type SqliteDatabase } from "../connection";
import { applySchema, seedCanonicalProducts } from "../init";

function freshDb(): SqliteDatabase {
  const db = openDatabase(":memory:");
  applySchema(db);
  seedCanonicalProducts(db);
  return db;
}

const now = new Date().toISOString();

function insertOffer(
  db: SqliteDatabase,
  o: { id: string; canonical?: string | null; manual?: string | null; url?: string },
): void {
  db.prepare(
    `INSERT INTO raw_offers
       (id, source_id, source_name, source_title, url, canonical_product_id, manual_canonical_product_id,
        captured_at, last_seen_at, created_at, updated_at)
     VALUES (@id, NULL, 'store', 't', @url, @canonical, @manual, @now, @now, @now, @now)`,
  ).run({
    id: o.id,
    url: o.url ?? `https://x/item/${o.id}`,
    canonical: o.canonical ?? null,
    manual: o.manual ?? null,
    now,
  });
}

function groupOf(db: SqliteDatabase, id: string) {
  return db
    .prepare("SELECT effective_canonical_product_id AS eff, search_group_id AS grp FROM raw_offers WHERE id=?")
    .get(id) as { eff: string | null; grp: string };
}

describe("schema 初始化", () => {
  it("seed 写入全部分类，含 other-product", () => {
    const db = freshDb();
    const n = (db.prepare("SELECT COUNT(*) AS n FROM canonical_products").get() as { n: number }).n;
    expect(n).toBeGreaterThanOrEqual(30);
    expect(db.prepare("SELECT 1 FROM canonical_products WHERE id='other-product'").get()).toBeTruthy();
    db.close();
  });

  it("foreign_keys 在每个连接生效：插入不存在的 canonical 应抛错", () => {
    const db = freshDb();
    expect(() => insertOffer(db, { id: "o1", canonical: "ghost-id" })).toThrow();
    db.close();
  });
});

describe("生成列 effective / search_group", () => {
  it("有分类时 effective=canonical，search_group=canonical", () => {
    const db = freshDb();
    insertOffer(db, { id: "o1", canonical: "chatgpt-plus" });
    expect(groupOf(db, "o1")).toEqual({ eff: "chatgpt-plus", grp: "chatgpt-plus" });
    db.close();
  });

  it("人工覆盖优先：manual 覆盖 auto", () => {
    const db = freshDb();
    insertOffer(db, { id: "o2", canonical: "chatgpt-plus", manual: "claude-pro-month" });
    expect(groupOf(db, "o2")).toEqual({ eff: "claude-pro-month", grp: "claude-pro-month" });
    db.close();
  });

  it("other-product 不被压缩：search_group=offer:<id>", () => {
    const db = freshDb();
    insertOffer(db, { id: "o3", canonical: "other-product" });
    expect(groupOf(db, "o3")).toEqual({ eff: "other-product", grp: "offer:o3" });
    db.close();
  });

  it("未分类(null) → search_group=offer:<id>", () => {
    const db = freshDb();
    insertOffer(db, { id: "o4", canonical: null });
    expect(groupOf(db, "o4")).toEqual({ eff: null, grp: "offer:o4" });
    db.close();
  });

  it("availability_rank 默认 3", () => {
    const db = freshDb();
    insertOffer(db, { id: "o5", canonical: "chatgpt-plus" });
    const r = db.prepare("SELECT availability_rank AS r FROM raw_offers WHERE id='o5'").get() as { r: number };
    expect(r.r).toBe(3);
    db.close();
  });

  it("前台列表热点索引会随 schema 初始化创建", () => {
    const db = freshDb();
    const rows = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='raw_offers'")
      .all() as { name: string }[];
    const names = new Set(rows.map((row) => row.name));
    expect(names.has("idx_offers_public_group_rank_price")).toBe(true);
    expect(names.has("idx_offers_public_category_group_rank_price")).toBe(true);
    db.close();
  });

  it("sources 收藏字段和排序索引会随 schema 初始化创建", () => {
    const db = freshDb();
    const cols = db.prepare("PRAGMA table_info(sources)").all() as { name: string }[];
    const colNames = new Set(cols.map((col) => col.name));
    expect(colNames.has("name_source")).toBe(true);
    expect(colNames.has("favorite")).toBe(true);
    expect(colNames.has("favorited_at")).toBe(true);
    const rows = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='sources'")
      .all() as { name: string }[];
    expect(new Set(rows.map((row) => row.name)).has("idx_sources_favorite_at")).toBe(true);
    db.close();
  });

  it("迁移会恢复非缺货的 expired 历史报价", () => {
    const db = freshDb();
    insertOffer(db, { id: "expired", canonical: "chatgpt-plus" });
    db.prepare(
      `UPDATE raw_offers
       SET status='in_stock', price=30, effective_status='unavailable',
           freshness_status='expired', availability_rank=3
       WHERE id='expired'`,
    ).run();

    applySchema(db);

    const row = db.prepare("SELECT effective_status, freshness_status, availability_rank FROM raw_offers WHERE id='expired'").get() as any;
    expect(row).toEqual({ effective_status: "available", freshness_status: "fresh", availability_rank: 0 });
    db.close();
  });
});

describe("favorites 去重（对多 SKU 友好）", () => {
  const favSql = `INSERT INTO favorites (offer_id, url_canonical_snapshot, source_offer_key_snapshot, created_at, updated_at)
                  VALUES (@offer, @url, @key, @now, @now)`;
  it("同 URL 不同 SKU 可分别收藏", () => {
    const db = freshDb();
    const stmt = db.prepare(favSql);
    stmt.run({ offer: "a", url: "https://x/p/1", key: "sku-1", now });
    expect(() => stmt.run({ offer: "b", url: "https://x/p/1", key: "sku-2", now })).not.toThrow();
    db.close();
  });
  it("同 URL 同 SKU 重复 → 拒绝", () => {
    const db = freshDb();
    const stmt = db.prepare(favSql);
    stmt.run({ offer: "a", url: "https://x/p/1", key: "sku-1", now });
    expect(() => stmt.run({ offer: "b", url: "https://x/p/1", key: "sku-1", now })).toThrow();
    db.close();
  });
  it("无 SKU 键时同 URL 重复 → 拒绝", () => {
    const db = freshDb();
    const stmt = db.prepare(favSql);
    stmt.run({ offer: "a", url: "https://x/p/9", key: null, now });
    expect(() => stmt.run({ offer: "b", url: "https://x/p/9", key: null, now })).toThrow();
    db.close();
  });
});

describe("collection_jobs 活动任务 DB 级防重", () => {
  const jobSql = `INSERT INTO collection_jobs (id, job_type, source_id, status, created_at, updated_at)
                  VALUES (@id, @type, @src, 'pending', @now, @now)`;
  const seedSource = (db: SqliteDatabase) =>
    db.prepare("INSERT INTO sources(id,name,entry_url,created_at,updated_at) VALUES('s1','store','https://s1',@now,@now)").run({ now });
  it("同 source 第二个 pending → 拒绝", () => {
    const db = freshDb();
    seedSource(db);
    const stmt = db.prepare(jobSql);
    stmt.run({ id: "j1", type: "source", src: "s1", now });
    expect(() => stmt.run({ id: "j2", type: "source", src: "s1", now })).toThrow();
    db.close();
  });
  it("第二个 all pending → 拒绝", () => {
    const db = freshDb();
    const stmt = db.prepare(jobSql);
    stmt.run({ id: "j1", type: "all", src: null, now });
    expect(() => stmt.run({ id: "j2", type: "all", src: null, now })).toThrow();
    db.close();
  });
});
