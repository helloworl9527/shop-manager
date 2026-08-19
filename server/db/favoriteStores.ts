import { randomUUID } from "node:crypto";
import type { SqliteDatabase } from "./connection";
import { nowIso } from "./repo";

// 收藏的店铺链接。与「采集店铺」(sources) 是两回事：收藏只记住入口，不参与任何采集。
// source_id 非空表示这条是后台给采集店铺点 ★ 同步过来的，前台会显示 ★ 标记。

export interface FavoriteStoreRow {
  id: string;
  url: string;
  name: string;
  name_source: string;
  category: string | null;
  note: string | null;
  source_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface FavoriteStoreView extends FavoriteStoreRow {
  /** 同时也是采集店铺（后台 ★ 来的） */
  collected: boolean;
}

const UNCATEGORIZED = "未分类";

function newId(): string {
  return `fs-${randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

/** 空字符串一律存 NULL，避免「未分类」和「""」在前台分成两组。 */
function normalizeCategory(value: unknown): string | null {
  const text = String(value ?? "").trim();
  if (!text || text === UNCATEGORIZED) return null;
  return text.slice(0, 40);
}

export function listFavoriteStores(db: SqliteDatabase): FavoriteStoreView[] {
  return (db
    .prepare(
      `SELECT * FROM favorite_stores
       ORDER BY CASE WHEN category IS NULL THEN 1 ELSE 0 END, category COLLATE NOCASE, created_at DESC`,
    )
    .all() as FavoriteStoreRow[]).map((row) => ({ ...row, collected: row.source_id != null }));
}

/** 现有分类，供前台下拉补全。 */
export function listFavoriteStoreCategories(db: SqliteDatabase): string[] {
  return (db
    .prepare("SELECT DISTINCT category FROM favorite_stores WHERE category IS NOT NULL ORDER BY category COLLATE NOCASE")
    .all() as { category: string }[]).map((r) => r.category);
}

export function getFavoriteStore(db: SqliteDatabase, id: string): FavoriteStoreRow | undefined {
  return db.prepare("SELECT * FROM favorite_stores WHERE id=?").get(id) as FavoriteStoreRow | undefined;
}

export function findFavoriteStoreByUrl(db: SqliteDatabase, url: string): FavoriteStoreRow | undefined {
  return db.prepare("SELECT * FROM favorite_stores WHERE url=?").get(url) as FavoriteStoreRow | undefined;
}

/**
 * 新增收藏。url 已存在时不重复插入。
 *
 * `category` 只有在调用方显式传了才会写：传 undefined 表示「不动分类」——
 * ★ 同步走的正是这条路，不区分的话每次点 ★ 都会把用户设好的分类抹成 NULL。
 */
export function addFavoriteStore(
  db: SqliteDatabase,
  input: { url: string; name: string; nameSource?: string; category?: unknown; note?: string | null; sourceId?: string | null },
): { row: FavoriteStoreRow; created: boolean } {
  const existing = findFavoriteStoreByUrl(db, input.url);
  if (existing) {
    if (input.category !== undefined) updateFavoriteStore(db, existing.id, { category: input.category });
    return { row: getFavoriteStore(db, existing.id)!, created: false };
  }
  const category = normalizeCategory(input.category);
  const at = nowIso();
  const id = newId();
  db.prepare(
    `INSERT INTO favorite_stores (id, url, name, name_source, category, note, source_id, created_at, updated_at)
     VALUES (@id, @url, @name, @nameSource, @category, @note, @sourceId, @at, @at)`,
  ).run({
    id, url: input.url, name: input.name, nameSource: input.nameSource ?? "auto",
    category, note: input.note ?? null, sourceId: input.sourceId ?? null, at,
  });
  return { row: getFavoriteStore(db, id)!, created: true };
}

export function updateFavoriteStore(
  db: SqliteDatabase,
  id: string,
  patch: Partial<{ name: string; category: unknown; note: string | null }>,
): FavoriteStoreRow | undefined {
  const sets: string[] = [];
  const params: Record<string, unknown> = { id, at: nowIso() };
  if (patch.name !== undefined) {
    const name = String(patch.name).trim();
    if (!name) throw Object.assign(new Error("名称不能为空"), { statusCode: 400 });
    sets.push("name=@name", "name_source='manual'"); // 手动改过就别再被自动探测覆盖
    params.name = name.slice(0, 120);
  }
  if (patch.category !== undefined) {
    sets.push("category=@category");
    params.category = normalizeCategory(patch.category);
  }
  if (patch.note !== undefined) {
    sets.push("note=@note");
    params.note = patch.note === null ? null : String(patch.note).slice(0, 500);
  }
  if (!sets.length) return getFavoriteStore(db, id);
  db.prepare(`UPDATE favorite_stores SET ${sets.join(", ")}, updated_at=@at WHERE id=@id`).run(params);
  return getFavoriteStore(db, id);
}

/** 删除收藏。返回被解除关联的采集店铺 id（调用方需同步清掉 sources.favorite）。 */
export function removeFavoriteStore(db: SqliteDatabase, id: string): { removed: boolean; sourceId: string | null } {
  const row = getFavoriteStore(db, id);
  if (!row) return { removed: false, sourceId: null };
  db.prepare("DELETE FROM favorite_stores WHERE id=?").run(id);
  return { removed: true, sourceId: row.source_id };
}

/**
 * 后台 ★ / 取消 ★ 时同步收藏列表。
 * 取消 ★ 只删「由 ★ 产生的」那条：用户若另外手动收藏过同一链接，不该被连带删掉——
 * 但两者 url 相同、受唯一约束限制本就只有一条，故按 source_id 精确定位。
 */
export function syncFavoriteStoreForSource(
  db: SqliteDatabase,
  source: { id: string; name: string; entry_url: string; name_source: string | null },
  favorite: boolean,
): void {
  if (!favorite) {
    db.prepare("DELETE FROM favorite_stores WHERE source_id=?").run(source.id);
    return;
  }
  const existing = findFavoriteStoreByUrl(db, source.entry_url);
  if (existing) {
    // 同一链接已被手动收藏过 → 认领它，而不是插一条重复的（url 有唯一约束）
    if (!existing.source_id) {
      db.prepare("UPDATE favorite_stores SET source_id=@sid, updated_at=@at WHERE id=@id")
        .run({ sid: source.id, id: existing.id, at: nowIso() });
    }
    return;
  }
  addFavoriteStore(db, {
    url: source.entry_url,
    name: source.name,
    nameSource: source.name_source ?? "auto",
    sourceId: source.id,
  });
}
