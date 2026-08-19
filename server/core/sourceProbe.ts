import type { SqliteDatabase } from "../db/connection";
import { findSourceByEntryUrl, listSourcesNeedingKindMigration, nowIso, persistSourceKind, targetFromSource, updateSource, type SourceRow } from "../db/repo";
import { collectorFor, detectCollector } from "../collectors";
import type { CollectorKind, CollectorOffer, CollectorTarget, ProbeAttempt } from "../collectors/types";
import { deriveBaseUrl, normalizeHostname, shopTokenFromUrl } from "../collectors/util";
import { httpClient, type HttpClient } from "./http";
import { isLiandongSource, withProxySession } from "./proxy";

export interface NormalizedSourceUrl {
  rawUrl: string;
  entryUrl: string;
  baseUrl: string;
  shopToken: string | null;
  knownItemUrls?: string[];
}

export interface SourceProbeDuplicate {
  id: string;
  name: string;
}

export interface SourceProbeResult {
  normalized: NormalizedSourceUrl;
  kind: CollectorKind;
  evidence: string;
  storeName: string | null;
  offers: CollectorOffer[];
  attempts: ProbeAttempt[];
  duplicate: SourceProbeDuplicate | null;
}

export interface MigrationItem {
  id: string;
  name: string;
  oldKind: string | null;
  kind: CollectorKind;
  evidence: string;
  attempts: ProbeAttempt[];
  updated: boolean;
  error?: string;
}

export interface SourceKindMigrationResult {
  total: number;
  updated: number;
  items: MigrationItem[];
}

function ensureUrl(value: string): URL {
  const trimmed = value.trim();
  if (!trimmed) throw new Error("URL 必填");
  const withProtocol = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  const url = new URL(withProtocol);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("仅支持 http/https URL");
  url.hash = "";
  return url;
}

