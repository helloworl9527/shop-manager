import { describe, it, expect } from "vitest";
import type { HttpClient } from "../../core/http";
import type { CollectorTarget } from "../types";
import { collectKami } from "../kami";
import { collectDujiao } from "../dujiao";
import { collectDujiaoHtml } from "../dujiaoHtml";
import { collectShopApi, isTransientShopApiError } from "../shopApi";
import { collectPublicProductsApi } from "../publicProductsApi";
import { collectGenericHtml } from "../genericHtml";
import { acquireProfileLock, buildInteractiveVerificationArgs, extractOffersInPage, isChallengeBlockedError, isCloudflareChallengeSnapshot, isProfileInUseMessage, waitForChallengeToClear, waitForContentSettled } from "../browser";
import { buildOfferId, resolveExternalKey } from "../../core/ids";
import { numberOrNull } from "../util";
import { detectCollector, resolveCollectorKind } from "../index";

describe("numberOrNull（库存/价格解析）", () => {
  it("数字与数字字符串正常", () => {
    expect(numberOrNull(133)).toBe(133);
    expect(numberOrNull("39")).toBe(39);
    expect(numberOrNull("¥1280")).toBe(1280);
  });
  it("中文/非数字字符串 → null（不是 0）", () => {
    expect(numberOrNull("非常多")).toBeNull(); // ifaka.app 的库存字段
    expect(numberOrNull("无限")).toBeNull();
    expect(numberOrNull("")).toBeNull();
    expect(numberOrNull(null)).toBeNull();
  });
});

