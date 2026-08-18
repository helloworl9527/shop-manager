import type { SqliteDatabase } from "./connection";
import { classifyOffer } from "../catalog/catalog";
import { nowIso } from "./repo";

/** 用最新规则重建所有 raw_offers 的自动分类（canonical_product_id / category_slug）。
 *  不动 manual_canonical_product_id；effective/search_group 生成列随之自动更新。 */
export function reclassifyAll(db: SqliteDatabase): { updated: number; distribution: Record<string, number> } {
  const rows = db.prepare("SELECT id, source_title, tags FROM raw_offers").all() as { id: string; source_title: string; tags: string }[];
  const stmt = db.prepare("UPDATE raw_offers SET canonical_product_id=@cid, category_slug=@slug, updated_at=@at WHERE id=@id");
  const at = nowIso();
  const distribution: Record<string, number> = {};
  let updated = 0;

  const run = db.transaction(() => {
    for (const r of rows) {
      let tags: string[] = [];
      try { const v = JSON.parse(r.tags || "[]"); if (Array.isArray(v)) tags = v; } catch { /* ignore */ }
      const c = classifyOffer(r.source_title, { tags });
      distribution[c.id] = (distribution[c.id] ?? 0) + 1;
      const info = stmt.run({ id: r.id, cid: c.id, slug: c.platform, at });
      updated += info.changes;
    }
  });
  run();
  return { updated, distribution };
}
