import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openDatabase, type SqliteDatabase } from "../connection";
import { applySchema } from "../init";
import { upsertSource, setSourceFavorite, getSource, deleteSource } from "../repo";
import {
  addFavoriteStore, listFavoriteStores, listFavoriteStoreCategories,
  updateFavoriteStore, removeFavoriteStore, findFavoriteStoreByUrl,
} from "../favoriteStores";

let db: SqliteDatabase;
beforeEach(() => {
  db = openDatabase(":memory:");
  applySchema(db);
});
afterEach(() => db.close());

describe("收藏店铺链接", () => {
  it("新增、去重、分类归一", () => {
    const a = addFavoriteStore(db, { url: "https://pay.ldxp.cn/shop/pdxai", name: "派大星Ai", category: " AI 会员 " });
    expect(a.created).toBe(true);
    expect(a.row.category).toBe("AI 会员");

    // 同一链接再收藏不重复插入
    const again = addFavoriteStore(db, { url: "https://pay.ldxp.cn/shop/pdxai", name: "别的名字" });
    expect(again.created).toBe(false);
    expect(listFavoriteStores(db)).toHaveLength(1);
    expect(again.row.name).toBe("派大星Ai"); // 不覆盖已有名字

    // 空字符串与「未分类」都存 NULL，避免前台分出两组
    expect(addFavoriteStore(db, { url: "https://a.cn/", name: "A", category: "  " }).row.category).toBeNull();
    expect(addFavoriteStore(db, { url: "https://b.cn/", name: "B", category: "未分类" }).row.category).toBeNull();
  });

  it("二次收藏时显式传分类会更新，不传则保持不变", () => {
    addFavoriteStore(db, { url: "https://a.cn/", name: "A" });
    expect(addFavoriteStore(db, { url: "https://a.cn/", name: "A", category: "发卡" }).row.category).toBe("发卡");
    // 不传 category（★ 同步走的就是这条路）不能把已设好的分类抹掉
    expect(addFavoriteStore(db, { url: "https://a.cn/", name: "A" }).row.category).toBe("发卡");
    // 显式传空 = 移出分类
    expect(addFavoriteStore(db, { url: "https://a.cn/", name: "A", category: "" }).row.category).toBeNull();
  });

  it("列表按分类排序，未分类排最后", () => {
    addFavoriteStore(db, { url: "https://z.cn/", name: "Z" });
    addFavoriteStore(db, { url: "https://b.cn/", name: "B", category: "发卡" });
    addFavoriteStore(db, { url: "https://a.cn/", name: "A", category: "AI" });
    expect(listFavoriteStores(db).map((r) => r.category)).toEqual(["AI", "发卡", null]);
    expect(listFavoriteStoreCategories(db)).toEqual(["AI", "发卡"]);
  });

  it("手动改名后 name_source 变 manual，之后不该被自动探测覆盖", () => {
    const { row } = addFavoriteStore(db, { url: "https://a.cn/", name: "a.cn" });
    expect(row.name_source).toBe("auto");
    expect(updateFavoriteStore(db, row.id, { name: "  老王的店  " })!.name).toBe("老王的店");
    expect(updateFavoriteStore(db, row.id, {})!.name_source).toBe("manual");
  });

  it("改名不接受空值", () => {
    const { row } = addFavoriteStore(db, { url: "https://a.cn/", name: "A" });
    expect(() => updateFavoriteStore(db, row.id, { name: "   " })).toThrow(/名称不能为空/);
  });
});

describe("与后台 ★ 的同步", () => {
  const addSource = (id: string, url: string, name: string) =>
    upsertSource(db, { id, name, entryUrl: url, collectorKind: "shopApi" });

  it("★ 会出现在收藏页，取消 ★ 会消失", () => {
    addSource("s1", "https://pay.ldxp.cn/shop/grok", "grok 小店");
    setSourceFavorite(db, "s1", true);
    const list = listFavoriteStores(db);
    expect(list).toHaveLength(1);
    expect(list[0]!.collected).toBe(true);
    expect(list[0]!.source_id).toBe("s1");

    setSourceFavorite(db, "s1", false);
    expect(listFavoriteStores(db)).toHaveLength(0);
  });

  it("手动收藏过的链接被 ★ 时认领而不是插重复", () => {
    addFavoriteStore(db, { url: "https://pay.ldxp.cn/shop/grok", name: "我先收的", category: "AI" });
    addSource("s1", "https://pay.ldxp.cn/shop/grok", "grok 小店");
    setSourceFavorite(db, "s1", true);
    const list = listFavoriteStores(db);
    expect(list).toHaveLength(1);
    expect(list[0]!.name).toBe("我先收的");   // 不覆盖用户已有的名字
    expect(list[0]!.category).toBe("AI");     // 也不丢分类
    expect(list[0]!.collected).toBe(true);
  });

  it("从收藏页移除 ★ 来的那条，返回 source_id 供调用方熄灭星标", () => {
    addSource("s1", "https://a.cn/", "A");
    setSourceFavorite(db, "s1", true);
    const id = listFavoriteStores(db)[0]!.id;
    expect(removeFavoriteStore(db, id)).toEqual({ removed: true, sourceId: "s1" });
    expect(removeFavoriteStore(db, id)).toEqual({ removed: false, sourceId: null });
  });

  it("删掉采集店铺，收藏链接仍保留（降级为普通书签）", () => {
    addSource("s1", "https://a.cn/", "A");
    setSourceFavorite(db, "s1", true);
    deleteSource(db, "s1", true);
    const list = listFavoriteStores(db);
    expect(list).toHaveLength(1);
    expect(list[0]!.source_id).toBeNull();
    expect(list[0]!.collected).toBe(false);
  });

  it("老库里已有的 ★ 会被迁移进来，且重复执行不会翻倍", () => {
    addSource("s1", "https://old.cn/", "老收藏");
    db.prepare("UPDATE sources SET favorite=1 WHERE id='s1'").run();
    db.prepare("DELETE FROM favorite_stores").run();   // 模拟迁移前的老库
    applySchema(db);
    expect(findFavoriteStoreByUrl(db, "https://old.cn/")?.source_id).toBe("s1");
    applySchema(db);
    expect(listFavoriteStores(db)).toHaveLength(1);
  });
});