describe("auto 探测识别采集器类型（不靠硬编码域名）", () => {
  it("URL 含 /shop/<token> → shopApi", async () => {
    expect(await resolveCollectorKind("auto", target({ sourceUrl: "https://x.test/shop/ABC" }), fakeHttp({}))).toBe("shopApi");
  });
  it("kami 接口有数据 → kami（如 faka.redeemgpt.com / ifaka.app 这类）", async () => {
    const http = fakeHttp({
      json: (url) => {
        if (url.includes("/user/api/index/commodity")) return { code: 200, data: [{ id: 1, name: "x", price: 1 }] };
        throw new Error("非 JSON/HTML");
      },
    });
    expect(await resolveCollectorKind("auto", target({ sourceUrl: "https://new-faka.test/" }), http)).toBe("kami");
  });
  it("dujiao 接口有数据 → dujiao", async () => {
    const http = fakeHttp({
      json: (url) => {
        if (url.includes("/api/v1/public/products")) return { data: [{ title: "x", price_amount: 1 }] };
        throw new Error("非 JSON");
      },
    });
    expect(await resolveCollectorKind("auto", target({ sourceUrl: "https://new-duj.test/" }), http)).toBe("dujiao");
  });
  it("都不中 → browser，不再落入 unsupported 死路", async () => {
    const http = fakeHttp({
      json: () => { throw new Error("HTML"); },
      text: () => "<html><title>普通页面</title><p>没有商品价格</p></html>",
    });
    expect(await resolveCollectorKind("auto", target({ sourceUrl: "https://unknown.test/" }), http)).toBe("browser");
  });
  it("注册表命中未实现采集器 → pending", async () => {
    expect(await resolveCollectorKind("auto", target({ sourceUrl: "https://upgrade.xiaoheiwan.com/" }), fakeHttp({}))).toBe("pending");
  });
  it("注册表命中 publicProductsApi + 试采成功 → 已实现采集器", async () => {
    const http = fakeHttp({
      json: () => ({
        data: [{ id: 1, slug: "plus", title: "ChatGPT Plus", price_amount: 30 }],
        pagination: { total_page: 1 },
      }),
    });
    expect(await resolveCollectorKind("auto", target({ sourceUrl: "https://pipboy.vip/", baseUrl: "https://pipboy.vip" }), http)).toBe("publicProductsApi");
  });
  it("显式类型不触发探测", async () => {
    expect(await resolveCollectorKind("dujiao", target(), fakeHttp({}))).toBe("dujiao");
  });
  it("独角 HTML 指纹可试采出报价 → dujiaoHtml，并复用试采结果", async () => {
    const listHtml = `
      <meta name="csrf-token" content="x">
      <div class="card position-relative"><h3>ChatGPT Plus</h3><span>¥30</span><span>库存:9</span><a href="/buy/101">购买</a></div>
      <div class="card position-relative"><h3>Claude Pro</h3><span>¥45</span><span>库存:2</span><a href="/buy/102">购买</a></div>
      <div class="card position-relative"><h3>Gemini Pro</h3><span>¥35</span><span>库存:5</span><a href="/buy/103">购买</a></div>
    `;
    const http = fakeHttp({
      json: () => { throw new Error("不是接口"); },
      text: (url) => url.includes("/buy/101") ? `selectSku('1个月','30')` : "",
    });
    const result = await detectCollector(target({ sourceUrl: "https://duj-html.test/", baseUrl: "https://duj-html.test" }), {
      ...http,
      async fetchText(url) { return url === "https://duj-html.test/" ? listHtml : http.fetchText(url); },
    });
    expect(result.kind).toBe("dujiaoHtml");
    expect(result.evidence).toMatch(/dujiaoHtml/);
    expect(result.offers?.length).toBeGreaterThan(0);
  });
  it("普通首页 HTML 可试采出报价 → genericHtml，并复用试采结果", async () => {
    const http = fakeHttp({
      json: () => { throw new Error("不是接口"); },
      text: () => `<div>ChatGPT Plus 月卡 ¥30 库存 9</div><div>Claude Pro 直充 ¥45 库存 2</div>`,
    });
    const result = await detectCollector(target({ sourceUrl: "https://html.test/", baseUrl: "https://html.test" }), http);
    expect(result.kind).toBe("genericHtml");
    expect(result.evidence).toMatch(/试采/);
    expect(result.offers?.length).toBeGreaterThan(0);
  });
  it("接口探测遇到 HTTP 403 不短路，继续瀑布直到 genericHtml", async () => {
    const http = fakeHttp({
      json: () => { throw new Error("returned HTTP 403"); },
      text: () => `<div>ChatGPT Plus 月卡 ¥30 库存 9</div><div>Claude Pro 直充 ¥45 库存 2</div>`,
    });
    const result = await detectCollector(target({ sourceUrl: "https://html-after-api-403.test/", baseUrl: "https://html-after-api-403.test" }), http);
    expect(result.kind).toBe("genericHtml");
    expect(result.attempts?.some((a) => a.step === "kami" && /403/.test(a.message ?? ""))).toBe(true);
  });
  it("首页探测遇到 HTTP 403 → browser，并保留接口探测线索", async () => {
    const http = fakeHttp({
      json: () => { throw new Error("returned HTTP 403"); },
      text: () => { throw new Error("returned HTTP 403"); },
    });
    const result = await detectCollector(target({ sourceUrl: "https://waf.test/", baseUrl: "https://waf.test" }), http);
    expect(result.kind).toBe("browser");
    expect(result.evidence).toMatch(/403/);
    expect(result.evidence).toMatch(/接口探测线索/);
  });
  it("本地覆盖优先于上游注册表，gemini91.shop 直接验证 dujiao", async () => {
    const calls: string[] = [];
    const http = fakeHttp({
      json: (url) => {
        calls.push(url);
        if (url.includes("/user/api/index/commodity")) throw new Error("不应再试过期 kami");
        if (url.includes("/api/v1/public/products")) return { data: [{ title: "Claude KYC服务", slug: "claude-kyc", price_amount: 35 }] };
        throw new Error("未知接口");
      },
    });
    const result = await detectCollector(target({ sourceUrl: "https://gemini91.shop/", baseUrl: "https://gemini91.shop" }), http);
    expect(result.kind).toBe("dujiao");
    expect(result.evidence).toMatch(/本地覆盖命中并验证/);
    expect(result.offers?.[0]?.sourceTitle).toBe("Claude KYC服务");
    expect(calls.some((url) => url.includes("/user/api/index/commodity"))).toBe(false);
  });
  it("上游注册表命中试采失败后继续瀑布，并跳过重复同类探测", async () => {
    const calls: string[] = [];
    const http = fakeHttp({
      json: (url) => {
        calls.push(url);
        if (url.includes("/user/api/index/commodity")) return { data: [] };
        if (url.includes("/api/v1/public/products")) return { data: [{ title: "Claude Pro", slug: "claude-pro", price_amount: 45 }] };
        throw new Error("未知接口");
      },
    });
    const result = await detectCollector(target({ sourceUrl: "https://faka.redeemgpt.com/", baseUrl: "https://faka.redeemgpt.com" }), http);
    expect(result.kind).toBe("dujiao");
    expect(result.attempts?.some((a) => a.step === "hostRegistry:kami" && !a.ok)).toBe(true);
    expect(result.attempts?.some((a) => a.step === "kami")).toBe(false);
    expect(calls.filter((url) => url.includes("/user/api/index/commodity"))).toHaveLength(1);
  });
  it("未知域名探测全局限流 ≤3", async () => {
    let active = 0;
    let maxActive = 0;
    const http = fakeHttp({
      json: async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 20));
        active -= 1;
        return { data: [{ id: 1, name: "x", price: 1 }] };
      },
    });
    await Promise.all(Array.from({ length: 8 }, (_, index) =>
      detectCollector(target({ sourceUrl: `https://limit-${index}.test/`, baseUrl: `https://limit-${index}.test` }), http),
    ));
    expect(maxActive).toBeLessThanOrEqual(3);
  });
});

