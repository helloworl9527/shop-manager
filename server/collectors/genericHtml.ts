import type { Collector, CollectorOffer } from "./types";
import { stripHtml, cleanText, numberOrNull, compact, isNonComparableTitle, statusFromStock, PRICE_VALUE_PATTERN } from "./util";
import { normalizeKeyFromTitle } from "../core/ids";

const PREFIX_PRICE_RE = new RegExp(String.raw`[¥￥]\s*${PRICE_VALUE_PATTERN}`, "i");
const SUFFIX_PRICE_RE = new RegExp(String.raw`${PRICE_VALUE_PATTERN}\s*(?:CNY|RMB|元)`, "i");
const ANY_PRICE_RE = new RegExp(String.raw`[¥￥]\s*${PRICE_VALUE_PATTERN}|${PRICE_VALUE_PATTERN}\s*(?:CNY|RMB|元)`, "gi");
const CARD_START_RE = /<(article|section|li|div|a)\b[^>]*(?:class=["'][^"']*(?:product|goods|item|card)[^"']*["'])[^>]*>/gi;
const LINK_RE = /<a\b[^>]*href=["']([^"']*(?:\/buy\/\d+|\/item\/[^"']+|\/product\/[^"']+)[^"']*)["'][^>]*>/i;
const MAX_CARD_BLOCK_CHARS = 5_000;

function stockFromContext(value: string): number | null {
  const m = value.match(/库存[:：]?\s*(\d+)/) || value.match(/(\d+)\s*件现货/);
  return m ? numberOrNull(m[1]) : null;
}

function titleFromSegment(segment: string, price: number | null): string {
  let text = cleanText(segment)
    .replace(/(?:库存|销量|已售)[:：]?\s*\d+/g, " ")
    .replace(/\d+\s*件现货/g, " ")
    .replace(/(?:价格|售价|自动发货|人工处理|下单|购买|查看详情|立即下单)\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  // 去掉等于价格的纯数字 token
  text = text.split(/\s+/).filter((t) => t && numberOrNull(t) !== price).join(" ");
  // 取最后一段更像商品名的内容
  if (text.length > 96) {
    const parts = text.split(/\s{2,}|[。；;，,]/).map((p) => p.trim()).filter(Boolean);
    text = parts.at(-1) || text.slice(-96);
  }
  return text.slice(0, 140).trim();
}

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

function decodeKnownEncryptedHtml(html: string): string {
  let output = html;
  output = output.replace(/\\x([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
  output = output.replace(/\\u([0-9a-f]{4})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
  output = output.replace(/unescape\(["']([^"']{8,})["']\)/gi, (_, encoded) => {
    try {
      return decodeURIComponent(String(encoded).replace(/%u([0-9a-f]{4})/gi, (_m, h) => `%E${h.slice(0, 1)}%${h.slice(1, 3)}%${h.slice(3)}`));
    } catch {
      try { return unescape(String(encoded)); } catch { return encoded; }
    }
  });
  output = output.replace(/atob\(["']([A-Za-z0-9+/=]{24,})["']\)/g, (_, encoded) => {
    try {
      return Buffer.from(String(encoded), "base64").toString("utf8");
    } catch {
      return encoded;
    }
  });
  return output;
}

function absUrl(base: string, href: string): string {
  try {
    return new URL(href, base).toString();
  } catch {
    return href;
  }
}

function priceFromText(text: string): number | null {
  const match = text.match(PREFIX_PRICE_RE) ?? text.match(SUFFIX_PRICE_RE);
  return match ? numberOrNull(match[0]) : null;
}

function titleFromCard(block: string, price: number | null): string {
  const candidates = [
    block.match(/<h[1-5][^>]*>([\s\S]*?)<\/h[1-5]>/i)?.[1],
    block.match(/\btitle=["']([^"']+)["']/i)?.[1],
    block.match(/\balt=["']([^"']+)["']/i)?.[1],
    stripHtml(block),
  ];
  for (const candidate of candidates) {
    const title = titleFromSegment(String(candidate ?? "").replace(ANY_PRICE_RE, " "), price);
    if (title && title.length >= 4 && !isNonComparableTitle(title)) return title;
  }
  return "";
}

function balancedElementBlock(html: string, tag: string, start: number): string {
  const tagRe = new RegExp(String.raw`<\/?${tag}\b[^>]*>`, "gi");
  tagRe.lastIndex = start;
  let depth = 0;
  let match: RegExpExecArray | null;
  while ((match = tagRe.exec(html))) {
    if ((match.index ?? 0) - start > MAX_CARD_BLOCK_CHARS) break;
    if (match[0].startsWith("</")) {
      depth -= 1;
      if (depth <= 0) return html.slice(start, match.index + match[0].length);
    } else {
      depth += 1;
    }
  }
  return html.slice(start, Math.min(html.length, start + MAX_CARD_BLOCK_CHARS));
}

function findCardBlocks(html: string): string[] {
  const blocks: string[] = [];
  for (const match of html.matchAll(CARD_START_RE)) {
    const start = match.index ?? 0;
    const tag = match[1];
    if (!tag) continue;
    blocks.push(balancedElementBlock(html, tag, start));
  }
  return blocks;
}

function collectCardOffers(target: Parameters<Collector>[0], html: string): CollectorOffer[] {
  const offers: CollectorOffer[] = [];
  const seenKeys = new Set<string>();
  for (const block of findCardBlocks(html)) {
    const text = decodeEntities(stripHtml(block).replace(/&amp;/g, "&"));
    const price = priceFromText(text);
    if (price === null) continue;
    const title = titleFromCard(block, price);
    if (!title || /合计|支付|订单|充值金额|余额|声明|举证|预览/.test(title)) continue;
    const link = block.match(LINK_RE)?.[1];
    const stockCount = stockFromContext(text);
    const soldOut = /缺货|已售罄|售罄|无货/.test(text) || stockCount === 0;
    const key = normalizeKeyFromTitle(title);
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    offers.push({
      sourceTitle: title,
      price,
      status: soldOut ? "out_of_stock" : statusFromStock(stockCount),
      stockCount: soldOut ? 0 : stockCount,
      url: link ? absUrl(target.sourceUrl, link) : `${target.sourceUrl.replace(/#.*$/, "")}#offer-${offers.length + 1}`,
      externalKey: `gh:${key}`,
      tags: compact([
        /自动发货/.test(text) ? "自动发货" : null,
        /人工/.test(text) ? "人工处理" : null,
        "页面解析",
      ]),
    });
  }
  return offers.slice(0, 200);
}

/** 通用 HTML 兜底：用价格符号锚点切分页面文本，抽取标题/库存。 */
export function collectGenericHtmlFromHtml(target: Parameters<Collector>[0], html: string): CollectorOffer[] {
  const decoded = decodeKnownEncryptedHtml(html);
  const cardOffers = collectCardOffers(target, decoded);
  if (cardOffers.length >= 2) return cardOffers;

  const text = stripHtml(decoded).replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
  const priceMatches = [...text.matchAll(ANY_PRICE_RE)];
  const offers: CollectorOffer[] = [];
  let prevEnd = 0;

  for (let i = 0; i < priceMatches.length; i += 1) {
    const m = priceMatches[i]!;
    const price = numberOrNull(m[0]);
    if (price === null) continue;

    const segment = text.slice(prevEnd, m.index);
    const nextIndex = priceMatches[i + 1]?.index ?? Math.min(text.length, (m.index ?? 0) + 260);
    const after = text.slice((m.index ?? 0) + m[0].length, nextIndex);
    prevEnd = (m.index ?? 0) + m[0].length;

    const title = titleFromSegment(segment, price);
    if (!title || title.length < 4 || isNonComparableTitle(title)) continue;
    if (/合计|支付|订单|充值金额|余额|声明|举证|预览/.test(title)) continue;

    const context = `${segment} ${after}`;
    const stockCount = stockFromContext(context);
    const soldOut = /缺货|已售罄|售罄|无货/.test(context) || stockCount === 0;

    offers.push({
      sourceTitle: title,
      price,
      status: soldOut ? "out_of_stock" : statusFromStock(stockCount),
      stockCount: soldOut ? 0 : stockCount,
      // 页面无稳定商品 id：url 锚点 + 用标题作为外部键，保证同页多商品可分别去重/收藏
      url: `${target.sourceUrl.replace(/#.*$/, "")}#offer-${offers.length + 1}`,
      externalKey: `gh:${normalizeKeyFromTitle(title)}`,
      tags: compact([
        /自动发货/.test(context) ? "自动发货" : null,
        /人工/.test(context) ? "人工处理" : null,
        "页面解析",
      ]),
    });
  }

  return offers.slice(0, 200);
}

export const collectGenericHtml: Collector = async (target, http) => {
  const html = await http.fetchText(target.sourceUrl);
  return collectGenericHtmlFromHtml(target, html);
};
