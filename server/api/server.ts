import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import type { SqliteDatabase } from "../db/connection";
import {
  upsertSource, updateSource, deleteSource, getSource, findSourceByEntryUrl, findSiteWideDuplicate, persistSourceKind, resetSourceForReidentify, setSourceFavorite,
  targetFromSource, upsertOffers, recordCrawlRun, markSourceSuccess, nowIso,
  type SourceRow,
} from "../db/repo";
import { listSourcesView, listProducts, searchOffers, getProductOffers, listCrawlRuns, listJobs, getJob, listSourceMethodDrift, listFavoriteSources } from "../db/data";
import { addFavorite, removeFavorite, listFavorites, favoriteOfferIds } from "../db/favorites";
import { reclassifyAll } from "../db/reclassify";
import { enqueueJob } from "../core/jobs";
import { kickScheduler } from "../core/scheduler";
import type { CollectDeps } from "../core/orchestrator";
import {
  cancelVerifySession,
  getVerifySessionState,
  listPendingVerifySources,
  startVerifySession,
  VerifySessionAlreadyRunningError,
  type VerifyDeps,
} from "../core/verify";
import { migrateSourceKinds, normalizeSourceUrl, probeSourceUrl, sourceNameFromUrl, sourceSlugFromUrl } from "../core/sourceProbe";
import { probeStoreName } from "../core/storeName";
import {
  addFavoriteStore, getFavoriteStore, listFavoriteStoreCategories, listFavoriteStores,
  refreshAutoName, removeFavoriteStore, updateFavoriteStore,
} from "../db/favoriteStores";
import type { CollectorOffer } from "../collectors/types";

export interface BuildOptions {
  deps?: CollectDeps & { concurrency?: number };
  verify?: VerifyDeps;
}

/** 名称留空时按链接自动生成：链动小铺用 `域名 / token`，其它用域名。 */
function deriveSourceName(url: string): string {
  return sourceNameFromUrl(url);
}

function manualKindEvidence(source: SourceRow | null, nextKind: string | null, nextMethod?: string): string {
  const previousKind = source?.collector_kind || "auto";
  const next = nextKind || "auto";
  const oldEvidence = source?.kind_evidence ? `原识别证据：${source.kind_evidence}；` : "";
  if (next === "browser" || nextMethod === "browser") {
    return `${oldEvidence}人工选择浏览器采集：${previousKind} → ${next}`;
  }
  return `${oldEvidence}人工设置采集器：${previousKind} → ${next}`;
}

function parseBooleanParam(value: unknown): boolean {
  return value === true || value === "1" || value === "true";
}

function parseNameSource(value: unknown, fallback: "auto" | "manual"): "auto" | "manual" {
  if (value == null || value === "") return fallback;
  if (value === "auto" || value === "manual") return value;
  throw new Error("nameSource 必须是 auto 或 manual");
}

function probeOffersFromBody(value: unknown): CollectorOffer[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw) => {
    if (!raw || typeof raw !== "object") return [];
    const item = raw as Record<string, any>;
    const sourceTitle = String(item.sourceTitle ?? "").trim();
    const url = String(item.url ?? "").trim();
    if (!sourceTitle || !url) return [];
    return [{
      sourceTitle,
      url,
      price: typeof item.price === "number" && Number.isFinite(item.price) ? item.price : null,
      status: typeof item.status === "string" && item.status.trim() ? item.status : "unknown",
      tags: Array.isArray(item.tags) ? item.tags.map(String) : [],
      stockCount: typeof item.stockCount === "number" && Number.isFinite(item.stockCount) ? item.stockCount : null,
      stockText: item.stockText == null ? null : String(item.stockText),
      currency: typeof item.currency === "string" && item.currency.trim() ? item.currency : "CNY",
      sourceStoreName: item.sourceStoreName == null ? undefined : String(item.sourceStoreName),
      externalKey: item.externalKey == null ? null : String(item.externalKey),
    } satisfies CollectorOffer];
  });
}

