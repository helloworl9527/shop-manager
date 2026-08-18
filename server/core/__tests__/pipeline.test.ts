import { describe, it, expect } from "vitest";
import { openDatabase, type SqliteDatabase } from "../../db/connection";
import { applySchema, seedCanonicalProducts } from "../../db/init";
import { upsertSource, getSource, acquireSourceLock, countActiveOffers, nowIso, markSourceManualRequired, markSourceFailure } from "../../db/repo";
import { listProducts } from "../../db/data";
import { collectSource, runAllSources } from "../orchestrator";
import { enqueueJob, runJob } from "../jobs";
import { ChallengeBlockedError } from "../../collectors/browser";
import type { Collector, CollectorOffer } from "../../collectors/types";

function db(): SqliteDatabase {
  const d = openDatabase(":memory:");
  applySchema(d);
  seedCanonicalProducts(d);
  upsertSource(d, { id: "s1", name: "店一", entryUrl: "https://s1.test/", collectorKind: "kami" });
  return d;
}

const fixed = (offers: CollectorOffer[]): { resolveCollector: () => Collector } => ({
  resolveCollector: () => async () => offers,
});

const offer = (over: Partial<CollectorOffer> = {}): CollectorOffer => ({
  sourceTitle: "ChatGPT Plus 月卡",
  price: 30,
  status: "in_stock",
  url: "https://s1.test/?commodity=1",
  tags: [],
  stockCount: 50,
  externalKey: "1",
  ...over,
});

async function withHostLimitEnv<T>(fn: () => Promise<T>): Promise<T> {
  const oldLimit = process.env.SHOP_COLLECT_HOST_CONCURRENCY;
  const oldDelay = process.env.SHOP_COLLECT_HOST_DELAY_MS;
  process.env.SHOP_COLLECT_HOST_CONCURRENCY = "2";
  process.env.SHOP_COLLECT_HOST_DELAY_MS = "0";
  try {
    return await fn();
  } finally {
    if (oldLimit === undefined) delete process.env.SHOP_COLLECT_HOST_CONCURRENCY;
    else process.env.SHOP_COLLECT_HOST_CONCURRENCY = oldLimit;
    if (oldDelay === undefined) delete process.env.SHOP_COLLECT_HOST_DELAY_MS;
    else process.env.SHOP_COLLECT_HOST_DELAY_MS = oldDelay;
  }
}

