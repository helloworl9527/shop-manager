import { describe, it, expect } from "vitest";
import { collectPriceaiApi, priceaiStoreIdentity } from "../priceaiApi";

const PAGE = 200;

const target = (extra: Record<string, unknown> = {}) => ({
  sourceId: "src-priceai", sourceName: "PriceAI",
  sourceUrl: "https://priceai.cc/", baseUrl: "https://priceai.cc/", ...extra,
}) as any;

/** 造一条 priceai 形状的报价行 */
const row = (o: Record<string, unknown> = {}) => ({
  offer: {
    id: "id-x", price: 1, status: "in_stock", stockCount: 5,
    url: "https://pay.ldxp.cn/item/aaa", shopUrl: "https://www.ldxp.cn/shop/TOKEN1",
    sourceTitle: "GPT Plus 成品号", sourceStoreName: "某某小店", tags: [], ...o,
  },
  product: { platform: "ChatGPT", productType: "成品账号", spec: "Plus" },
});

/** 填满一页，用于验证「满页才继续翻」的翻页逻辑 */
const fullPage = (prefix: string) =>
  Array.from({ length: PAGE }, (_, i) => row({ url: `https://pay.ldxp.cn/item/${prefix}-${i}` }));

function fakeHttp(opts: { platforms?: string[]; pages: Record<string, any[][]> }) {
  const calls: string[] = [];
  return {
    calls,
    http: {
      fetchJson: async (raw: string) => {
        calls.push(raw);
        const url = new URL(raw);
        if (url.pathname === "/api/merchants") {
          return { rows: (opts.platforms ?? []).map((p) => ({ platforms: [p] })), total: (opts.platforms ?? []).length };
        }
        const platform = url.searchParams.get("platform") ?? "";
        const offset = Number(url.searchParams.get("offset") ?? 0);
        const pages = opts.pages[platform] ?? [];
        const batch = pages[offset / PAGE] ?? [];
        const total = pages.reduce((n, p) => n + p.length, 0);
        return { rows: batch, total, limited: offset + batch.length < total };
      },
      postJson: async () => ({}),
      fetchText: async () => "",
    } as any,
  };
}

describe("店铺身份（去重的判定依据）", () => {
  it("子域不同也要认成同一家——我们存 pay.ldxp.cn，对方给 www.ldxp.cn", () => {
    expect(priceaiStoreIdentity("https://pay.ldxp.cn/shop/2VWX76A4", "")).toBe("ldxp.cn|2vwx76a4");
    expect(priceaiStoreIdentity("https://www.ldxp.cn/shop/2vwx76a4", "https://pay.ldxp.cn/item/x"))
      .toBe("ldxp.cn|2vwx76a4");
  });

  it("整站入口没有 token，身份只到域名", () => {
    expect(priceaiStoreIdentity("https://shop.azx.us/", "https://shop.azx.us/")).toBe("azx.us|");
  });

  it("不同店铺不会撞在一起", () => {
    expect(priceaiStoreIdentity("https://www.ldxp.cn/shop/aaa", ""))
      .not.toBe(priceaiStoreIdentity("https://www.ldxp.cn/shop/bbb", ""));
  });
});

