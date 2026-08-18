import { describe, it, expect } from "vitest";
import { openDatabase, type SqliteDatabase } from "../../db/connection";
import { applySchema, seedCanonicalProducts } from "../../db/init";
import { buildServer } from "../server";
import { drainJobs } from "../../core/scheduler";
import { getVerifySessionState, resetVerifySessionForTests } from "../../core/verify";
import type { Collector, CollectorOffer } from "../../collectors/types";

const offer = (o: Partial<CollectorOffer> = {}): CollectorOffer => ({
  sourceTitle: "ChatGPT Plus 月卡", price: 30, status: "in_stock",
  url: "https://s1.test/?commodity=1", tags: [], stockCount: 50, externalKey: "1", ...o,
});
const deps = { resolveCollector: () => (async () => [offer(), offer({ externalKey: "2", url: "https://s1.test/?commodity=2", price: 35 })]) as Collector };

function setup(customDeps: any = deps, verify?: any): { db: SqliteDatabase; app: ReturnType<typeof buildServer> } {
  const db = openDatabase(":memory:");
  applySchema(db);
  seedCanonicalProducts(db);
  const app = buildServer(db, { deps: customDeps, verify });
  return { db, app };
}

function insertRawOffer(db: SqliteDatabase, o: {
  id: string;
  sourceId?: string | null;
  canonicalId: string;
  platform: string;
  title: string;
  store: string;
  price: number;
  availabilityRank?: number;
  status?: string;
  hidden?: number;
}): void {
  const now = new Date().toISOString();
  if (o.sourceId) {
    db.prepare(
      `INSERT OR IGNORE INTO sources(id,name,entry_url,created_at,updated_at)
       VALUES(@id,@name,@url,@now,@now)`,
    ).run({ id: o.sourceId, name: `店 ${o.sourceId}`, url: `https://${o.sourceId}.test/`, now });
  }
  db.prepare(
    `INSERT INTO raw_offers
       (id, source_id, source_name, source_store_name, source_title, url, price, status,
        effective_status, freshness_status, availability_rank, hidden,
        canonical_product_id, category_slug, captured_at, last_seen_at, created_at, updated_at)
     VALUES
       (@id, @sourceId, 'manual', @store, @title, @url, @price, @status,
        'available', 'fresh', @availabilityRank, @hidden,
        @canonicalId, @platform, @now, @now, @now, @now)`,
  ).run({
    ...o,
    sourceId: o.sourceId ?? null,
    url: `https://offers.test/${o.id}`,
    availabilityRank: o.availabilityRank ?? 0,
    status: o.status ?? "in_stock",
    hidden: o.hidden ?? 0,
    now,
  });
}