describe("collectSource 写入与分类", () => {
  it("写入 offer、分类到 chatgpt-plus、rank=0", async () => {
    const d = db();
    const r = await collectSource(d, getSource(d, "s1")!, fixed([offer()]));
    expect(r.status).toBe("success");
    expect(r.written).toBe(1);
    const row = d.prepare("SELECT effective_canonical_product_id eff, availability_rank ar, hidden FROM raw_offers").get() as any;
    expect(row.eff).toBe("chatgpt-plus");
    expect(row.ar).toBe(0);
    expect(row.hidden).toBe(0);
  });

  it("标价 0 的条目被丢弃，不污染比价（教程/引流占位、DOM 误抓的分类文字）", async () => {
    const d = db();

    const r = await collectSource(d, getSource(d, "s1")!, fixed([
      offer({ externalKey: "free", sourceTitle: "反代教程【不要下单】", price: 0, url: "https://s1.test/?commodity=free" }),
      offer({ externalKey: "real", price: 30 }),
    ]));

    expect(r.status).toBe("success");
    const rows = d.prepare("SELECT source_title, price FROM raw_offers").all() as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0].price).toBe(30);
  });

  it("整店都是标价 0 时按空结果处理，不删旧数据", async () => {
    const d = db();
    await collectSource(d, getSource(d, "s1")!, fixed([offer({ externalKey: "real", price: 30 })]));
    expect(countActiveOffers(d, "s1")).toBe(1);

    const r = await collectSource(d, getSource(d, "s1")!, fixed([
      offer({ externalKey: "z1", price: 0, url: "https://s1.test/?commodity=z1" }),
    ]));

    expect(r.status).toBe("partial");
    expect(r.message).toMatch(/标价 0/);
    expect(countActiveOffers(d, "s1")).toBe(1); // 旧的有效报价仍在
  });

  it("auto 源探测成功后回写真实 collector_kind 与 evidence", async () => {
    const d = openDatabase(":memory:");
    applySchema(d);
    seedCanonicalProducts(d);
    upsertSource(d, { id: "s-auto", name: "HTML 店", entryUrl: "https://html.test/", collectorKind: "auto" });
    const http = {
      async fetchJson() { throw new Error("非接口"); },
      async fetchText() { return `<div>ChatGPT Plus 月卡 ¥30 库存 9</div><div>Claude Pro 直充 ¥45 库存 3</div>`; },
      async postJson() { return {}; },
    };

    const r = await collectSource(d, getSource(d, "s-auto")!, { http });

    expect(r.status).toBe("success");
    const source = getSource(d, "s-auto")!;
    expect(source.collector_kind).toBe("genericHtml");
    expect(source.kind_detected_at).toBeTruthy();
    expect(source.kind_evidence).toMatch(/genericHtml/);
    const run = d.prepare("SELECT details FROM crawl_runs ORDER BY started_at DESC LIMIT 1").get() as any;
    const details = JSON.parse(run.details);
    expect(details.resolvedKind).toBe("genericHtml");
    expect(details.usedDetectOffers).toBe(true);
    expect(details.attempts.some((a: any) => a.step === "genericHtmlTrial" && a.ok)).toBe(true);
  });

  it("接口指纹高置信命中后即使采集失败也回写真实 kind", async () => {
    const d = openDatabase(":memory:");
    applySchema(d);
    seedCanonicalProducts(d);
    upsertSource(d, { id: "s-kami", name: "Kami 店", entryUrl: "https://kami.test/", collectorKind: "auto" });
    const http = {
      async fetchJson(url: string) {
        if (url.includes("limit=1&page=1")) return { data: [{ id: 1, name: "x", price: 1 }] };
        throw new Error("采集接口临时失败");
      },
      async fetchText() { return ""; },
      async postJson() { return {}; },
    };

    const r = await collectSource(d, getSource(d, "s-kami")!, { http });

    expect(r.status).toBe("failed");
    const source = getSource(d, "s-kami")!;
    expect(source.collector_kind).toBe("kami");
    expect(source.kind_evidence).toMatch(/接口指纹/);
  });

  it("误判 browser 即使当轮成功也不回写 browser", async () => {
    const d = openDatabase(":memory:");
    applySchema(d);
    seedCanonicalProducts(d);
    upsertSource(d, { id: "s-browser", name: "误判站", entryUrl: "https://plain.test/", collectorKind: "auto" });
    const http = {
      async fetchJson() { throw new Error("非接口"); },
      async fetchText() { return "<html><title>普通页面</title><p>没有商品价格</p></html>"; },
      async postJson() { return {}; },
    };

    const r = await collectSource(d, getSource(d, "s-browser")!, { http, browserCollector: async () => [offer()] });

    expect(r.status).toBe("success");
    const source = getSource(d, "s-browser")!;
    expect(source.collector_kind).toBe("auto");
  });

  it("浏览器遇到 Cloudflare 挑战 → manual_required，不计普通失败", async () => {
    const d = openDatabase(":memory:");
    applySchema(d);
    seedCanonicalProducts(d);
    upsertSource(d, { id: "s-cf", name: "CF 店", entryUrl: "https://cf.test/", collectorKind: "browser", collectionMethod: "browser" });

    const r = await collectSource(d, getSource(d, "s-cf")!, {
      resolveCollector: () => async () => { throw new ChallengeBlockedError(); },
    });

    expect(r.status).toBe("manual_required");
    const source = d.prepare("SELECT health_status, consecutive_failures, last_error FROM sources WHERE id='s-cf'").get() as any;
    expect(source.health_status).toBe("manual_required");
    expect(source.consecutive_failures).toBe(0);
    expect(source.last_error).toMatch(/Cloudflare/);
    const run = d.prepare("SELECT status, failure_count FROM crawl_runs WHERE source_id='s-cf'").get() as any;
    expect(run.status).toBe("manual_required");
    expect(run.failure_count).toBe(0);
  });

  it("shopApi HTTP 500 不触发浏览器回退", async () => {
    const d = openDatabase(":memory:");
    applySchema(d);
    seedCanonicalProducts(d);
    upsertSource(d, { id: "s-shop", name: "链动", entryUrl: "https://shop.test/shop/TKN", collectorKind: "shopApi" });
    let browserCalls = 0;

    const r = await collectSource(d, getSource(d, "s-shop")!, {
      resolveCollector: () => async () => {
        throw new Error("https://shop.test/shopApi/Shop/goodsList returned HTTP 500");
      },
      shopApiBrowserCollector: async () => {
        browserCalls += 1;
        return [offer()];
      },
    });

    expect(r.status).toBe("failed");
    expect(browserCalls).toBe(0);
  });

  it("shopApi HTTP 403 仍可触发浏览器回退", async () => {
    const d = openDatabase(":memory:");
    applySchema(d);
    seedCanonicalProducts(d);
    upsertSource(d, { id: "s-shop", name: "链动", entryUrl: "https://shop.test/shop/TKN", collectorKind: "shopApi" });
    let browserCalls = 0;

    const r = await collectSource(d, getSource(d, "s-shop")!, {
      resolveCollector: () => async () => {
        throw new Error("https://shop.test/shopApi/Shop/info returned HTTP 403");
      },
      shopApiBrowserCollector: async () => {
        browserCalls += 1;
        return [offer({ url: "https://shop.test/item/gk1", externalKey: "gk1" })];
      },
    });

    expect(r.status).toBe("success");
    expect(browserCalls).toBe(1);
  });

  it("shopApi 浏览器回退失败不把 collection_method 持久化为 browser", async () => {
    const d = openDatabase(":memory:");
    applySchema(d);
    seedCanonicalProducts(d);
    upsertSource(d, { id: "s-shop", name: "链动", entryUrl: "https://shop.test/shop/TKN", collectorKind: "shopApi", collectionMethod: "browser" });
    const http = {
      async fetchJson() { return {}; },
      async fetchText() { return ""; },
      async postJson() { throw new Error("返回验证或风控页面，需要改用本机浏览器采集"); },
    };

    const r = await collectSource(d, getSource(d, "s-shop")!, {
      http,
      shopApiBrowserCollector: async () => {
        throw new ChallengeBlockedError();
      },
    });

    expect(r.status).toBe("manual_required");
    expect(getSource(d, "s-shop")!.collection_method).toBe("http");
  });

  it("shopApi HTTP 成功后修正残留 browser collection_method", async () => {
    const d = openDatabase(":memory:");
    applySchema(d);
    seedCanonicalProducts(d);
    upsertSource(d, { id: "s-shop", name: "链动", entryUrl: "https://shop.test/shop/TKN", collectorKind: "shopApi", collectionMethod: "browser" });
    const http = {
      async fetchJson() { return {}; },
      async fetchText() { return ""; },
      async postJson(url: string) {
        if (url.endsWith("/shopApi/Shop/info")) return { code: 1, data: { nickname: "链动", link: "https://shop.test/shop/TKN" } };
        if (url.endsWith("/shopApi/Shop/categoryList")) return { data: [{ id: 1, goods_count: 1 }] };
        if (url.endsWith("/shopApi/Shop/goodsList")) return { data: { list: [{ name: "Plus 成品号", price: 30, goods_key: "gk1", status: 1, goods_type: "card", extend: { stock_count: 5, send_order: 0 } }] } };
        return {};
      },
    };

    const r = await collectSource(d, getSource(d, "s-shop")!, { http });

    expect(r.status).toBe("success");
    expect(getSource(d, "s-shop")!.collection_method).toBe("http");
  });

  it("非 browser 采集器浏览器回退成功也不持久化 browser method", async () => {
    const d = openDatabase(":memory:");
    applySchema(d);
    seedCanonicalProducts(d);
    upsertSource(d, {
      id: "s-html",
      name: "HTML",
      entryUrl: "https://html.test/",
      collectorKind: "genericHtml",
      collectionMethod: "http",
      kindEvidence: "HTML 指纹命中 genericHtml",
    });
    const http = {
      async fetchJson() { throw new Error("不是接口"); },
      async fetchText() { throw new Error("返回验证或风控页面，需要改用本机浏览器采集"); },
      async postJson() { return {}; },
    };

    const r = await collectSource(d, getSource(d, "s-html")!, { http, browserCollector: async () => [offer()] });

    expect(r.status).toBe("success");
    expect(getSource(d, "s-html")!.collection_method).toBe("http");
  });

  it("非 browser 采集器 HTTP 成功后修正残留 browser collection_method", async () => {
    const d = openDatabase(":memory:");
    applySchema(d);
    seedCanonicalProducts(d);
    upsertSource(d, {
      id: "s-html",
      name: "HTML",
      entryUrl: "https://html.test/",
      collectorKind: "genericHtml",
      collectionMethod: "browser",
      kindEvidence: "历史浏览器回退污染",
    });
    const http = {
      async fetchJson() { throw new Error("不是接口"); },
      async fetchText() { return `<div class="product"><h2>ChatGPT Plus 月卡</h2><a href="/buy/1">购买</a><span>¥30</span><span>库存 5</span></div>`; },
      async postJson() { return {}; },
    };

    const r = await collectSource(d, getSource(d, "s-html")!, { http });

    expect(r.status).toBe("success");
    expect(getSource(d, "s-html")!.collection_method).toBe("http");
  });
});