const target = (over: Partial<CollectorTarget> = {}): CollectorTarget => ({
  sourceId: "s1",
  sourceName: "店",
  sourceUrl: "https://shop.test/shop/TKN",
  baseUrl: "https://shop.test",
  ...over,
});

function fakeHttp(handlers: {
  json?: (url: string) => any;
  text?: (url: string) => string;
  post?: (url: string, body: any) => any;
}): HttpClient {
  return {
    async fetchJson(url) { return handlers.json ? handlers.json(url) : {}; },
    async fetchText(url) { return handlers.text ? handlers.text(url) : ""; },
    async postJson(url, body) { return handlers.post ? handlers.post(url, body) : {}; },
  };
}

async function withFastShopApiRetry<T>(fn: () => Promise<T>): Promise<T> {
  const oldRetries = process.env.SHOP_API_RETRIES;
  const oldBackoff = process.env.SHOP_API_RETRY_BACKOFF_MS;
  process.env.SHOP_API_RETRIES = "2";
  process.env.SHOP_API_RETRY_BACKOFF_MS = "0,0";
  try {
    return await fn();
  } finally {
    if (oldRetries === undefined) delete process.env.SHOP_API_RETRIES;
    else process.env.SHOP_API_RETRIES = oldRetries;
    if (oldBackoff === undefined) delete process.env.SHOP_API_RETRY_BACKOFF_MS;
    else process.env.SHOP_API_RETRY_BACKOFF_MS = oldBackoff;
  }
}

describe("collectKami", () => {
  it("解析商品并带 externalKey=item.id", async () => {
    const http = fakeHttp({
      json: (url) =>
        url.includes("page=1")
          ? { data: [{ id: 7, name: "ChatGPT Plus 月卡", user_price: "30", stock: 50, status: 1, delivery_way: 0, category: { name: "GPT" } }] }
          : { data: [] },
    });
    const offers = await collectKami(target(), http);
    expect(offers).toHaveLength(1);
    expect(offers[0]).toMatchObject({ sourceTitle: "ChatGPT Plus 月卡", price: 30, status: "in_stock", externalKey: "7" });
    expect(offers[0]!.tags).toContain("自动发货");
  });
});