export function normalizeSourceUrl(value: string): NormalizedSourceUrl {
  const raw = ensureUrl(value);
  const baseUrl = deriveBaseUrl(raw.toString()).replace(/\/$/, "");
  const rawPath = raw.pathname || "/";
  const rawUrl = raw.toString();
  const knownItemUrls = /\/item\/[^/?#]+/.test(rawPath) ? [rawUrl] : undefined;

  let entryUrl = rawUrl;
  if (/\/buy\/\d+/.test(rawPath) || raw.searchParams.has("commodity")) {
    entryUrl = `${baseUrl}/`;
  } else if (/\/shop\/[^/?#]+/.test(rawPath)) {
    raw.search = "";
    entryUrl = raw.toString();
  } else if (rawPath === "" || rawPath === "/") {
    entryUrl = `${baseUrl}/`;
  }

  return {
    rawUrl,
    entryUrl,
    baseUrl,
    shopToken: shopTokenFromUrl(entryUrl),
    knownItemUrls,
  };
}

function deriveProbeName(url: string): string {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, "");
    const token = u.pathname.match(/\/shop\/([^/?#]+)/)?.[1];
    return token ? `${host} / ${decodeURIComponent(token)}` : host;
  } catch {
    return url;
  }
}

function decodeHtmlText(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function stripTags(value: string): string {
  return decodeHtmlText(value.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " "));
}

function cleanPageTitle(value: string): string | null {
  const text = decodeHtmlText(value)
    .replace(/\s+/g, " ")
    .replace(/[｜|].*$/, "")
    .replace(/\s+[-_]\s+(购买|发卡|商城|首页|自助下单|自动发货|卡密|商品).*$/i, "")
    .replace(/[-_｜|]\s*(购买|发卡|商城|首页|自助下单|自动发货|卡密|商品|官方站|官网)\s*$/i, "")
    .replace(/\s*(购买|发卡|商城|首页|自助下单|自动发货|卡密|商品)\s*$/i, "")
    .trim();
  if (!text || text.length > 60) return null;
  if (/^(首页|商城|发卡|购买|自动发货|自助下单)$/i.test(text)) return null;
  return text;
}

function metaContent(html: string, name: string): string | null {
  const re = new RegExp(`<meta\\b(?=[^>]*(?:property|name)=["']${name}["'])(?=[^>]*content=["']([^"']+)["'])[^>]*>`, "i");
  const match = html.match(re);
  return match?.[1] ? cleanPageTitle(match[1]) : null;
}

function extractHtmlStoreName(html: string): string | null {
  const og = metaContent(html, "og:site_name");
  if (og) return og;

  const brand = html.match(/<a\b[^>]*(?:class|id)=["'][^"']*(?:logo|brand|navbar-brand)[^"']*["'][^>]*>([\s\S]*?)<\/a>/i)?.[1];
  const cleanBrand = brand ? cleanPageTitle(stripTags(brand)) : null;
  if (cleanBrand) return cleanBrand;

  const h1 = html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1];
  const cleanH1 = h1 ? cleanPageTitle(stripTags(h1)) : null;
  if (cleanH1) return cleanH1;

  const title = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  return title ? cleanPageTitle(stripTags(title)) : null;
}

function normalizeNameForCompare(value: string): string {
  return value.trim().replace(/^www\./i, "").replace(/\/$/, "").toLowerCase();
}

export function isWeakSourceName(name: string | null | undefined, entryUrl: string): boolean {
  const text = String(name ?? "").trim();
  if (!text) return true;
  if (/^\d+$/.test(text)) return true;
  const derived = deriveProbeName(entryUrl);
  return normalizeNameForCompare(text) === normalizeNameForCompare(derived);
}

export function canAutoUpdateStoreName(source: Pick<SourceRow, "name" | "name_source" | "entry_url">, nextName: string | null): boolean {
  if (!nextName || normalizeNameForCompare(nextName) === normalizeNameForCompare(source.name)) return false;
  if (source.name_source === "manual") return false;
  return isWeakSourceName(source.name, source.entry_url);
}

export async function resolveStoreName(
  target: CollectorTarget,
  http: HttpClient,
  offers: CollectorOffer[] = [],
  probeHtml?: string | null,
): Promise<string> {
  const fromOffer = offers.map((offer) => offer.sourceStoreName?.trim()).find(Boolean);
  if (fromOffer) return fromOffer;
  if (target.sourceStoreName?.trim()) return target.sourceStoreName.trim();

  let html = probeHtml ?? null;
  if (html == null) {
    try {
      html = await http.fetchText(target.sourceUrl);
    } catch {
      html = null;
    }
  }
  const fromHtml = html ? extractHtmlStoreName(html) : null;
  return fromHtml ?? deriveProbeName(target.sourceUrl);
}

async function collectPreview(
  target: CollectorTarget,
  kind: CollectorKind,
  http: HttpClient,
  attempts: ProbeAttempt[],
): Promise<CollectorOffer[]> {
  if (kind === "browser" || kind === "pending" || kind === "unsupported" || kind === "auto") return [];
  const started = performance.now();
  try {
    const offers = await collectorFor(kind, target.sourceUrl)(target, http);
    attempts.push({ step: "previewCollect", ok: offers.length > 0, ms: Math.round(performance.now() - started), message: `预览采集 ${offers.length} 条` });
    return offers;
  } catch (err) {
    attempts.push({
      step: "previewCollect",
      ok: false,
      ms: Math.round(performance.now() - started),
      message: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

export async function probeSourceUrl(
  db: SqliteDatabase,
  url: string,
  deps: { http?: HttpClient } = {},
): Promise<SourceProbeResult> {
  const normalized = normalizeSourceUrl(url);
  const duplicateRow = findSourceByEntryUrl(db, normalized.entryUrl);
  const target: CollectorTarget = {
    sourceId: "probe",
    sourceName: deriveProbeName(normalized.entryUrl),
    sourceUrl: normalized.entryUrl,
    baseUrl: normalized.baseUrl,
    knownItemUrls: normalized.knownItemUrls,
  };
  const http = deps.http ?? httpClient;
  // 加店时店铺还没入库，没有 collector_kind 可依，只能按 URL 形态判断该不该走代理。
  return withProxySession(async () => {
    const detected = await detectCollector(target, http);
    const attempts = [...(detected.attempts ?? [])];
    let offers = detected.offers ?? [];
    if (!offers.length) {
      offers = await collectPreview(target, detected.kind, http, attempts);
    }

    return {
      normalized,
      kind: detected.kind,
      evidence: detected.evidence,
      storeName: await resolveStoreName(target, http, offers),
      offers,
      attempts,
      duplicate: duplicateRow ? { id: duplicateRow.id, name: duplicateRow.name } : null,
    };
  }, { useProxy: isLiandongSource({ entryUrl: normalized.entryUrl }) });
}

export async function migrateSourceKinds(
  db: SqliteDatabase,
  deps: { http?: HttpClient } = {},
): Promise<SourceKindMigrationResult> {
  const http = deps.http ?? httpClient;
  const sources = listSourcesNeedingKindMigration(db);
  const items: MigrationItem[] = [];

  for (const source of sources) {
    const oldKind = source.collector_kind;
    try {
      const target = targetFromSource(source);
      const { detected, storeName } = await withProxySession(async () => {
        const d = await detectCollector(target, http);
        return { detected: d, storeName: await resolveStoreName(target, http, d.offers ?? []) };
      }, { useProxy: isLiandongSource({ collectorKind: source.collector_kind, entryUrl: source.entry_url }) });
      const at = nowIso();
      const collectionMethod = detected.kind === "browser" ? "browser" : source.collection_method;
      let updated = persistSourceKind(db, source.id, {
        kind: detected.kind,
        method: collectionMethod,
        at,
        evidence: detected.evidence,
      });
      if (canAutoUpdateStoreName(source, storeName)) {
        updated = updateSource(db, source.id, { name: storeName, nameSource: "auto" }) || updated;
      }
      items.push({
        id: source.id,
        name: storeName,
        oldKind,
        kind: detected.kind,
        evidence: detected.evidence,
        attempts: detected.attempts ?? [],
        updated,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const evidence = `识别失败：${message}`;
      const updated = persistSourceKind(db, source.id, {
        kind: "pending",
        at: nowIso(),
        evidence,
      });
      items.push({
        id: source.id,
        name: source.name,
        oldKind,
        kind: "pending",
        evidence,
        attempts: [],
        updated,
        error: message,
      });
    }
  }

  return {
    total: items.length,
    updated: items.filter((item) => item.updated).length,
    items,
  };
}

export function sourceSlugFromUrl(entryUrl: string): string {
  return normalizeHostname(entryUrl).split(".")[0] || "shop";
}

export function sourceNameFromUrl(entryUrl: string): string {
  return deriveProbeName(entryUrl);
}