describe("差集下架硬规则", () => {
  it("完整快照缺失商品被标下架（hidden=1），未删除", async () => {
    const d = db();
    await collectSource(d, getSource(d, "s1")!, fixed([offer({ externalKey: "1" }), offer({ externalKey: "2", url: "https://s1.test/?commodity=2" }), offer({ externalKey: "3", url: "https://s1.test/?commodity=3" }), offer({ externalKey: "4", url: "https://s1.test/?commodity=4" })]));
    expect(countActiveOffers(d, "s1")).toBe(4);
    // 第二次只返回 3 条（>=4 的一半），缺失的 #4 应被下架
    await collectSource(d, getSource(d, "s1")!, fixed([offer({ externalKey: "1" }), offer({ externalKey: "2", url: "https://s1.test/?commodity=2" }), offer({ externalKey: "3", url: "https://s1.test/?commodity=3" })]));
    expect(countActiveOffers(d, "s1")).toBe(3);
    const total = (d.prepare("SELECT COUNT(*) n FROM raw_offers").get() as any).n;
    expect(total).toBe(4); // 仍在库，只是 hidden
  });

  it("采集器切换导致 id 体系变更时，旧体系报价被下架（不与新数据并存造成重复显示）", async () => {
    const d = db();
    // 第一轮：DOM 采集，externalKey 走 br:标题 体系，url 只能拿到店铺页
    const domOffers = Array.from({ length: 10 }, (_, i) =>
      offer({ externalKey: `br:dom-${i}`, sourceTitle: `商品${i}`, url: "https://s1.test/shop/tkn" }));
    await collectSource(d, getSource(d, "s1")!, fixed(domOffers));
    expect(countActiveOffers(d, "s1")).toBe(10);

    // 第二轮：切到接口采集，externalKey 换成 goods_key 体系，条数还比原来少（会触发 50% 保护）
    const apiOffers = Array.from({ length: 4 }, (_, i) =>
      offer({ externalKey: `gk-${i}`, sourceTitle: `商品${i}`, url: `https://s1.test/item/gk-${i}` }));
    const r = await collectSource(d, getSource(d, "s1")!, fixed(apiOffers));

    // 旧的 10 条必须全部下架，只留新体系的 4 条——否则前台会看到同一店铺的商品重复两遍
    expect(countActiveOffers(d, "s1")).toBe(4);
    expect(r.message).toMatch(/采集方式已变更/);
    const urls = (d.prepare("SELECT DISTINCT url FROM raw_offers WHERE source_id='s1' AND hidden=0").all() as any[]).map((x) => x.url);
    expect(urls.every((u: string) => u.includes("/item/"))).toBe(true);
  });

  it("正常采集（id 体系不变）仍受「结果偏少」保护，不会误删", async () => {
    const d = db();
    const many = Array.from({ length: 10 }, (_, i) =>
      offer({ externalKey: `gk-${i}`, url: `https://s1.test/item/gk-${i}` }));
    await collectSource(d, getSource(d, "s1")!, fixed(many));

    // 只返回 1 条，但 id 属于同一体系 → 视为异常偏少，保护性不下架
    const r = await collectSource(d, getSource(d, "s1")!, fixed([
      offer({ externalKey: "gk-0", url: "https://s1.test/item/gk-0" }),
    ]));

    expect(r.status).toBe("partial");
    expect(r.message).toMatch(/偏少/);
    expect(countActiveOffers(d, "s1")).toBe(10);
  });

  it("返回异常偏少 → partial，不下架", async () => {
    const d = db();
    const many = Array.from({ length: 10 }, (_, i) => offer({ externalKey: String(i), url: `https://s1.test/?commodity=${i}` }));
    await collectSource(d, getSource(d, "s1")!, fixed(many));
    expect(countActiveOffers(d, "s1")).toBe(10);
    d.prepare("UPDATE sources SET consecutive_failures=3 WHERE id='s1'").run();
    const r = await collectSource(d, getSource(d, "s1")!, fixed([offer({ externalKey: "0", url: "https://s1.test/?commodity=0" })]));
    expect(r.status).toBe("partial");
    expect(countActiveOffers(d, "s1")).toBe(10); // 未下架
    expect(getSource(d, "s1")!.consecutive_failures).toBe(3);
  });

  it("manual_required 不增加连败、不标记旧报价失败", async () => {
    const d = db();
    await collectSource(d, getSource(d, "s1")!, fixed([offer()]));
    markSourceManualRequired(d, "s1", "等待人工验证", nowIso());

    const source = d.prepare("SELECT health_status, consecutive_failures, last_error FROM sources WHERE id='s1'").get() as any;
    expect(source).toMatchObject({ health_status: "manual_required", consecutive_failures: 0, last_error: "等待人工验证" });
    const raw = d.prepare("SELECT last_failed_at, failure_reason, effective_status FROM raw_offers WHERE source_id='s1'").get() as any;
    expect(raw.last_failed_at).toBeNull();
    expect(raw.failure_reason).toBeNull();
    expect(raw.effective_status).toBe("available");
  });

  it("报价过期不再从前台列表消失", async () => {
    const d = db();
    await collectSource(d, getSource(d, "s1")!, fixed([offer()]));
    d.prepare(
      `UPDATE raw_offers
       SET freshness_status='expired', expires_at='2026-01-01T00:00:00.000Z'
       WHERE source_id='s1'`,
    ).run();

    const products = listProducts(d);

    expect(products.total).toBe(1);
    expect(products.items[0]?.resultVerifiedAt).toBeTruthy();
  });

  it("连续失败只更新来源健康，不把旧报价降级为 expired/unavailable", async () => {
    const d = db();
    await collectSource(d, getSource(d, "s1")!, fixed([offer()]));
    for (let i = 0; i < 3; i += 1) markSourceFailure(d, "s1", "HTTP 500", nowIso());

    const source = getSource(d, "s1")!;
    const raw = d.prepare("SELECT effective_status, freshness_status, availability_rank, failure_reason FROM raw_offers WHERE source_id='s1'").get() as any;

    expect(source.health_status).toBe("failing");
    expect(source.consecutive_failures).toBe(3);
    expect(raw.effective_status).toBe("available");
    expect(raw.freshness_status).toBe("fresh");
    expect(raw.availability_rank).toBe(0);
    expect(raw.failure_reason).toBe("HTTP 500");
  });
});

