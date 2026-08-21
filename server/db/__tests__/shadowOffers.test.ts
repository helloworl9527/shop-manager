import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openDatabase, type SqliteDatabase } from "../connection";
import { applySchema } from "../init";
import { recomputeShadowedOffers, upsertSource } from "../repo";

let db: SqliteDatabase;
beforeEach(() => {
  db = openDatabase(":memory:");
  applySchema(db);
});
afterEach(() => {
  sources.clear();
  db.close();
});

const sources = new Set<string>();
function ensureSource(id: string) {
  if (sources.has(id)) return;
  upsertSource(db, { id, name: id, entryUrl: `https://${id}.test/`, baseUrl: `https://${id}.test` });
  sources.add(id);
}

/** 直接插行，绕开 upsertOffers 的 id 计算——这里要测的是遮蔽规则本身。 */
function insert(o: { id: string; source: string; url: string; verifiedAt: string | null; hidden?: number; title?: string }) {
  ensureSource(o.source);
  db.prepare(
    `INSERT INTO raw_offers (id, source_id, source_name, source_title, url, url_canonical, price, verified_at, hidden,
                             captured_at, last_seen_at, created_at, updated_at)
     VALUES (@id, @source, @source, @title, @url, @url, 1.0, @verifiedAt, @hidden,
             @t, @t, @t, @t)`,
  ).run({ ...o, title: o.title ?? `商品-${o.id}`, hidden: o.hidden ?? 0, t: "2026-08-21T00:00:00Z" });
}

const shadowed = () =>
  (db.prepare("SELECT id FROM raw_offers WHERE shadowed=1 ORDER BY id").all() as { id: string }[]).map((r) => r.id);

describe("跨源重复报价的遮蔽", () => {
  it("同一链接被两个源采到时，只留 verified_at 最新的那条", () => {
    insert({ id: "old", source: "priceai", url: "https://pay.ldxp.cn/item/a", verifiedAt: "2026-08-20T00:00:00Z" });
    insert({ id: "new", source: "aihaotan", url: "https://pay.ldxp.cn/item/a", verifiedAt: "2026-08-21T00:00:00Z" });
    expect(recomputeShadowedOffers(db)).toBe(1);
    expect(shadowed()).toEqual(["old"]);
  });

  it("同一个源内部同链接多行不参与去重——整店共用兜底 URL 的店铺那是多个真商品", () => {
    // 「昔尘数卡」采不到单品链接，13 个不同商品都挂在店铺入口 URL 上
    for (const n of ["a", "b", "c"]) {
      insert({ id: `same-${n}`, source: "xichen", url: "https://xichen.cn/", verifiedAt: "2026-08-20T00:00:00Z" });
    }
    expect(recomputeShadowedOffers(db)).toBe(0);
    expect(shadowed()).toEqual([]);
  });

  it("一边是兜底 URL 的多行、另一边是聚合源单行时，两边都保留（宁可重复也不能抹掉真商品）", () => {
    insert({ id: "x1", source: "xichen", url: "https://xichen.cn/", verifiedAt: "2026-08-20T00:00:00Z" });
    insert({ id: "x2", source: "xichen", url: "https://xichen.cn/", verifiedAt: "2026-08-20T00:00:00Z" });
    insert({ id: "agg", source: "aihaotan", url: "https://xichen.cn/", verifiedAt: "2026-08-21T00:00:00Z" });
    expect(recomputeShadowedOffers(db)).toBe(0);
  });

  it("三个源撞同一条链接时只留最新的一条", () => {
    insert({ id: "a", source: "s1", url: "https://a.cn/item/1", verifiedAt: "2026-08-19T00:00:00Z" });
    insert({ id: "b", source: "s2", url: "https://a.cn/item/1", verifiedAt: "2026-08-21T00:00:00Z" });
    insert({ id: "c", source: "s3", url: "https://a.cn/item/1", verifiedAt: "2026-08-20T00:00:00Z" });
    recomputeShadowedOffers(db);
    expect(shadowed()).toEqual(["a", "c"]);
  });

  it("verified_at 并列时按 id 定序，结果稳定（重算不会来回翻）", () => {
    insert({ id: "aaa", source: "s1", url: "https://a.cn/item/1", verifiedAt: "2026-08-21T00:00:00Z" });
    insert({ id: "bbb", source: "s2", url: "https://a.cn/item/1", verifiedAt: "2026-08-21T00:00:00Z" });
    recomputeShadowedOffers(db);
    expect(shadowed()).toEqual(["bbb"]);
    recomputeShadowedOffers(db);
    expect(shadowed()).toEqual(["bbb"]);
  });

  it("已下架(hidden)的行不参与，也不会因为它而漏掉可见行的去重", () => {
    insert({ id: "gone", source: "priceai", url: "https://a.cn/item/1", verifiedAt: "2026-08-22T00:00:00Z", hidden: 1 });
    insert({ id: "live1", source: "s1", url: "https://a.cn/item/1", verifiedAt: "2026-08-20T00:00:00Z" });
    insert({ id: "live2", source: "s2", url: "https://a.cn/item/1", verifiedAt: "2026-08-21T00:00:00Z" });
    recomputeShadowedOffers(db);
    // hidden 的那条虽然最新，但不该抢走保留名额
    expect(shadowed()).toEqual(["live1"]);
  });

  it("重算会清掉上一轮的标记——旧数据被新一轮反超时要能翻回来", () => {
    insert({ id: "a", source: "s1", url: "https://a.cn/item/1", verifiedAt: "2026-08-20T00:00:00Z" });
    insert({ id: "b", source: "s2", url: "https://a.cn/item/1", verifiedAt: "2026-08-21T00:00:00Z" });
    recomputeShadowedOffers(db);
    expect(shadowed()).toEqual(["a"]);

    // a 这一轮采到了更新的数据
    db.prepare("UPDATE raw_offers SET verified_at='2026-08-22T00:00:00Z' WHERE id='a'").run();
    recomputeShadowedOffers(db);
    expect(shadowed()).toEqual(["b"]);
  });

  it("不同链接互不影响", () => {
    insert({ id: "a", source: "s1", url: "https://a.cn/item/1", verifiedAt: "2026-08-20T00:00:00Z" });
    insert({ id: "b", source: "s2", url: "https://a.cn/item/2", verifiedAt: "2026-08-21T00:00:00Z" });
    expect(recomputeShadowedOffers(db)).toBe(0);
  });
});