describe("collectDujiao 多 SKU", () => {
  it("一个 product 两个 SKU → 两条 offer、externalKey 含 variant 且 id 不同", async () => {
    const http = fakeHttp({
      json: () => ({
        data: [
          {
            title: "Gemini Pro", slug: "gemini-pro", fulfillment_type: "auto",
            skus: [
              { id: "m1", title: "1个月", price_amount: 20, auto_stock_available: 10 },
              { id: "m12", title: "12个月", price_amount: 180, auto_stock_available: 0, is_sold_out: true },
            ],
          },
        ],
      }),
    });
    const offers = await collectDujiao(target({ baseUrl: "https://duj.test" }), http);
    expect(offers).toHaveLength(2);
    expect(offers[0]!.externalKey).toBe("gemini-pro#m1");
    expect(offers[1]!.externalKey).toBe("gemini-pro#m12");
    expect(offers[1]!.status).toBe("out_of_stock");
    // 两个 SKU 的购买 URL 相同，但 id 因 externalKey 不同而不同
    expect(offers[0]!.url).toBe(offers[1]!.url);
    const id1 = buildOfferId("s1", resolveExternalKey({ externalKey: offers[0]!.externalKey, url: offers[0]!.url, title: offers[0]!.sourceTitle }));
    const id2 = buildOfferId("s1", resolveExternalKey({ externalKey: offers[1]!.externalKey, url: offers[1]!.url, title: offers[1]!.sourceTitle }));
    expect(id1).not.toBe(id2);
  });
});

describe("collectDujiaoHtml", () => {
  it("列表卡片 + 详情 selectSku → 多规格 offer，externalKey 含 buy/id + variant", async () => {
    const listHtml = `
      <meta name="csrf-token" content="x">
      <div class="card position-relative">
        <h3>Gemini Pro</h3><span>¥20</span><span>库存:8</span><a href="/buy/77">立即购买</a>
      </div>
    `;
    const detailHtml = `
      <script>
        selectSku('1个月', '20');
        selectSku("12个月", "180");
      </script>
      <div>自动发货 库存:8</div>
    `;
    const offers = await collectDujiaoHtml(target({ sourceUrl: "https://duj.test/", baseUrl: "https://duj.test" }), fakeHttp({
      text: (url) => url.includes("/buy/77") ? detailHtml : listHtml,
    }));
    expect(offers).toHaveLength(2);
    expect(offers[0]!.externalKey).toBe("buy/77#1个月");
    expect(offers[1]!.externalKey).toBe("buy/77#12个月");
    expect(offers[0]!.url).toBe("https://duj.test/buy/77");
  });
});