describe("源级锁", () => {
  it("源被他人锁住时跳过", async () => {
    const d = db();
    acquireSourceLock(d, "s1", "other-owner", 60_000, nowIso());
    const r = await collectSource(d, getSource(d, "s1")!, fixed([offer()]));
    expect(r.status).toBe("skipped");
  });

  it("全量采集跳过已待验证的 browser 源并写 skipped 日志", async () => {
    const d = db();
    d.prepare("UPDATE sources SET collector_kind='browser', collection_method='browser', health_status='manual_required' WHERE id='s1'").run();
    const r = await runAllSources(d, [getSource(d, "s1")!], fixed([offer()]));

    expect(r.status).toBe("partial");
    expect(r.skippedSources).toEqual(["s1"]);
    expect(r.manualRequiredSources).toEqual(["s1"]);
    const run = d.prepare("SELECT status, message FROM crawl_runs WHERE source_id='s1'").get() as any;
    expect(run.status).toBe("skipped");
    expect(run.message).toMatch(/等待人工验证/);
    expect(countActiveOffers(d, "s1")).toBe(0);
  });

  it("全量采集任一来源失败时整体标 partial 并列出失败来源", async () => {
    const d = openDatabase(":memory:");
    applySchema(d);
    seedCanonicalProducts(d);
    upsertSource(d, { id: "s-ok", name: "OK", entryUrl: "https://ok.test/", collectorKind: "kami" });
    upsertSource(d, { id: "s-fail", name: "Fail", entryUrl: "https://fail.test/", collectorKind: "kami" });
    const sources = ["s-ok", "s-fail"].map((id) => getSource(d, id)!);

    const r = await runAllSources(d, sources, {
      resolveCollector: () => async (target) => {
        if (target.sourceId === "s-fail") throw new Error("站点不可用");
        return [offer({ externalKey: target.sourceId, url: `${target.sourceUrl}item` })];
      },
    });

    expect(r.status).toBe("partial");
    expect(r.failedSources).toEqual(["s-fail"]);
    expect(r.partialSources).toEqual([]);
    expect(r.manualRequiredSources).toEqual([]);
  });

  it("同域名触发限流后熔断：本轮跳过该域名其余店铺，不累加连败", async () => {
    await withHostLimitEnv(async () => {
      const d = openDatabase(":memory:");
      applySchema(d);
      seedCanonicalProducts(d);
      const ids = ["t1", "t2", "t3", "other1"];
      for (const id of ids) {
        const host = id.startsWith("other") ? "other.test" : "throttled.test";
        upsertSource(d, { id, name: id, entryUrl: `https://${host}/shop/${id}`, collectorKind: "shopApi" });
      }
      const attempted: string[] = [];
      const sources = ids.map((id) => getSource(d, id)!);

      const r = await runAllSources(d, sources, {
        concurrency: 1, // 串行，确保第一家的 520 能在后续店铺开跑前熔断该域名
        resolveCollector: () => async (target) => {
          attempted.push(target.sourceId);
          if (new URL(target.sourceUrl).hostname === "throttled.test") {
            throw new Error("https://throttled.test/shopApi/Shop/info returned HTTP 520");
          }
          return [offer({ externalKey: target.sourceId, url: `${target.sourceUrl}/item` })];
        },
      });

      // 只有第一家真正打了被限流的域名，其余两家被熔断跳过
      expect(attempted.filter((id) => id.startsWith("t"))).toEqual(["t1"]);
      const byId = new Map(r.results.map((item) => [item.sourceId, item]));
      expect(byId.get("t1")!.status).toBe("failed");
      expect(byId.get("t2")!.status).toBe("skipped");
      expect(byId.get("t3")!.status).toBe("skipped");
      expect(byId.get("t2")!.message).toMatch(/限流/);
      // 熔断跳过不应把这些店铺记为失败
      expect(getSource(d, "t2")!.consecutive_failures).toBe(0);
      expect(getSource(d, "t3")!.consecutive_failures).toBe(0);
      // 其它域名不受牵连
      expect(byId.get("other1")!.status).toBe("success");
    });
  });

  it("全量采集任一来源只返回空结果时整体标 partial 并列出部分来源", async () => {
    const d = db();
    const r = await runAllSources(d, [getSource(d, "s1")!], fixed([]));

    expect(r.status).toBe("partial");
    expect(r.failedSources).toEqual([]);
    expect(r.partialSources).toEqual(["s1"]);
  });

  it("全量采集保持输入顺序", async () => {
    const d = openDatabase(":memory:");
    applySchema(d);
    seedCanonicalProducts(d);
    upsertSource(d, { id: "s-http", name: "HTTP", entryUrl: "https://http.test/", collectorKind: "kami" });
    upsertSource(d, { id: "s-manual", name: "Manual", entryUrl: "https://manual.test/", collectorKind: "browser", collectionMethod: "browser" });
    upsertSource(d, { id: "s-browser", name: "Browser", entryUrl: "https://browser.test/", collectorKind: "browser", collectionMethod: "browser" });
    markSourceManualRequired(d, "s-manual", "等待人工验证", nowIso());
    const sources = ["s-http", "s-manual", "s-browser"].map((id) => getSource(d, id)!);

    const r = await runAllSources(d, sources, fixed([offer()]));

    expect(r.results.map((item) => item.sourceId)).toEqual(["s-http", "s-manual", "s-browser"]);
  });

  it("全量 HTTP 采集同 host 并发不超过配置，异 host 可并行", async () => {
    await withHostLimitEnv(async () => {
      const d = openDatabase(":memory:");
      applySchema(d);
      seedCanonicalProducts(d);
      const ids = ["a1", "a2", "a3", "a4", "b1"];
      for (const id of ids) {
        const host = id.startsWith("a") ? "same.test" : "other.test";
        upsertSource(d, { id, name: id, entryUrl: `https://${host}/shop/${id}`, collectorKind: "kami" });
      }
      const active = new Map<string, number>();
      const maxActive = new Map<string, number>();
      const sources = ids.map((id) => getSource(d, id)!);

      const r = await runAllSources(d, sources, {
        concurrency: 5,
        resolveCollector: () => async (target) => {
          const host = new URL(target.sourceUrl).hostname;
          active.set(host, (active.get(host) ?? 0) + 1);
          maxActive.set(host, Math.max(maxActive.get(host) ?? 0, active.get(host) ?? 0));
          await new Promise((resolve) => setTimeout(resolve, 20));
          active.set(host, (active.get(host) ?? 1) - 1);
          return [offer({ externalKey: target.sourceId, url: `${target.sourceUrl}/item` })];
        },
      });

      expect(r.results.map((item) => item.sourceId)).toEqual(ids);
      expect(maxActive.get("same.test")).toBeLessThanOrEqual(2);
      expect(maxActive.get("other.test")).toBe(1);
    });
  });
});

