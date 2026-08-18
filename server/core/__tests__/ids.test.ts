import { describe, it, expect } from "vitest";
import { urlCanonical, resolveExternalKey, buildOfferId, withVariant, normalizeKeyFromTitle } from "../ids";

describe("urlCanonical", () => {
  it("去掉 tracking 参数与 fragment、尾斜杠", () => {
    expect(urlCanonical("https://Shop.COM/item/1/?utm=ad&ref=x#frag")).toBe("https://shop.com/item/1");
  });
  it("保留白名单 id 参数（commodity）", () => {
    expect(urlCanonical("https://x.com/?commodity=123&utm=a")).toBe("https://x.com?commodity=123");
  });
  it("非法 url 退化为小写 trim", () => {
    expect(urlCanonical("  NotAUrl ")).toBe("notaurl");
  });
});

describe("resolveExternalKey 优先级", () => {
  it("优先用采集器外部键", () => {
    expect(resolveExternalKey({ externalKey: "goods-9", url: "https://x/item/1", title: "t" })).toBe("goods-9");
  });
  it("无外部键时用 url_canonical", () => {
    expect(resolveExternalKey({ externalKey: null, url: "https://x/item/1?utm=a", title: "t" })).toBe("https://x/item/1");
  });
  it("都没有时用标题", () => {
    expect(resolveExternalKey({ externalKey: "", url: "", title: "  ChatGPT  Plus " })).toBe("chatgpt plus");
  });
});

describe("buildOfferId 稳定性", () => {
  it("同 source+key 稳定、同 key 不同 source 不同", () => {
    const a = buildOfferId("s1", "k1");
    expect(a).toBe(buildOfferId("s1", "k1"));
    expect(a).not.toBe(buildOfferId("s2", "k1"));
  });
  it("店铺改名不影响 id（id 以 source_id 为前缀，不含 source_name）", () => {
    // 同 sourceId、同 externalKey → 同 id（与店铺显示名无关）
    expect(buildOfferId("src", "goods-1")).toBe(buildOfferId("src", "goods-1"));
  });
});

describe("withVariant 多 SKU", () => {
  it("有 variant 时拼接 #", () => expect(withVariant("slug", "sku-2")).toBe("slug#sku-2"));
  it("无 variant 时保持 productKey", () => expect(withVariant("slug", null)).toBe("slug"));
  it("dujiao 两个 SKU 同 product → 不同外部键 → 不同 id", () => {
    const id1 = buildOfferId("s", withVariant("p1", "skuA"));
    const id2 = buildOfferId("s", withVariant("p1", "skuB"));
    expect(id1).not.toBe(id2);
  });
});

describe("normalizeKeyFromTitle", () => {
  it("小写+压空格", () => expect(normalizeKeyFromTitle("  GPT   Plus ")).toBe("gpt plus"));
});