describe("collectShopApi", () => {
  it("token→info→categoryList→goodsList，externalKey=goods_key", async () => {
    const http = fakeHttp({
      post: (url) => {
        if (url.endsWith("/shopApi/Shop/info")) return { code: 1, data: { nickname: "金钥", link: "https://shop.test/shop/TKN" } };
        if (url.endsWith("/shopApi/Shop/categoryList")) return { data: [{ id: 1, goods_count: 2 }] };
        if (url.endsWith("/shopApi/Shop/goodsList")) return { data: { list: [{ name: "Plus 成品号", price: 30, goods_key: "gk1", status: 1, goods_type: "card", extend: { stock_count: 5, send_order: 0 } }] } };
        return {};
      },
    });
    const offers = await collectShopApi(target(), http);
    expect(offers).toHaveLength(1);
    expect(offers[0]).toMatchObject({ sourceTitle: "Plus 成品号", price: 30, externalKey: "gk1", sourceStoreName: "金钥" });
    expect(offers[0]!.url).toBe("https://shop.test/item/gk1");
  });

  it("无 token 抛错", async () => {
    await expect(collectShopApi(target({ sourceUrl: "https://shop.test/" }), fakeHttp({}))).rejects.toThrow(/token/);
  });

  it("goodsList 首次 500 后重试成功", async () => {
    await withFastShopApiRetry(async () => {
      let goodsCalls = 0;
      const http = fakeHttp({
        post: (url) => {
          if (url.endsWith("/shopApi/Shop/info")) return { code: 1, data: { nickname: "金钥", link: "https://shop.test/shop/TKN" } };
          if (url.endsWith("/shopApi/Shop/categoryList")) return { data: [{ id: 1, goods_count: 2 }] };
          if (url.endsWith("/shopApi/Shop/goodsList")) {
            goodsCalls += 1;
            if (goodsCalls === 1) throw new Error(`${url} returned HTTP 500`);
            return { data: { list: [{ name: "Plus 成品号", price: 30, goods_key: "gk1", status: 1, goods_type: "card", extend: { stock_count: 5, send_order: 0 } }] } };
          }
          return {};
        },
      });

      const offers = await collectShopApi(target(), http);

      expect(goodsCalls).toBe(2);
      expect(offers).toHaveLength(1);
    });
  });

  it("瞬时错误重试耗尽后抛出原错误", async () => {
    await withFastShopApiRetry(async () => {
      let goodsCalls = 0;
      const http = fakeHttp({
        post: (url) => {
          if (url.endsWith("/shopApi/Shop/info")) return { code: 1, data: { nickname: "金钥", link: "https://shop.test/shop/TKN" } };
          if (url.endsWith("/shopApi/Shop/categoryList")) return { data: [{ id: 1, goods_count: 2 }] };
          if (url.endsWith("/shopApi/Shop/goodsList")) {
            goodsCalls += 1;
            throw new Error(`${url} returned HTTP 500`);
          }
          return {};
        },
      });

      await expect(collectShopApi(target(), http)).rejects.toThrow(/HTTP 500/);
      expect(goodsCalls).toBe(3);
    });
  });

  it("403 风控错误不按 5xx 重试", async () => {
    await withFastShopApiRetry(async () => {
      let infoCalls = 0;
      const http = fakeHttp({
        post: (url) => {
          if (url.endsWith("/shopApi/Shop/info")) {
            infoCalls += 1;
            throw new Error(`${url} returned HTTP 403`);
          }
          return {};
        },
      });

      await expect(collectShopApi(target(), http)).rejects.toThrow(/HTTP 403/);
      expect(infoCalls).toBe(1);
    });
  });

  it("只把 429/5xx 和连接层错误识别为 shopApi 瞬时错误", () => {
    expect(isTransientShopApiError(new Error("returned HTTP 500"))).toBe(true);
    expect(isTransientShopApiError(new Error("fetch failed"))).toBe(true);
    expect(isTransientShopApiError(new Error("returned HTTP 403"))).toBe(false);
    expect(isTransientShopApiError(new Error("返回验证或风控页面"))).toBe(false);
  });
});

describe("collectPublicProductsApi", () => {
  it("/api/v1/public/products 分页商品 → offer，支持本地化标题和 SKU 库存", async () => {
    const http = fakeHttp({
      json: (url) => {
        expect(url).toContain("/api/v1/public/products");
        return {
          status_code: 0,
          data: [{
            id: 10,
            slug: "Indiaplus",
            title: { "zh-CN": "印度upi渠道plus成品号", "en-US": "" },
            price_amount: "8.50",
            tags: ["新鲜出炉"],
            fulfillment_type: "auto",
            stock_status: "in_stock",
            category: { name: { "zh-CN": "ChatGPT" } },
            skus: [{ id: 12, sku_code: "DEFAULT", price_amount: "8.50", auto_stock_available: 12, is_active: true }],
          }],
          pagination: { page: 1, page_size: 100, total: 1, total_page: 1 },
        };
      },
    });
    const offers = await collectPublicProductsApi(target({ sourceUrl: "https://pipboy.vip/", baseUrl: "https://pipboy.vip" }), http);
    expect(offers).toHaveLength(1);
    expect(offers[0]).toMatchObject({
      sourceTitle: "印度upi渠道plus成品号",
      price: 8.5,
      status: "in_stock",
      stockCount: 12,
      url: "https://pipboy.vip/products/Indiaplus",
      externalKey: "Indiaplus#12",
    });
    expect(offers[0]!.tags).toEqual(expect.arrayContaining(["ChatGPT", "自动发货", "新鲜出炉"]));
  });
});