describe("jobs 入队互斥", () => {
  it("有活动全量任务时，单源入队复用该全量 jobId", () => {
    const d = db();
    const all = enqueueJob(d, { jobType: "all" });
    const src = enqueueJob(d, { jobType: "source", sourceId: "s1" });
    expect(src.created).toBe(false);
    expect(src.jobId).toBe(all.jobId);
    expect(src.note).toBe("covered-by-active-all");
  });
  it("同源重复入队返回已存在活动任务", () => {
    const d = db();
    const a = enqueueJob(d, { jobType: "source", sourceId: "s1" });
    const b = enqueueJob(d, { jobType: "source", sourceId: "s1" });
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(b.jobId).toBe(a.jobId);
  });
});

describe("runJob 端到端", () => {
  it("单源任务跑通并落库，job 标记 success", async () => {
    const d = db();
    const { jobId } = enqueueJob(d, { jobType: "source", sourceId: "s1" });
    const r = await runJob(d, jobId, fixed([offer()]));
    expect(r.status).toBe("success");
    const job = d.prepare("SELECT status FROM collection_jobs WHERE id=?").get(jobId) as any;
    expect(job.status).toBe("success");
    const runs = (d.prepare("SELECT COUNT(*) n FROM crawl_runs").get() as any).n;
    expect(runs).toBe(1);
  });
});