/** 构建 Fastify 实例（单写者：所有写库经此进程）。db 由调用方注入并管理生命周期。 */
export function buildServer(db: SqliteDatabase, options: BuildOptions = {}): FastifyInstance {
  const deps = options.deps ?? {};
  const app = Fastify({ logger: false });
  app.register(cors, { origin: true });

  app.get("/api/health", async () => ({ ok: true, ts: new Date().toISOString() }));

  // ---- 店铺 ----
  app.get("/api/sources", async () => ({ items: listSourcesView(db) }));
  app.get("/api/sources/favorites", async () => ({ items: listFavoriteSources(db) }));

  app.get("/api/sources/audit", async () => ({ methodDrift: listSourceMethodDrift(db) }));

  // ---- 收藏的店铺链接 ----
  // 与采集完全无关：只记住入口 + 探测一次店铺名。后台 ★ 的采集店铺会同步进同一张表。
  app.get("/api/favorite-stores", async () => ({
    items: listFavoriteStores(db),
    categories: listFavoriteStoreCategories(db),
  }));

  app.post("/api/favorite-stores", async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, any>;
    if (!b.url) return reply.code(400).send({ error: "url 必填" });
    let probed: { url: string; name: string; via: string };
    try {
      probed = await probeStoreName(String(b.url), { http: deps.http });
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
    }
    // 收藏一个已在采集的店铺 = 给它点 ★。不认领的话同一家店会在收藏页出现两条，
    // 而且后台星是暗的、收藏页却有，两边对不上。
    const known = findSourceByEntryUrl(db, probed.url);
    if (known && !known.favorite) setSourceFavorite(db, known.id, true);

    // 用户填了名字就以用户为准，不被探测结果覆盖
    const manual = String(b.name ?? "").trim();
    const r = addFavoriteStore(db, {
      url: probed.url,
      name: manual || probed.name,
      nameSource: manual ? "manual" : "auto",
      ...(b.category !== undefined ? { category: b.category } : {}),
      note: b.note ?? null,
    });
    if (manual && !r.created) updateFavoriteStore(db, r.row.id, { name: manual });
    // 已存在的行可能还叫「域名 / token」（★ 同步建行时用的是采集店铺当时的名字），
    // 探测拿到真名就刷上去；手动改过名的不动。
    else if (!manual && probed.via !== "fallback") refreshAutoName(db, r.row.id, probed.name);
    return reply.code(r.created ? 201 : 200).send({
      row: getFavoriteStore(db, r.row.id),
      created: r.created,
      nameVia: manual ? "manual" : probed.via,
    });
  });

  app.patch("/api/favorite-stores/:id", async (req, reply) => {
    const id = String((req.params as any).id);
    if (!getFavoriteStore(db, id)) return reply.code(404).send({ error: "收藏不存在" });
    const b = (req.body ?? {}) as Record<string, any>;
    try {
      return { updated: true, row: updateFavoriteStore(db, id, b) };
    } catch (err) {
      const code = (err as any)?.statusCode ?? 400;
      return reply.code(code).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.delete("/api/favorite-stores/:id", async (req, reply) => {
    const r = removeFavoriteStore(db, String((req.params as any).id));
    if (!r.removed) return reply.code(404).send({ error: "收藏不存在" });
    // 这条是 ★ 同步来的 → 同时熄灭后台的 ★，否则星是亮的、收藏却没了
    if (r.sourceId) setSourceFavorite(db, r.sourceId, false);
    return { removed: true };
  });

  app.post("/api/sources/probe", async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, any>;
    if (!b.url) return reply.code(400).send({ error: "url 必填" });
    try {
      return await probeSourceUrl(db, String(b.url), { http: deps.http });
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post("/api/sources/migrate-kinds", async () => migrateSourceKinds(db, { http: deps.http }));

  app.post("/api/sources/:id/reidentify", async (req, reply) => {
    const id = (req.params as any).id as string;
    if (!getSource(db, id)) return reply.code(404).send({ error: "店铺不存在" });
    resetSourceForReidentify(db, id);
    const job = enqueueJob(db, { jobType: "source", sourceId: id, requestedBy: "ui-reidentify" });
    kickScheduler(db, deps);
    return reply.code(202).send({ source: getSource(db, id), job });
  });

  app.post("/api/sources", async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, any>;
    if (!b.entryUrl) return reply.code(400).send({ error: "entryUrl 必填" });
    let normalized;
    try {
      normalized = normalizeSourceUrl(String(b.entryUrl));
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
    }
    const entryUrl = normalized.entryUrl;
    // 链接查重：同一个（规范化后）入口 URL 不允许重复添加
    const dup = findSourceByEntryUrl(db, entryUrl);
    if (dup) return reply.code(409).send({ error: "该链接已存在", source: getSource(db, dup.id) });
    // 名称可留空 → 按链接自动生成；用户手填才标记 manual，probe 自动带出的店名仍是 auto。
    const suppliedName = b.name ? String(b.name).trim() : "";
    let nameSource: "auto" | "manual";
    try {
      nameSource = parseNameSource(b.nameSource, suppliedName ? "manual" : "auto");
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
    }
    const name = suppliedName || deriveSourceName(entryUrl);
    const kind = String(b.collectorKind ?? "auto");
    // 整站型采集器（独角/卡网）填站内任意页面都会采到同一批全站商品，
    // 同域名再加一个源只是把相同商品采两遍，前台就会重复显示 → 直接拒绝。
    const siteDup = findSiteWideDuplicate(db, entryUrl, kind);
    if (siteDup) {
      return reply.code(409).send({
        error: `该站点已添加过（${siteDup.name}），同一站点只需保留一个入口`,
        source: getSource(db, siteDup.id),
      });
    }
    const collectionMethod = String(b.collectionMethod ?? (kind === "browser" ? "browser" : "http"));
    const kindEvidence = b.kindEvidence ? String(b.kindEvidence) : kind === "auto" ? null : manualKindEvidence(null, kind, collectionMethod);
    const kindDetectedAt = kindEvidence ? String(b.kindDetectedAt || new Date().toISOString()) : null;
    const id = String(b.id || `src-${sourceSlugFromUrl(entryUrl)}-${randomUUID().slice(0, 6)}`);
    upsertSource(db, {
      id, name, nameSource, entryUrl, baseUrl: b.baseUrl ?? normalized.baseUrl,
      collectorKind: kind, collectionMethod, enabled: b.enabled !== false,
      notes: b.notes ? String(b.notes) : null,
      kindDetectedAt,
      kindEvidence,
    });
    const offers = probeOffersFromBody(b.offers);
    if (offers.length > 0) {
      const source = getSource(db, id);
      if (source) {
        const startedAt = nowIso();
        const finishedAt = nowIso();
        const target = targetFromSource(source);
        const write = db.transaction(() => upsertOffers(db, target, collectionMethod === "browser" ? "browser" : "http", offers));
        const result = write();
        recordCrawlRun(db, {
          id: randomUUID(),
          sourceId: id,
          sourceName: source.name,
          mode: "probe-add",
          status: "success",
          startedAt,
          finishedAt,
          successCount: result.written,
          failureCount: 0,
          message: "识别预览商品已随添加入库",
          details: { received: offers.length, seenCount: result.seenIds.length },
        });
        markSourceSuccess(db, id, "success", finishedAt);
      }
    }
    return reply.code(201).send({ source: getSource(db, id) });
  });

  app.patch("/api/sources/:id", async (req, reply) => {
    const id = (req.params as any).id as string;
    const current = getSource(db, id);
    if (!current) return reply.code(404).send({ error: "店铺不存在" });
    const body = { ...((req.body ?? {}) as Record<string, any>) };
    if ("favoritedAt" in body || "favorited_at" in body) {
      return reply.code(400).send({ error: "favorited_at 由服务端维护" });
    }
    const hasKindPatch = "collectorKind" in body || "kindEvidence" in body || "kindDetectedAt" in body;
    let ok = false;
    if ("nameSource" in body) {
      try {
        body.nameSource = parseNameSource(body.nameSource, "manual");
      } catch (err) {
        return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
      }
    }
    if ("name" in body && !("nameSource" in body)) body.nameSource = "manual";
    if ("favorite" in body) {
      if (typeof body.favorite !== "boolean") return reply.code(400).send({ error: "favorite 必须是 boolean" });
      setSourceFavorite(db, id, body.favorite);
      delete body.favorite;
      ok = true;
    }
    if (hasKindPatch) {
      const nextKind = "collectorKind" in body ? (body.collectorKind == null ? null : String(body.collectorKind)) : current.collector_kind;
      const nextMethod = "collectionMethod" in body ? String(body.collectionMethod) : undefined;
      const evidence = body.kindEvidence ? String(body.kindEvidence) : manualKindEvidence(current, nextKind, nextMethod);
      const at = body.kindDetectedAt ? String(body.kindDetectedAt) : new Date().toISOString();
      delete body.collectorKind;
      delete body.kindEvidence;
      delete body.kindDetectedAt;
      if (nextMethod !== undefined) delete body.collectionMethod;
      ok = persistSourceKind(db, id, { kind: nextKind, evidence, at, method: nextMethod });
    }
    const patchOk = updateSource(db, id, body as any);
    ok = ok || patchOk;
    return { updated: ok, source: getSource(db, id) };
  });

  app.delete("/api/sources/:id", async (req) => {
    const id = (req.params as any).id as string;
    const deleteOffers = String((req.query as any)?.deleteOffers ?? "") === "1";
    return deleteSource(db, id, deleteOffers);
  });

  // ---- 采集（入队 + 触发串行调度）----
  app.post("/api/collect", async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, any>;
    let result;
    if (b.all) {
      result = enqueueJob(db, { jobType: "all", requestedBy: "ui" });
    } else if (b.sourceId) {
      if (!getSource(db, String(b.sourceId))) return reply.code(404).send({ error: "店铺不存在" });
      result = enqueueJob(db, { jobType: "source", sourceId: String(b.sourceId), requestedBy: "ui" });
    } else {
      return reply.code(400).send({ error: "需要 all=true 或 sourceId" });
    }
    kickScheduler(db, deps);
    return reply.code(202).send(result);
  });

  app.get("/api/jobs", async () => ({ items: listJobs(db) }));
  app.get("/api/jobs/:id", async (req, reply) => {
    const job = getJob(db, (req.params as any).id);
    if (!job) return reply.code(404).send({ error: "任务不存在" });
    return job;
  });

  // ---- 人工验证 / CF 盾站 ----
  app.get("/api/verify/pending", async () => ({ items: listPendingVerifySources(db) }));

  app.post("/api/verify/start", async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, any>;
    const sourceIds = Array.isArray(b.sourceIds) ? b.sourceIds.map(String).filter(Boolean) : undefined;
    try {
      return reply.code(202).send(startVerifySession(db, { sourceIds, deps: options.verify }));
    } catch (err) {
      if (err instanceof VerifySessionAlreadyRunningError) return reply.code(409).send({ error: err.message, state: getVerifySessionState() });
      throw err;
    }
  });

  app.get("/api/verify/status", async () => getVerifySessionState());

  app.post("/api/verify/cancel", async () => cancelVerifySession());

  // ---- 采集日志 ----
  app.get("/api/crawl-runs", async (req) => {
    const q = (req.query ?? {}) as Record<string, any>;
    return { items: listCrawlRuns(db, { sourceId: q.sourceId, limit: q.limit ? Number(q.limit) : undefined }) };
  });

  // ---- 重建分类 ----
  app.post("/api/reclassify", async () => reclassifyAll(db));

  // ---- 前台商品 ----
  app.get("/api/products", async (req) => {
    const q = (req.query ?? {}) as Record<string, any>;
    return listProducts(db, {
      platform: q.platform, q: q.q,
      favoriteOnly: parseBooleanParam(q.favoriteOnly),
      sourceId: q.sourceId ? String(q.sourceId) : undefined,
      page: q.page ? Number(q.page) : undefined,
      pageSize: q.pageSize ? Number(q.pageSize) : undefined,
    });
  });

  app.get("/api/products/:id/offers", async (req) => getProductOffers(db, (req.params as any).id));

  // ---- 搜索：SQLite + Node 侧规则打分 ----
  app.get("/api/search", async (req) => {
    const q = (req.query ?? {}) as Record<string, any>;
    const query = String(q.q ?? "").trim();
    const platform = q.platform ? String(q.platform) : undefined;
    // 默认价格优先，与前台一致：显式传 sort=relevance 才按匹配度排。
    const sort = q.sort === "relevance" ? "relevance" : "price";
    const page = q.page ? Number(q.page) : 1;
    const pageSize = q.pageSize ? Number(q.pageSize) : 24;
    const favoriteOnly = parseBooleanParam(q.favoriteOnly);
    const sourceId = q.sourceId ? String(q.sourceId) : undefined;

    if (!query) {
      return { ...listProducts(db, { platform, page, pageSize, favoriteOnly, sourceId }), engine: "sqlite" };
    }

    return { ...searchOffers(db, { platform, q: query, sort, page, pageSize, favoriteOnly, sourceId }), engine: "sqlite" };
  });

  // ---- 收藏（offer 级）----
  app.get("/api/favorites", async () => ({ items: listFavorites(db) }));
  app.get("/api/favorites/ids", async () => ({ ids: favoriteOfferIds(db) }));
  app.post("/api/favorites", async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, any>;
    if (!b.offerId) return reply.code(400).send({ error: "需要 offerId" });
    try {
      return addFavorite(db, String(b.offerId), b.note ?? null);
    } catch (e: any) {
      return reply.code(e?.statusCode === 404 ? 404 : 500).send({ error: e?.message || "收藏失败" });
    }
  });
  app.delete("/api/favorites/:offerId", async (req) => removeFavorite(db, (req.params as any).offerId));

  // ---- 托管已构建的前端（web/dist）：后端 + 前端合并为一个进程一个端口 ----
  // 总是注册静态托管：即使启动时前端尚未构建，也先放一个占位 index.html；
  // 之后 `npm run build:web` 写入真实产物，@fastify/static 在「请求时」读盘，刷新即生效，无需重启后端。
  const distDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../web/dist");
  mkdirSync(distDir, { recursive: true });
  const indexPath = path.join(distDir, "index.html");
  if (!existsSync(indexPath)) {
    writeFileSync(
      indexPath,
      "<!doctype html><meta charset=utf-8><body style=\"font-family:sans-serif;padding:40px;color:#333\">前端尚未构建。请在 shop-manager 目录运行 <code>npm run build:web</code> 后刷新本页。</body>",
    );
  }
  app.register(fastifyStatic, {
    root: distDir,
    prefix: "/",
    setHeaders(res, p) {
      // index.html 不缓存（指向带 hash 的资源），资源本身可长期缓存 → rebuild 后刷新即生效
      if (p.endsWith("index.html")) res.setHeader("cache-control", "no-cache");
    },
  });
  app.setNotFoundHandler((req, reply) => {
    if (req.method === "GET" && !req.url.startsWith("/api")) {
      return reply.sendFile("index.html"); // SPA 回退
    }
    return reply.code(404).send({ error: "not found" });
  });

  return app;
}