describe("API", () => {
  it("health", async () => {
    const { app } = setup();
    const r = await app.inject({ method: "GET", url: "/api/health" });
    expect(r.statusCode).toBe(200);
    expect(r.json().ok).toBe(true);
  });

  it("创建/列出/更新/删除店铺", async () => {
    const { app } = setup();
    const created = await app.inject({ method: "POST", url: "/api/sources", payload: { name: "店一", entryUrl: "https://s1.test/", collectorKind: "kami" } });
    expect(created.statusCode).toBe(201);
    const id = created.json().source.id;

    const list = await app.inject({ method: "GET", url: "/api/sources" });
    expect(list.json().items.some((s: any) => s.id === id)).toBe(true);

    const patched = await app.inject({ method: "PATCH", url: `/api/sources/${id}`, payload: { enabled: false } });
    expect(patched.json().source.enabled).toBe(0);

    const del = await app.inject({ method: "DELETE", url: `/api/sources/${id}` });
    expect(del.json().deleted).toBe(true);
  });

  it("店铺收藏由服务端维护时间戳：重复收藏不刷新，取消会清空", async () => {
    const { db, app } = setup();
    const created = await app.inject({ method: "POST", url: "/api/sources", payload: { name: "店一", entryUrl: "https://s1.test/", collectorKind: "kami" } });
    const id = created.json().source.id;

    const first = await app.inject({ method: "PATCH", url: `/api/sources/${id}`, payload: { favorite: true } });
    expect(first.statusCode).toBe(200);
    expect(first.json().source.favorite).toBe(1);
    const firstAt = first.json().source.favorited_at;
    expect(firstAt).toBeTruthy();

    const second = await app.inject({ method: "PATCH", url: `/api/sources/${id}`, payload: { favorite: true } });
    expect(second.json().source.favorited_at).toBe(firstAt);

    const unset = await app.inject({ method: "PATCH", url: `/api/sources/${id}`, payload: { favorite: false } });
    expect(unset.json().source.favorite).toBe(0);
    expect(unset.json().source.favorited_at).toBeNull();
    expect((db.prepare("SELECT favorite, favorited_at FROM sources WHERE id=?").get(id) as any)).toMatchObject({ favorite: 0, favorited_at: null });
  });

  it("PATCH 店铺收藏拒绝客户端写 favorited_at / favoritedAt", async () => {
    const { app } = setup();
    const created = await app.inject({ method: "POST", url: "/api/sources", payload: { name: "店一", entryUrl: "https://s1.test/", collectorKind: "kami" } });
    const id = created.json().source.id;

    const snake = await app.inject({ method: "PATCH", url: `/api/sources/${id}`, payload: { favorite: true, favorited_at: "2099-01-01T00:00:00.000Z" } });
    expect(snake.statusCode).toBe(400);
    const camel = await app.inject({ method: "PATCH", url: `/api/sources/${id}`, payload: { favorite: true, favoritedAt: "2099-01-01T00:00:00.000Z" } });
    expect(camel.statusCode).toBe(400);
    const invalid = await app.inject({ method: "PATCH", url: `/api/sources/${id}`, payload: { favorite: 1 } });
    expect(invalid.statusCode).toBe(400);
  });

  it("选填名称 + 链接查重", async () => {
    const { app } = setup();
    const a = await app.inject({ method: "POST", url: "/api/sources", payload: { entryUrl: "https://pay.ldxp.cn/shop/ABCD" } });
    expect(a.statusCode).toBe(201);
    expect(a.json().source.name).toMatch(/ldxp|abcd/i); // 名称自动生成
    expect(a.json().source.name_source).toBe("auto");
    const manual = await app.inject({ method: "POST", url: "/api/sources", payload: { name: "我的店名", entryUrl: "https://manual-name.test/" } });
    expect(manual.json().source).toMatchObject({ name: "我的店名", name_source: "manual" });
    const dup = await app.inject({ method: "POST", url: "/api/sources", payload: { entryUrl: "https://pay.ldxp.cn/shop/ABCD?utm=x" } });
    expect(dup.statusCode).toBe(409); // 忽略 tracking 参数后视为重复
    const noUrl = await app.inject({ method: "POST", url: "/api/sources", payload: { name: "x" } });
    expect(noUrl.statusCode).toBe(400); // 仅 URL 必填
  });

  it("整站型采集器同域名查重：独角站首页与分类页只保留一个源", async () => {
    const { app } = setup();
    const home = await app.inject({ method: "POST", url: "/api/sources", payload: { entryUrl: "https://morimm.test/", collectorKind: "dujiao" } });
    expect(home.statusCode).toBe(201);

    // 同站另一个入口：整站型采集器会采到同一批全站商品 → 拒绝，避免前台重复显示
    const category = await app.inject({ method: "POST", url: "/api/sources", payload: { entryUrl: "http://morimm.test/categories/gpt", collectorKind: "dujiao" } });
    expect(category.statusCode).toBe(409);
    expect(category.json().error).toMatch(/该站点已添加过/);

    // 链动小铺不受此限：同域名下每个 /shop/<token> 是独立店铺
    const shopA = await app.inject({ method: "POST", url: "/api/sources", payload: { entryUrl: "https://pay.shop.test/shop/AAA", collectorKind: "shopApi" } });
    const shopB = await app.inject({ method: "POST", url: "/api/sources", payload: { entryUrl: "https://pay.shop.test/shop/BBB", collectorKind: "shopApi" } });
    expect(shopA.statusCode).toBe(201);
    expect(shopB.statusCode).toBe(201);
  });

  it("probe 店铺只读识别，返回类型、证据、预览和 attempts", async () => {
    const { db, app } = setup({
      http: {
        async fetchJson() { throw new Error("不是接口"); },
        async fetchText() { return `<div>ChatGPT Plus 月卡 ¥30 库存 9</div><div>Claude Pro 直充 ¥45 库存 2</div>`; },
        async postJson() { return {}; },
      },
    });
    const r = await app.inject({ method: "POST", url: "/api/sources/probe", payload: { url: "https://html.test/buy/123" } });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({
      kind: "genericHtml",
      normalized: { entryUrl: "https://html.test/", baseUrl: "https://html.test" },
      duplicate: null,
    });
    expect(r.json().offers.length).toBeGreaterThan(0);
    expect(r.json().attempts.length).toBeGreaterThan(0);
    const count = (db.prepare("SELECT COUNT(*) AS n FROM sources").get() as any).n;
    expect(count).toBe(0);
  });

  it("创建店铺可带 probe 识别结果、禁用状态和备注入库", async () => {
    const { app } = setup();
    const created = await app.inject({
      method: "POST",
      url: "/api/sources",
      payload: {
        entryUrl: "https://html.test/buy/123",
        collectorKind: "pending",
        kindEvidence: "HTML 指纹命中但未采到报价",
        enabled: false,
        notes: "HTML 指纹命中但未采到报价",
      },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().source).toMatchObject({
      entry_url: "https://html.test/",
      base_url: "https://html.test",
      collector_kind: "pending",
      kind_evidence: "HTML 指纹命中但未采到报价",
      enabled: 0,
      notes: "HTML 指纹命中但未采到报价",
    });
    expect(created.json().source.kind_detected_at).toBeTruthy();
  });

  it("创建店铺带 probe offers 时会立即入库商品并标记采集成功", async () => {
    const { app } = setup();
    const created = await app.inject({
      method: "POST",
      url: "/api/sources",
      payload: {
        entryUrl: "https://probe-add.test/",
        name: "识别店名",
        nameSource: "auto",
        collectorKind: "genericHtml",
        kindEvidence: "HTML 价格锚点 2 个；genericHtml 试采 2 条",
        offers: [
          { sourceTitle: "ChatGPT Plus 月卡", price: 30, status: "in_stock", url: "https://probe-add.test/p/1", tags: [], stockCount: 10 },
          { sourceTitle: "Claude Pro 月卡", price: 25, status: "in_stock", url: "https://probe-add.test/p/2", tags: [], stockCount: 5 },
        ],
      },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().source).toMatchObject({ name: "识别店名", name_source: "auto", health_status: "healthy" });

    const products = await app.inject({ method: "GET", url: "/api/products?pageSize=20" });
    expect(products.json().items.map((item: any) => item.resultTitle)).toEqual(expect.arrayContaining(["ChatGPT Plus 月卡", "Claude Pro 月卡"]));

    const runs = await app.inject({ method: "GET", url: "/api/crawl-runs" });
    expect(runs.json().items[0]).toMatchObject({ mode: "probe-add", status: "success", source_name: "识别店名" });
  });

  it("PATCH 修改采集器时同步改写 evidence 和检测时间", async () => {
    const { app } = setup();
    const created = await app.inject({
      method: "POST",
      url: "/api/sources",
      payload: {
        entryUrl: "https://fallback.test/",
        collectorKind: "kami",
        kindEvidence: "域名注册表命中：fallback.test → kami",
      },
    });
    const id = created.json().source.id;

    const patched = await app.inject({
      method: "PATCH",
      url: `/api/sources/${id}`,
      payload: { collectorKind: "browser", collectionMethod: "browser" },
    });

    expect(patched.statusCode).toBe(200);
    expect(patched.json().source).toMatchObject({
      collector_kind: "browser",
      collection_method: "browser",
    });
    expect(patched.json().source.kind_evidence).toMatch(/人工选择浏览器采集/);
    expect(patched.json().source.kind_evidence).toMatch(/域名注册表命中/);
    expect(patched.json().source.kind_detected_at).toBeTruthy();
  });

  it("巡检并重新识别被 browser method 污染的非 browser 店铺", async () => {
    const { app } = setup();
    const created = await app.inject({
      method: "POST",
      url: "/api/sources",
      payload: {
        entryUrl: "https://shop.test/shop/TKN",
        collectorKind: "shopApi",
        collectionMethod: "browser",
        kindEvidence: "浏览器回退污染",
      },
    });
    const id = created.json().source.id;

    const audit = await app.inject({ method: "GET", url: "/api/sources/audit" });
    expect(audit.statusCode).toBe(200);
    expect(audit.json().methodDrift.map((s: any) => s.id)).toContain(id);

    const reset = await app.inject({ method: "POST", url: `/api/sources/${id}/reidentify` });

    expect(reset.statusCode).toBe(202);
    expect(reset.json().source).toMatchObject({
      collector_kind: "auto",
      collection_method: "http",
      kind_detected_at: null,
      kind_evidence: null,
    });
    expect(reset.json().job).toMatchObject({ created: true });
  });

  it("存量 auto 店铺迁移会回写真实类型、evidence 和弱店名", async () => {
    const { db, app } = setup({
      http: {
        async fetchJson() { throw new Error("不是接口"); },
        async fetchText() { return `<meta property="og:site_name" content="宝钗杂货铺"><div>ChatGPT Plus 月卡 ¥30 库存 9</div><div>Claude Pro 直充 ¥45 库存 2</div>`; },
        async postJson() { return {}; },
      },
    });
    await app.inject({ method: "POST", url: "/api/sources", payload: { name: "2", nameSource: "auto", entryUrl: "https://html.test/", collectorKind: "auto" } });
    const migrated = await app.inject({ method: "POST", url: "/api/sources/migrate-kinds" });
    expect(migrated.statusCode).toBe(200);
    expect(migrated.json()).toMatchObject({ total: 1, updated: 1 });
    const source = db.prepare("SELECT name, name_source, collector_kind, kind_evidence, kind_detected_at FROM sources LIMIT 1").get() as any;
    expect(source.name).toBe("宝钗杂货铺");
    expect(source.name_source).toBe("auto");
    expect(source.collector_kind).toBe("genericHtml");
    expect(source.kind_evidence).toMatch(/genericHtml/);
    expect(source.kind_detected_at).toBeTruthy();
  });

  it("采集 → 任务成功 → 商品聚合 + 详情", async () => {
    const { db, app } = setup();
    const created = await app.inject({ method: "POST", url: "/api/sources", payload: { name: "店一", entryUrl: "https://s1.test/", collectorKind: "kami" } });
    const id = created.json().source.id;

    const collect = await app.inject({ method: "POST", url: "/api/collect", payload: { sourceId: id } });
    expect(collect.statusCode).toBe(202);
    const jobId = collect.json().jobId;

    await drainJobs(db, deps); // 等串行调度跑完

    const job = await app.inject({ method: "GET", url: `/api/jobs/${jobId}` });
    expect(job.json().status).toBe("success");

    const products = await app.inject({ method: "GET", url: "/api/products?platform=ChatGPT" });
    const body = products.json();
    expect(body.total).toBeGreaterThanOrEqual(1);
    const card = body.items.find((c: any) => c.canonicalId === "chatgpt-plus");
    expect(card).toBeTruthy();
    expect(card.lowestPrice).toBe(30);
    expect(card.storeCount).toBeGreaterThanOrEqual(1);

    const offers = await app.inject({ method: "GET", url: "/api/products/chatgpt-plus/offers" });
    expect(offers.json().offers.length).toBe(2);
    expect(offers.json().offers[0].price).toBe(30); // 有货最低价在前
    expect(offers.json().offers[0].sourceId).toBe(id);
    expect(offers.json().offers[0].sourceFavorite).toBe(false);
  });

  it("人工验证 API：pending、start、重复启动 409、cancel", async () => {
    resetVerifySessionForTests();
    const page = {
      async addInitScript() {},
      async goto() {},
      async waitForTimeout() { await new Promise((resolve) => setTimeout(resolve, 20)); },
      async close() {},
      async evaluate() {
        return { title: "Just a moment...", bodyText: "", html: "<div id=\"challenge-platform\"></div>" };
      },
    };
    const context = { async newPage() { return page; }, on() {}, async close() {} };
    const { db, app } = setup(deps, { launchContext: async () => context, pollMs: 20, tabTimeoutMs: 500, sessionTimeoutMs: 1000 });
    const created = await app.inject({ method: "POST", url: "/api/sources", payload: { name: "CF 店", entryUrl: "https://cf.test/", collectorKind: "browser", collectionMethod: "browser" } });
    const id = created.json().source.id;
    db.prepare("UPDATE sources SET health_status='manual_required', last_error='Cloudflare 挑战未通过' WHERE id=?").run(id);

    const pending = await app.inject({ method: "GET", url: "/api/verify/pending" });
    expect(pending.statusCode).toBe(200);
    expect(pending.json().items).toHaveLength(1);

    const started = await app.inject({ method: "POST", url: "/api/verify/start" });
    expect(started.statusCode).toBe(202);
    expect(started.json().status).toBe("running");
    const duplicate = await app.inject({ method: "POST", url: "/api/verify/start" });
    expect(duplicate.statusCode).toBe(409);

    const cancelled = await app.inject({ method: "POST", url: "/api/verify/cancel" });
    expect(cancelled.statusCode).toBe(200);
    for (let i = 0; i < 30 && getVerifySessionState().status === "running"; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    resetVerifySessionForTests();
  });

  it("商品列表按平台过滤、分页并保留分组统计语义", async () => {
    const { db, app } = setup();
    insertRawOffer(db, {
      id: "plus-a",
      canonicalId: "chatgpt-plus",
      platform: "ChatGPT",
      title: "ChatGPT Plus A",
      store: "店 A",
      price: 30,
    });
    insertRawOffer(db, {
      id: "plus-b",
      canonicalId: "chatgpt-plus",
      platform: "ChatGPT",
      title: "ChatGPT Plus B",
      store: "店 B",
      price: 25,
    });
    insertRawOffer(db, {
      id: "plus-unknown",
      canonicalId: "chatgpt-plus",
      platform: "ChatGPT",
      title: "ChatGPT Plus C",
      store: "店 C",
      price: 10,
      status: "unknown",
      availabilityRank: 2,
    });
    insertRawOffer(db, {
      id: "plus-hidden",
      canonicalId: "chatgpt-plus",
      platform: "ChatGPT",
      title: "ChatGPT Plus Hidden",
      store: "店 D",
      price: 1,
      hidden: 1,
    });
    insertRawOffer(db, {
      id: "claude-a",
      canonicalId: "claude-pro-month",
      platform: "Claude",
      title: "Claude Pro",
      store: "店 A",
      price: 12,
    });

    const firstPage = await app.inject({ method: "GET", url: "/api/products?page=1&pageSize=1" });
    const firstBody = firstPage.json();
    expect(firstBody.total).toBe(2);
    expect(firstBody.items).toHaveLength(1);
    expect(firstBody.items[0]).toMatchObject({
      canonicalId: "chatgpt-plus",
      resultOfferId: "plus-b",
      lowestPrice: 25,
      storeCount: 3,
      inStockCount: 2,
    });

    const secondPage = await app.inject({ method: "GET", url: "/api/products?page=2&pageSize=1" });
    expect(secondPage.json().total).toBe(2);
    expect(secondPage.json().items[0].canonicalId).toBe("claude-pro-month");

    const emptyPage = await app.inject({ method: "GET", url: "/api/products?page=3&pageSize=1" });
    expect(emptyPage.json().total).toBe(2);
    expect(emptyPage.json().items).toEqual([]);

    const filtered = await app.inject({ method: "GET", url: "/api/products?platform=Claude&pageSize=10" });
    expect(filtered.json().total).toBe(1);
    expect(filtered.json().items[0]).toMatchObject({
      canonicalId: "claude-pro-month",
      platform: "Claude",
      storeCount: 1,
      inStockCount: 1,
    });
  });

  it("商品列表和搜索支持 favoriteOnly/sourceId，空搜索回落 listProducts 时不丢参数", async () => {
    const { db, app } = setup();
    const favoriteSource = await app.inject({ method: "POST", url: "/api/sources", payload: { name: "收藏店", entryUrl: "https://fav.test/", collectorKind: "kami" } });
    const normalSource = await app.inject({ method: "POST", url: "/api/sources", payload: { name: "普通店", entryUrl: "https://normal.test/", collectorKind: "kami" } });
    const favId = favoriteSource.json().source.id;
    const normalId = normalSource.json().source.id;
    await app.inject({ method: "PATCH", url: `/api/sources/${favId}`, payload: { favorite: true } });

    insertRawOffer(db, {
      id: "fav-plus",
      sourceId: favId,
      canonicalId: "chatgpt-plus",
      platform: "ChatGPT",
      title: "ChatGPT Plus 收藏店",
      store: "收藏店",
      price: 20,
    });
    insertRawOffer(db, {
      id: "normal-claude",
      sourceId: normalId,
      canonicalId: "claude-pro-month",
      platform: "Claude",
      title: "Claude Pro 普通店",
      store: "普通店",
      price: 10,
    });

    const favoriteOnly = await app.inject({ method: "GET", url: "/api/products?favoriteOnly=1&pageSize=10" });
    expect(favoriteOnly.json().total).toBe(1);
    expect(favoriteOnly.json().items[0].resultOfferId).toBe("fav-plus");

    const sourceOnly = await app.inject({ method: "GET", url: `/api/products?sourceId=${normalId}&pageSize=10` });
    expect(sourceOnly.json().total).toBe(1);
    expect(sourceOnly.json().items[0].resultOfferId).toBe("normal-claude");

    const emptySearchFallback = await app.inject({ method: "GET", url: `/api/search?q=&favoriteOnly=1&sourceId=${favId}&pageSize=10` });
    expect(emptySearchFallback.json().engine).toBe("sqlite");
    expect(emptySearchFallback.json().total).toBe(1);
    expect(emptySearchFallback.json().items[0].resultOfferId).toBe("fav-plus");

    const searchFiltered = await app.inject({ method: "GET", url: `/api/search?q=claude&favoriteOnly=1&pageSize=10` });
    expect(searchFiltered.json().items).toEqual([]);
  });

  it("收藏店铺摘要只统计前台可展示商品", async () => {
    const { db, app } = setup();
    const created = await app.inject({ method: "POST", url: "/api/sources", payload: { name: "收藏店", entryUrl: "https://fav-summary.test/", collectorKind: "kami" } });
    const sourceId = created.json().source.id;
    await app.inject({ method: "PATCH", url: `/api/sources/${sourceId}`, payload: { favorite: true } });
    insertRawOffer(db, {
      id: "visible",
      sourceId,
      canonicalId: "chatgpt-plus",
      platform: "ChatGPT",
      title: "ChatGPT Plus",
      store: "收藏店",
      price: 20,
    });
    insertRawOffer(db, {
      id: "hidden",
      sourceId,
      canonicalId: "claude-pro-month",
      platform: "Claude",
      title: "Claude Pro",
      store: "收藏店",
      price: 10,
      hidden: 1,
    });
    insertRawOffer(db, {
      id: "sold-out",
      sourceId,
      canonicalId: "gemini-pro-year",
      platform: "Gemini",
      title: "Gemini Pro",
      store: "收藏店",
      price: 9,
      status: "out_of_stock",
      availabilityRank: 3,
    });

    const summary = await app.inject({ method: "GET", url: "/api/sources/favorites" });
    expect(summary.statusCode).toBe(200);
    expect(summary.json().items).toHaveLength(1);
    expect(summary.json().items[0]).toMatchObject({
      id: sourceId,
      favorite: 1,
      listable_product_count: 1,
    });
    expect(summary.json().items[0].latest_offer_at).toBeTruthy();
  });

  it("SQLite 搜索按通用商品关键词匹配 offer，不搜索店铺名", async () => {
    const customDeps = {
      resolveCollector: () => (async () => [
        offer({ sourceTitle: "ChatGPT Plus 月卡", externalKey: "cheap", url: "https://s1.test/?commodity=cheap", price: 8 }),
        offer({ sourceTitle: "chatgptplus共享号无质保", externalKey: "shared", url: "https://s1.test/?commodity=shared", price: 12 }),
        offer({ sourceTitle: "Pix渠道GPT plus成品号 已绑定手机号", externalKey: "pix", url: "https://s1.test/?commodity=pix", price: 18 }),
        offer({ sourceTitle: "Gemini 3.1pro 12个月pixel成品号", externalKey: "pixel", url: "https://s1.test/?commodity=pixel", price: 20 }),
        offer({ sourceTitle: "GPT 资料教程", externalKey: "gpt-guide", url: "https://s1.test/?commodity=gpt-guide", price: 3 }),
        offer({ sourceTitle: "Kiro Pro 月卡", externalKey: "kiro", url: "https://s1.test/?commodity=kiro", price: 28 }),
        offer({ sourceTitle: "xx-kiro-xx 成品号", externalKey: "kiro2", url: "https://s1.test/?commodity=kiro2", price: 26 }),
        offer({ sourceTitle: "GitHub Copilot Pro 账号", externalKey: "github", url: "https://s1.test/?commodity=github", price: 32 }),
        offer({ sourceTitle: "Cursor Pro 账号", externalKey: "cursor", url: "https://s1.test/?commodity=cursor", price: 22 }),
        offer({ sourceTitle: "Windsurf 账号", externalKey: "windsurf", url: "https://s1.test/?commodity=windsurf", price: 24 }),
        offer({ sourceTitle: "codex api 额度 兑换码", externalKey: "codex", url: "https://s1.test/?commodity=codex", price: 40 }),
      ]) as Collector,
    };
    const { db, app } = setup(customDeps);
    const created = await app.inject({ method: "POST", url: "/api/sources", payload: { name: "Kiro 店铺", entryUrl: "https://s1.test/", collectorKind: "kami" } });
    await app.inject({ method: "POST", url: "/api/collect", payload: { sourceId: created.json().source.id } });
    await drainJobs(db, customDeps);

    const byTitle = await app.inject({ method: "GET", url: `/api/search?q=${encodeURIComponent("共享号")}` });
    expect(byTitle.json().engine).toBe("sqlite");
    expect(byTitle.json().items.map((c: any) => c.canonicalId)).toContain("chatgpt-plus");
    const titleCard = byTitle.json().items.find((c: any) => c.canonicalId === "chatgpt-plus");
    expect(titleCard.matchedTitle).toContain("共享号");
    expect(titleCard.representativeTitle).toBeTruthy();
    expect(titleCard.lowestPrice).toBe(8);
    expect(titleCard.resultPrice).toBe(12);
    expect(titleCard.resultTitle).toContain("共享号");

    const byGptPlus = await app.inject({ method: "GET", url: `/api/search?q=${encodeURIComponent("gpt plus")}&pageSize=20` });
    expect(byGptPlus.json().items.map((c: any) => c.canonicalId)).toContain("chatgpt-plus");

    const byBroadKeyword = await app.inject({ method: "GET", url: "/api/search?q=gpt&pageSize=20" });
    expect(byBroadKeyword.json().items.map((c: any) => c.resultTitle)).not.toContain("GPT 资料教程");

    const byAsciiToken = await app.inject({ method: "GET", url: "/api/search?q=pix" });
    const ids = byAsciiToken.json().items.map((c: any) => c.canonicalId);
    expect(ids).toContain("chatgpt-plus");
    expect(ids).not.toContain("gemini-pro-year");

    for (const term of ["kiro", "github", "codex", "cursor", "windsurf"]) {
      const r = await app.inject({ method: "GET", url: `/api/search?q=${encodeURIComponent(term)}&pageSize=20` });
      expect(r.json().items.length, term).toBeGreaterThan(0);
      expect(r.json().items.some((c: any) => c.resultTitle.toLowerCase().includes(term) || c.displayName.toLowerCase().includes(term))).toBe(true);
    }

    const byKiro = await app.inject({ method: "GET", url: "/api/search?q=kiro&pageSize=20" });
    expect(byKiro.json().items.map((c: any) => c.resultTitle)).not.toContain("Gemini 3.1pro 12个月pixel成品号");
  });

  it("重建分类返回分布", async () => {
    const { db, app } = setup();
    const created = await app.inject({ method: "POST", url: "/api/sources", payload: { name: "店一", entryUrl: "https://s1.test/", collectorKind: "kami" } });
    await app.inject({ method: "POST", url: "/api/collect", payload: { sourceId: created.json().source.id } });
    await drainJobs(db, deps);
    const r = await app.inject({ method: "POST", url: "/api/reclassify" });
    expect(r.json().updated).toBeGreaterThanOrEqual(0);
    expect(r.json().distribution["chatgpt-plus"]).toBeGreaterThanOrEqual(1);
  });

  it("收藏：增/幂等/列表回查/取消", async () => {
    const { db, app } = setup();
    const created = await app.inject({ method: "POST", url: "/api/sources", payload: { name: "店一", entryUrl: "https://s1.test/", collectorKind: "kami" } });
    await app.inject({ method: "POST", url: "/api/collect", payload: { sourceId: created.json().source.id } });
    await drainJobs(db, deps);
    const offers = await app.inject({ method: "GET", url: "/api/products/chatgpt-plus/offers" });
    const offerId = offers.json().offers[0].id;

    expect((await app.inject({ method: "POST", url: "/api/favorites", payload: { offerId } })).json().created).toBe(true);
    expect((await app.inject({ method: "POST", url: "/api/favorites", payload: { offerId } })).json().created).toBe(false);
    expect((await app.inject({ method: "GET", url: "/api/favorites/ids" })).json().ids).toContain(offerId);
    const list = await app.inject({ method: "GET", url: "/api/favorites" });
    expect(list.json().items[0].live).toBe(true);
    expect((await app.inject({ method: "DELETE", url: `/api/favorites/${offerId}` })).json().removed).toBe(true);
  });

  it("crawl-runs 有记录", async () => {
    const { db, app } = setup();
    const created = await app.inject({ method: "POST", url: "/api/sources", payload: { name: "店一", entryUrl: "https://s1.test/", collectorKind: "kami" } });
    await app.inject({ method: "POST", url: "/api/collect", payload: { sourceId: created.json().source.id } });
    await drainJobs(db, deps);
    const r = await app.inject({ method: "GET", url: "/api/crawl-runs" });
    expect(r.json().items.length).toBeGreaterThanOrEqual(1);
  });
});
