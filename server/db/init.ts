import "../load-env";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { openDatabase, type SqliteDatabase } from "./connection";
import { canonicalCatalog } from "../catalog/catalog";

const here = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = path.resolve(here, "schema.sql");

export function defaultDbPath(): string {
  return process.env.SHOP_DB_PATH || path.resolve(here, "shop.db");
}

/** 应用建表 SQL（幂等，全部 IF NOT EXISTS）。 */
export function applySchema(db: SqliteDatabase): void {
  migrateSourceFavoriteColumns(db);
  db.exec(readFileSync(SCHEMA_PATH, "utf8"));
  migrate(db);
}

function addColumn(db: SqliteDatabase, table: string, col: string, type: string) {
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
  } catch {
    /* 表或列已存在，忽略 */
  }
}

function migrateSourceFavoriteColumns(db: SqliteDatabase): void {
  addColumn(db, "sources", "favorite", "INTEGER NOT NULL DEFAULT 0");
  addColumn(db, "sources", "favorited_at", "TEXT");
}

function migrateSourceNameColumns(db: SqliteDatabase): void {
  addColumn(db, "sources", "name_source", "TEXT NOT NULL DEFAULT 'auto'");
}

/** 轻量迁移：对已存在的库补列（SQLite 无 ADD COLUMN IF NOT EXISTS，靠 try/catch 幂等）。 */
function migrate(db: SqliteDatabase): void {
  addColumn(db, "raw_offers", "stock_text", "TEXT");
  migrateSourceNameColumns(db);
  addColumn(db, "sources", "kind_detected_at", "TEXT");
  addColumn(db, "sources", "kind_evidence", "TEXT");
  migrateSourceFavoriteColumns(db);
  db.exec("CREATE INDEX IF NOT EXISTS idx_sources_favorite_at ON sources(favorite, favorited_at DESC)");
  backfillFavoriteStores(db);
  db.prepare(
    `UPDATE sources SET collection_method='http', updated_at=@at
     WHERE collection_method='browser' AND COALESCE(collector_kind, 'auto') != 'browser'`,
  ).run({ at: new Date().toISOString() });
  db.prepare(
    `UPDATE raw_offers
     SET effective_status='available',
         freshness_status='fresh',
         availability_rank=CASE
           WHEN status='in_stock' THEN 0
           WHEN status='low_stock' THEN 1
           WHEN status='out_of_stock' THEN 2
           ELSE availability_rank
         END,
         updated_at=@at
     WHERE freshness_status='expired' AND status != 'out_of_stock'`,
  ).run({ at: new Date().toISOString() });
}

/**
 * 把已有的 ★ 收藏店铺搬进 favorite_stores。
 * 收藏页改成统一读这张表后，不搬的话老收藏会凭空消失。幂等：靠 url 唯一约束忽略重复。
 */
function backfillFavoriteStores(db: SqliteDatabase): void {
  const at = new Date().toISOString();
  db.prepare(
    `INSERT OR IGNORE INTO favorite_stores (id, url, name, name_source, category, note, source_id, created_at, updated_at)
     SELECT 'fs-' || substr(lower(hex(randomblob(6))), 1, 12), entry_url, name, COALESCE(name_source, 'auto'),
            NULL, NULL, id, COALESCE(favorited_at, @at), @at
     FROM sources
     WHERE favorite=1 AND id NOT IN (SELECT source_id FROM favorite_stores WHERE source_id IS NOT NULL)`,
  ).run({ at });
}

/** 把分类目录写入 canonical_products（幂等 upsert）。 */
export function seedCanonicalProducts(db: SqliteDatabase): number {
  const now = new Date().toISOString();
  const stmt = db.prepare(
    `INSERT INTO canonical_products
       (id, slug, display_name, platform, product_type, spec, summary, aliases, is_active, created_at, updated_at)
     VALUES
       (@id, @slug, @display_name, @platform, @product_type, @spec, @summary, @aliases, 1, @now, @now)
     ON CONFLICT(id) DO UPDATE SET
       slug = excluded.slug,
       display_name = excluded.display_name,
       platform = excluded.platform,
       product_type = excluded.product_type,
       spec = excluded.spec,
       summary = excluded.summary,
       aliases = excluded.aliases,
       is_active = 1,
       updated_at = excluded.updated_at`,
  );
  const run = db.transaction(() => {
    for (const product of canonicalCatalog) {
      stmt.run({
        id: product.id,
        slug: product.slug,
        display_name: product.displayName,
        platform: product.platform,
        product_type: product.productType,
        spec: product.spec,
        summary: product.summary,
        aliases: JSON.stringify(product.aliases),
        now,
      });
    }
  });
  run();
  const row = db.prepare("SELECT COUNT(*) AS n FROM canonical_products").get() as { n: number };
  return row.n;
}

/** 初始化数据库：建表 + 写入分类目录。 */
export function initDatabase(dbPath: string = defaultDbPath()): { dbPath: string; productCount: number } {
  const db = openDatabase(dbPath);
  try {
    applySchema(db);
    const productCount = seedCanonicalProducts(db);
    return { dbPath, productCount };
  } finally {
    db.close();
  }
}

const isMain = path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url);
if (isMain) {
  const result = initDatabase();
  console.log(`数据库初始化完成：${result.dbPath}`);
  console.log(`canonical_products 已写入 ${result.productCount} 条`);
  // 记录「安装/初始化时用的 node 绝对路径」，供门户跨启动上下文（.app/终端）固定同一架构的 node 启动后端
  try {
    const root = path.resolve(here, "../..");
    writeFileSync(path.join(root, ".node-path"), process.execPath);
    console.log(`已记录运行 node：${process.execPath}`);
  } catch { /* 忽略 */ }
}