describe("collectGenericHtml", () => {
  it("价格锚点切分，抽出标题与缺货", async () => {
    const html = `<div>ChatGPT Plus 月卡 ¥30 库存 9</div><div>Claude Pro 直充 ¥45 缺货</div>`;
    const offers = await collectGenericHtml(target({ sourceUrl: "https://html.test/" }), fakeHttp({ text: () => html }));
    expect(offers.length).toBeGreaterThanOrEqual(1);
    expect(offers.some((o) => o.sourceTitle.includes("Plus"))).toBe(true);
    expect(offers.every((o) => typeof o.externalKey === "string" && o.externalKey!.startsWith("gh:"))).toBe(true);
  });
  it("卡片模式优先，识别后缀价格与真实商品链接，externalKey 仍只由标题决定", async () => {
    const html = `
      <div class="product-card"><h3>ChatGPT Plus 月卡</h3><a href="/buy/1">详情</a><span>30 CNY</span><span>库存:9</span></div>
      <div class="goods item"><img alt="Claude Pro 直充"><a href="/product/claude">购买</a><span>45元</span><span>缺货</span></div>
    `;
    const offers = await collectGenericHtml(target({ sourceUrl: "https://html.test/" }), fakeHttp({ text: () => html }));
    expect(offers).toHaveLength(2);
    expect(offers[0]!.url).toBe("https://html.test/buy/1");
    expect(offers[0]!.stockCount).toBe(9);
    expect(offers[0]!.externalKey).toBe("gh:chatgpt plus 月卡");
    expect(offers[1]!.status).toBe("out_of_stock");
    expect(offers[1]!.externalKey).toBe("gh:claude pro 直充");
  });
  it("卡片模式可跨嵌套 div 提取标题、价格和真实链接", async () => {
    const html = `
      <div class="product-card">
        <div class="cover"><img alt="ChatGPT Plus 月卡"></div>
        <div class="body"><h3>ChatGPT Plus 月卡</h3></div>
        <div class="price">30 CNY</div>
        <a href="/buy/1">详情</a>
      </div>
      <div class="product-card">
        <div class="body"><h3>Claude Pro 直充</h3></div>
        <div class="price">45元</div>
        <a href="/buy/2">详情</a>
      </div>
    `;
    const offers = await collectGenericHtml(target({ sourceUrl: "https://html.test/" }), fakeHttp({ text: () => html }));
    expect(offers).toHaveLength(2);
    expect(offers[0]!.sourceTitle).toBe("ChatGPT Plus 月卡");
    expect(offers[0]!.url).toBe("https://html.test/buy/1");
  });
  it("文本模式也识别后缀价格", async () => {
    const html = `<div>ChatGPT Plus 月卡 30 CNY 库存 9</div><div>Claude Pro 直充 45元 缺货</div>`;
    const offers = await collectGenericHtml(target({ sourceUrl: "https://html.test/" }), fakeHttp({ text: () => html }));
    expect(offers.some((o) => o.sourceTitle.includes("Plus") && o.price === 30)).toBe(true);
  });
});