describe("priceai 聚合采集器", () => {
  it("按平台分片扫，各片结果合并", async () => {
    const { http, calls } = fakeHttp({
      platforms: ["ChatGPT", "Claude"],
      pages: {
        ChatGPT: [[row({ url: "https://a.cn/item/1" })]],
        Claude: [[row({ url: "https://a.cn/item/2" })]],
      },
    });
    const offers = await collectPriceaiApi(target(), http);
    expect(offers.map((o) => o.url)).toEqual(["https://a.cn/item/1", "https://a.cn/item/2"]);
    expect(calls.some((c) => c.includes("platform=ChatGPT"))).toBe(true);
    expect(calls.some((c) => c.includes("platform=Claude"))).toBe(true);
  });

  it("满页才继续翻，未满即止（对方 offset 上限 5000，靠这个自然收敛）", async () => {
    const { http } = fakeHttp({
      platforms: ["ChatGPT"],
      pages: { ChatGPT: [fullPage("p0"), [row({ url: "https://a.cn/item/last" })]] },
    });
    const offers = await collectPriceaiApi(target(), http);
    expect(offers).toHaveLength(PAGE + 1);
    expect(offers.at(-1)!.url).toBe("https://a.cn/item/last");
  });

  it("跳过本机已直采的店铺，且传进来的是原始入口 URL", async () => {
    const { http } = fakeHttp({
      platforms: ["ChatGPT"],
      pages: { ChatGPT: [[
        row({ url: "https://pay.ldxp.cn/item/1", shopUrl: "https://www.ldxp.cn/shop/MINE" }),
        row({ url: "https://pay.ldxp.cn/item/2", shopUrl: "https://www.ldxp.cn/shop/theirs" }),
      ]] },
    });
    const offers = await collectPriceaiApi(
      target({ knownStoreUrls: ["https://pay.ldxp.cn/shop/mine"] }),
      http,
    );
    expect(offers.map((o) => o.url)).toEqual(["https://pay.ldxp.cn/item/2"]);
  });

  it("没传 knownStoreUrls 时全收，不误伤", async () => {
    const { http } = fakeHttp({ platforms: ["ChatGPT"], pages: { ChatGPT: [[row(), row({ url: "https://a.cn/item/2" })]] } });
    expect(await collectPriceaiApi(target(), http)).toHaveLength(2);
  });

  it("同一条报价被归进两个平台时只收一次", async () => {
    const dup = row({ url: "https://a.cn/item/dup" });
    const { http } = fakeHttp({ platforms: ["ChatGPT", "其他"], pages: { ChatGPT: [[dup]], 其他: [[dup]] } });
    expect(await collectPriceaiApi(target(), http)).toHaveLength(1);
  });

  it("店铺名逐条带上——几百家店共用一个 source_id，靠它前台才数得对「在售家数」", async () => {
    const { http } = fakeHttp({
      platforms: ["ChatGPT"],
      pages: { ChatGPT: [[
        row({ url: "https://a.cn/item/1", sourceStoreName: "甲店" }),
        row({ url: "https://a.cn/item/2", sourceStoreName: "", sourceName: "乙来源" }),
      ]] },
    });
    expect((await collectPriceaiApi(target(), http)).map((o) => o.sourceStoreName)).toEqual(["甲店", "乙来源"]);
  });

  it("外部键留空走 URL，不用对方快照里的 offer.id（一漂移就整批下架）", async () => {
    const { http } = fakeHttp({ platforms: ["ChatGPT"], pages: { ChatGPT: [[row({ id: "id-会变的" })]] } });
    expect((await collectPriceaiApi(target(), http))[0]!.externalKey).toBeNull();
  });

  it("状态照抄快照", async () => {
    const { http } = fakeHttp({
      platforms: ["ChatGPT"],
      pages: { ChatGPT: [[
        row({ url: "https://a.cn/item/1", status: "out_of_stock" }),
        row({ url: "https://a.cn/item/2", status: "low_stock" }),
        row({ url: "https://a.cn/item/3", status: "in_stock" }),
      ]] },
    });
    expect((await collectPriceaiApi(target(), http)).map((o) => o.status))
      .toEqual(["out_of_stock", "low_stock", "in_stock"]);
  });

  it("缺价 / 缺链接 / 不可比标题的行丢掉", async () => {
    const { http } = fakeHttp({
      platforms: ["ChatGPT"],
      pages: { ChatGPT: [[
        row({ url: "https://a.cn/item/ok" }),
        row({ url: "https://a.cn/item/np", price: null }),
        row({ url: "", sourceTitle: "没链接" }),
        row({ url: "https://a.cn/item/nt", sourceTitle: "" }),
      ]] },
    });
    expect((await collectPriceaiApi(target(), http)).map((o) => o.url)).toEqual(["https://a.cn/item/ok"]);
  });

  it("平台枚举取不到时退化为不分片，而不是整轮失败", async () => {
    const { http, calls } = fakeHttp({ platforms: [], pages: { "": [[row({ url: "https://a.cn/item/1" })]] } });
    expect(await collectPriceaiApi(target(), http)).toHaveLength(1);
    expect(calls.some((c) => c.includes("platform="))).toBe(false);
  });
});
