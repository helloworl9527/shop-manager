import type { Collector, CollectorOffer, CollectorTarget } from "./types";
import type { HttpClient } from "../core/http";
import { withVariant } from "../core/ids";
import { cleanText, compact, isNonComparableTitle, numberOrNull, statusFromStock } from "./util";

const PRICE_VALUE = String.raw`(\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)`;
const PRICE_RE = new RegExp(String.raw`(?:[¥￥]\s*|PRICE\s*|价格[:：]?\s*)${PRICE_VALUE}|${PRICE_VALUE}\s*(?:CNY|RMB|元)`, "i");
const STOCK_RE = /库存[:：]?\s*(\d+)|(\d+)\s*件现货/i;
const BUY_RE = /href=["']([^"']*\/buy\/(\d+)[^"']*)["'][^>]*>/gi;
const SKU_RE = /selectSku\(\s*(['"])(.*?)\1\s*,\s*(['"])(.*?)\3/gi;

function decodeEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

function absUrl(base: string, href: string): string {
  try {
    return new URL(href, base).toString();
  } catch {
    return href;
  }
}

function stripTags(value: string): string {
  return decodeEntities(value.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " "));
}

function priceFromText(value: string): number | null {
  const match = value.match(PRICE_RE);
  return match ? numberOrNull(match[0]) : null;
}

function stockFromText(value: string): number | null {
  const match = value.match(STOCK_RE);
  return match ? numberOrNull(match[1] ?? match[2]) : null;
}

function soldOut(value: string): boolean {
  return /缺货|已售罄|售罄|无货|sold\s*out/i.test(value);
}

function titleFromBlock(block: string, fallback: string): string {
  const candidates = [
    block.match(/<h[1-5][^>]*>([\s\S]*?)<\/h[1-5]>/i)?.[1],
    block.match(/\btitle=["']([^"']+)["']/i)?.[1],
    block.match(/\balt=["']([^"']+)["']/i)?.[1],
    fallback,
    stripTags(block),
  ];
  for (const candidate of candidates) {
    let title = cleanText(stripTags(String(candidate ?? "")))
      .replace(PRICE_RE, " ")
      .replace(/库存[:：]?\s*\d+|\d+\s*件现货/g, " ")
      .replace(/购买|立即购买|查看详情|自动发货|人工处理|下单|库存|价格/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (title.length > 120) {
      const parts = title.split(/\s{2,}|[。；;，,|]/).map((p) => p.trim()).filter(Boolean);
      title = parts.find((p) => p.length >= 4 && p.length <= 80) ?? title.slice(0, 120);
    }
    if (title.length >= 4 && !isNonComparableTitle(title)) return title.slice(0, 140);
  }
  return "";
}

function blockAround(html: string, index: number): string {
  const start = Math.max(0, index - 1800);
  const end = Math.min(html.length, index + 2200);
  return html.slice(start, end);
}

function cardBlockAround(html: string, index: number): string {
  const before = html.slice(0, index);
  const openRe = /<(div|article|section|li)\b[^>]*class=["'][^"']*(?:product|goods|item|card|position-relative)[^"']*["'][^>]*>/gi;
  let selected: { tag: string; index: number } | null = null;
  for (const match of before.matchAll(openRe)) selected = { tag: match[1]!, index: match.index ?? 0 };
  if (!selected) return blockAround(html, index);
  const closeRe = new RegExp(`</${selected.tag}>`, "ig");
  closeRe.lastIndex = index;
  const close = closeRe.exec(html);
  if (!close) return blockAround(html, index);
  return html.slice(selected.index, close.index + close[0].length);
}

interface BaseProduct {
  buyId: string;
  url: string;
  title: string;
  price: number | null;
  status: string;
  stockCount: number | null;
}

function parseBaseProducts(target: CollectorTarget, html: string): BaseProduct[] {
  const products = new Map<string, BaseProduct>();
  for (const match of html.matchAll(BUY_RE)) {
    const href = match[1];
    const buyId = match[2];
    if (!href || !buyId || products.has(buyId)) continue;
    const block = cardBlockAround(html, match.index ?? 0);
    const text = stripTags(block);
    const price = priceFromText(text);
    const stockCount = stockFromText(text);
    const title = titleFromBlock(block, stripTags(match[0] ?? ""));
    if (!title || price === null) continue;
    products.set(buyId, {
      buyId,
      url: absUrl(target.baseUrl, href),
      title,
      price,
      stockCount,
      status: soldOut(text) || stockCount === 0 ? "out_of_stock" : statusFromStock(stockCount),
    });
  }
  return [...products.values()].slice(0, 200);
}

function parseSkuOffers(target: CollectorTarget, product: BaseProduct, detailHtml: string): CollectorOffer[] {
  const offers: CollectorOffer[] = [];
  for (const match of detailHtml.matchAll(SKU_RE)) {
    const skuName = cleanText(decodeEntities(match[2] ?? ""));
    const price = numberOrNull(match[4]);
    if (!skuName || price === null) continue;
    const detailText = stripTags(detailHtml);
    const stockCount = stockFromText(detailText);
    const title = `${product.title} ${skuName}`.trim();
    offers.push({
      sourceTitle: title,
      price,
      status: soldOut(detailText) || stockCount === 0 ? "out_of_stock" : product.status,
      stockCount,
      url: product.url,
      externalKey: withVariant(`buy/${product.buyId}`, skuName),
      tags: compact(["独角HTML", skuName, /自动发货/.test(detailText) ? "自动发货" : null]),
      sourceStoreName: target.sourceStoreName,
    });
  }
  return offers;
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await fn(items[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}

export async function collectDujiaoHtmlFromHtml(target: CollectorTarget, html: string, http?: HttpClient): Promise<CollectorOffer[]> {
  const products = parseBaseProducts(target, html);
  if (!products.length) return [];
  const detailOffers = http
    ? (await mapLimit(products, 4, async (product) => {
        try {
          return parseSkuOffers(target, product, await http.fetchText(product.url));
        } catch {
          return [];
        }
      })).flat()
    : [];
  if (detailOffers.length) return detailOffers.slice(0, 240);
  return products.map<CollectorOffer>((product) => ({
    sourceTitle: product.title,
    price: product.price,
    status: product.status,
    stockCount: product.stockCount,
    url: product.url,
    externalKey: `buy/${product.buyId}`,
    tags: compact(["独角HTML"]),
    sourceStoreName: target.sourceStoreName,
  }));
}

export const collectDujiaoHtml: Collector = async (target, http) => {
  const html = await http.fetchText(target.sourceUrl);
  return collectDujiaoHtmlFromHtml(target, html, http);
};