describe("extractOffersInPage", () => {
  it("浏览器 DOM 提取支持 PRICE20 CNY 紧贴价格写法", () => {
    const oldDocument = globalThis.document;
    const oldLocation = globalThis.location;
    const oldWindow = (globalThis as any).window;
    (globalThis as any).location = { href: "https://browser.test/" };
    (globalThis as any).window = { location: (globalThis as any).location };
    (globalThis as any).document = {
      querySelectorAll: () => [{
        innerText: "ChatGPT Plus PRICE20 CNY 库存:8 自动发货",
        textContent: "",
        closest: () => null,
        querySelector: () => null,
      }],
    };
    try {
      const offers = extractOffersInPage();
      expect(offers).toHaveLength(1);
      expect(offers[0]!.price).toBe(20);
      expect(offers[0]!.sourceTitle).toContain("ChatGPT Plus");
    } finally {
      (globalThis as any).document = oldDocument;
      (globalThis as any).location = oldLocation;
      (globalThis as any).window = oldWindow;
    }
  });
});

describe("browser challenge helpers", () => {
  it("识别 Cloudflare 挑战页", () => {
    expect(isCloudflareChallengeSnapshot({ title: "Just a moment...", bodyText: "", html: "<script>window.__cf_chl_opt={}</script>" })).toBe(true);
    expect(isCloudflareChallengeSnapshot({ title: "商品列表", bodyText: "ChatGPT Plus PRICE20 CNY", html: "<main>ok</main>" })).toBe(false);
  });

  it("挑战页等待超时后抛出明确错误", async () => {
    const page = {
      async evaluate() {
        return { title: "Just a moment...", bodyText: "", html: "<div id=\"challenge-platform\"></div>" };
      },
      async waitForTimeout() {},
    };
    await expect(waitForChallengeToClear(page, 0, 0)).rejects.toThrow(/Cloudflare 挑战未通过/);
  });

  it("等待 SPA 渲染到出现价格特征", async () => {
    const snapshots = [
      { title: "加载中", bodyText: "", html: "<div id=\"app\"></div>" },
      { title: "商品列表", bodyText: "正在加载商品", html: "<div id=\"app\">loading</div>" },
      { title: "商品列表", bodyText: "ChatGPT Plus PRICE30 CNY", html: "<main>ok</main>" },
    ];
    let index = 0;
    const page = {
      async evaluate() {
        return snapshots[Math.min(index++, snapshots.length - 1)];
      },
      async waitForTimeout() {},
    };
    const snapshot = await waitForContentSettled(page, 1000, 0);
    expect(snapshot.bodyText).toMatch(/PRICE30/);
  });

  it("浏览器空结果错误不再被识别为挑战错误", () => {
    expect(isChallengeBlockedError(new Error("浏览器采集未提取到商品（页面渲染后仍无内容或无价格特征）"))).toBe(false);
  });

  it("profile 锁互斥，第二个调用等待释放", async () => {
    const releaseFirst = await acquireProfileLock();
    let secondAcquired = false;
    const second = acquireProfileLock().then((release) => {
      secondAcquired = true;
      return release;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(secondAcquired).toBe(false);

    releaseFirst();
    const releaseSecond = await second;
    expect(secondAcquired).toBe(true);
    releaseSecond();
  });

  it("人工验证 Chrome 参数不包含自动化/无头标志", () => {
    const args = buildInteractiveVerificationArgs(34567, "/tmp/shop-profile");
    expect(args).toContain("--remote-debugging-port=34567");
    expect(args).toContain("--user-data-dir=/tmp/shop-profile");
    expect(args.some((arg) => /headless|enable-automation|AutomationControlled/i.test(arg))).toBe(false);
  });

  it("识别 Chrome profile 被占用提示", () => {
    expect(isProfileInUseMessage("Failed to create SingletonLock")).toBe(true);
    expect(isProfileInUseMessage("Opening in existing browser session.")).toBe(true);
    expect(isProfileInUseMessage("ordinary warning")).toBe(false);
  });
});
