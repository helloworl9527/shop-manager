import { describe, it, expect } from "vitest";
import { collectAihaotanApi } from "../aihaotanApi";

const PAGE = 96; // 对方 limit 硬顶

const target = (extra: Record<string, unknown> = {}) => ({
  sourceId: "src-aihaotan", sourceName: "AI号探",
  sourceUrl: "https://www.aihaotan.com/", baseUrl: "https://www.aihaotan.com/", ...extra,
}) as any;

/** 造一条 aihaotan 形状的商品行 */
const goods = (o: Record<string, unknown> = {}) => ({
  guid: "guid-x", key: "aaa", shopKey: "TOKEN1",
  title: "GPT Plus 成品号", shopName: "某某小店",
  shopUrl: "https://pay.ldxp.cn/shop/TOKEN1",
  linkUrl: "https://pay.ldxp.cn/item/aaa",
  price: 12.5, stock: 20, updateTime: "2026-08-21", ...o,
});

const fullPage = (prefix: string) =>
  Array.from({ length: PAGE }, (_, i) => goods({ linkUrl: `https://pay.ldxp.cn/item/${prefix}-${i}` }));

function fakeHttp(opts: { shops?: any[]; pages: any[][]; shopsFail?: boolean }) {
  const calls: string[] = [];
  return {
    calls,
    http: {
      fetchJson: async (raw: string) => {
        calls.push(raw);
        const url = new URL(raw);
        if (url.pathname === "/api/shops") {
          if (opts.shopsFail) throw new Error("boom");
          return opts.shops ?? [];
        }
        const offset = Number(url.searchParams.get("offset") ?? 0);
        return opts.pages[offset / PAGE] ?? [];
      },
      postJson: async () => ({}),
      fetchText: async () => "",
    } as any,
  };
}

describe("aihaotan 聚合采集器", () => {
  it("满页才继续翻，未满即止", async () => {
    const { http } = fakeHttp({ pages: [fullPage("p0"), [goods({ linkUrl: "https://pay.ldxp.cn/item/last" })]] });
    const offers = await collectAihaotanApi(target(), http);
    expect(offers).toHaveLength(PAGE + 1);
    expect(offers.at(-1)!.url).toBe("https://pay.ldxp.cn/item/last");
  });

  it("跳过本机已直采的店铺（子域不同也认得出来）", async () => {
    const { http } = fakeHttp({ pages: [[
      goods({ linkUrl: "https://pay.ldxp.cn/item/1", shopUrl: "https://www.ldxp.cn/shop/MINE" }),
      goods({ linkUrl: "https://pay.ldxp.cn/item/2", shopUrl: "https://www.ldxp.cn/shop/theirs" }),
    ]] });
    const offers = await collectAihaotanApi(target({ knownStoreUrls: ["https://pay.ldxp.cn/shop/mine"] }), http);
    expect(offers.map((o) => o.url)).toEqual(["https://pay.ldxp.cn/item/2"]);
  });

  it("没传 knownStoreUrls 时全收，不误伤", async () => {
    const { http } = fakeHttp({ pages: [[goods(), goods({ linkUrl: "https://pay.ldxp.cn/item/2" })]] });
    expect(await collectAihaotanApi(target(), http)).toHaveLength(2);
  });

  it("翻页漂移导致同一条出现在两页时只收一次", async () => {
    const dup = goods({ linkUrl: "https://pay.ldxp.cn/item/dup" });
    const { http } = fakeHttp({ pages: [[...fullPage("p0").slice(0, PAGE - 1), dup], [dup]] });
    const offers = await collectAihaotanApi(target(), http);
    expect(offers.filter((o) => o.url === "https://pay.ldxp.cn/item/dup")).toHaveLength(1);
  });

  it("店铺名逐条带上——几百家店共用一个 source_id，靠它前台才数得对「在售家数」", async () => {
    const { http } = fakeHttp({ pages: [[
      goods({ linkUrl: "https://pay.ldxp.cn/item/1", shopName: "甲店" }),
      goods({ linkUrl: "https://pay.ldxp.cn/item/2", shopName: "  乙店  " }),
    ]] });
    expect((await collectAihaotanApi(target(), http)).map((o) => o.sourceStoreName)).toEqual(["甲店", "乙店"]);
  });

  it("店名为空时留 undefined，让上层回退，而不是写个空串进库", async () => {
    const { http } = fakeHttp({ pages: [[goods({ shopName: "" })]] });
    expect((await collectAihaotanApi(target(), http))[0]!.sourceStoreName).toBeUndefined();
  });

  it("外部键留空走 URL，不用对方的 guid（一漂移就整批下架再整批新增）", async () => {
    const { http } = fakeHttp({ pages: [[goods({ guid: "guid-会变的" })]] });
    expect((await collectAihaotanApi(target(), http))[0]!.externalKey).toBeNull();
  });

  it("按真实库存数字判状态（对方只收有货商品，不存在无限库存记 0 的坑）", async () => {
    const { http } = fakeHttp({ pages: [[
      goods({ linkUrl: "https://pay.ldxp.cn/item/1", stock: 1 }),
      goods({ linkUrl: "https://pay.ldxp.cn/item/2", stock: 3 }),
      goods({ linkUrl: "https://pay.ldxp.cn/item/3", stock: 4 }),
    ]] });
    const offers = await collectAihaotanApi(target(), http);
    expect(offers.map((o) => o.status)).toEqual(["low_stock", "low_stock", "in_stock"]);
    expect(offers.map((o) => o.stockCount)).toEqual([1, 3, 4]);
  });

  it("缺价 / 缺链接 / 不可比标题的行丢掉", async () => {
    const { http } = fakeHttp({ pages: [[
      goods({ linkUrl: "https://pay.ldxp.cn/item/ok" }),
      goods({ linkUrl: "https://pay.ldxp.cn/item/np", price: null }),
      goods({ linkUrl: "", title: "没链接" }),
      goods({ linkUrl: "https://pay.ldxp.cn/item/nt", title: "" }),
    ]] });
    expect((await collectAihaotanApi(target(), http)).map((o) => o.url)).toEqual(["https://pay.ldxp.cn/item/ok"]);
  });

  it("平台标签从 /api/shops 补上", async () => {
    const { http } = fakeHttp({ shops: [{ key: "TOKEN1", platform: "LDXP" }], pages: [[goods()]] });
    expect((await collectAihaotanApi(target(), http))[0]!.tags).toEqual(["LDXP"]);
  });

  it("/api/shops 挂了也照采，只是没有平台标签", async () => {
    const { http } = fakeHttp({ shopsFail: true, pages: [[goods()]] });
    const offers = await collectAihaotanApi(target(), http);
    expect(offers).toHaveLength(1);
    expect(offers[0]!.tags).toEqual([]);
  });
});
