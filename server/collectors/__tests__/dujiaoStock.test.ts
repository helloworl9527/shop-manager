import { describe, it, expect } from "vitest";
import { collectDujiao } from "../dujiao";

const target = {
  sourceId: "s", sourceName: "gemini91.shop",
  sourceUrl: "https://gemini91.shop/", baseUrl: "https://gemini91.shop",
};
const http = (data: unknown[]) => ({
  fetchJson: async () => ({ status_code: 0, msg: "success", data }),
  postJson: async () => ({}),
  fetchText: async () => "",
}) as any;

const run = (data: unknown[]) => collectDujiao(target as any, http(data));

describe("独角数卡的库存判定", () => {
  it("人工发货 + 不限量：auto=0 不该把它判成缺货", async () => {
    // 线上真实结构（gemini91.shop 的「Claude Kyc服务」）：product 说 unlimited / manual=-1，
    // 而 sku 的 auto_stock_available 是 0——照搬 auto 就会误判缺货并从前台消失。
    const offers = await run([{
      id: 3, slug: "cckyc", title: { "zh-CN": "Claude Kyc服务" },
      price_amount: "35.00", is_sold_out: false, stock_status: "unlimited",
      manual_stock_available: -1, auto_stock_available: 0, fulfillment_type: "manual",
      skus: [{ id: 1, price_amount: "35.00", auto_stock_available: 0 }],
    }]);
    expect(offers).toHaveLength(1);
    expect(offers[0]!.sourceTitle).toBe("Claude Kyc服务");
    expect(offers[0]!.price).toBe(35);
    expect(offers[0]!.status).toBe("in_stock");
    expect(offers[0]!.stockCount).toBeNull(); // 不限量不写 -1
  });

  it("库存 -1 也表示不限量", async () => {
    const offers = await run([{
      slug: "a", title: { "zh-CN": "人工服务" }, price_amount: "10.00",
      fulfillment_type: "manual", manual_stock_available: -1, auto_stock_available: 0,
    }]);
    expect(offers[0]!.status).toBe("in_stock");
  });

  it("自动发货照旧按 auto 库存判，多 SKU 各判各的", async () => {
    const offers = await run([{
      slug: "max20", title: { "zh-CN": "Claude max20 质保订阅" }, price_amount: "455.00",
      stock_status: "low_stock", fulfillment_type: "auto", auto_stock_available: 5, manual_stock_available: 0,
      skus: [
        { id: 1, price_amount: "455.00", auto_stock_available: 2 },
        { id: 2, price_amount: "450.00", auto_stock_available: 0 },
        { id: 3, price_amount: "9999.00", auto_stock_available: 3 },
      ],
    }]);
    expect(offers.map((o) => [o.price, o.status])).toEqual([
      [455, "low_stock"], [450, "out_of_stock"], [9999, "low_stock"],
    ]);
  });

  it("明确售罄的仍然是缺货，不被 unlimited 覆盖", async () => {
    expect((await run([{
      slug: "b", title: { "zh-CN": "已售罄" }, price_amount: "1.00",
      is_sold_out: true, stock_status: "unlimited", fulfillment_type: "manual", manual_stock_available: -1,
    }]))[0]!.status).toBe("out_of_stock");
    expect((await run([{
      slug: "c", title: { "zh-CN": "缺货" }, price_amount: "1.00",
      stock_status: "out_of_stock", fulfillment_type: "manual", manual_stock_available: -1,
    }]))[0]!.status).toBe("out_of_stock");
  });

  it("人工发货但 manual 字段缺失时回退到 auto，不至于凭空当成有货", async () => {
    expect((await run([{
      slug: "d", title: { "zh-CN": "人工但没填 manual" }, price_amount: "1.00",
      fulfillment_type: "manual", auto_stock_available: 0,
    }]))[0]!.status).toBe("out_of_stock");
  });
});
