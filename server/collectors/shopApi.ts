import type { Collector, CollectorTarget, CollectorOffer } from "./types";
import type { HttpClient } from "../core/http";
import { cleanText, numberOrNull, compact, isNonComparableTitle, statusFromStock, shopTokenFromUrl, goodsKeyFromUrl, normalizeHostname } from "./util";

function parseRetryCount(): number {
  const value = Number(process.env.SHOP_API_RETRIES ?? 2);
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 2;
}

function parseRetryBackoffMs(): number[] {
  const raw = String(process.env.SHOP_API_RETRY_BACKOFF_MS ?? "800,2000")
    .split(",")
    .map((v) => Number(v.trim()))
    .filter((v) => Number.isFinite(v) && v >= 0);
  return raw.length ? raw : [800, 2000];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isTransientShopApiError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? "");
  // 520–527 是 Cloudflare/阿里云 ESA 等边缘的「源站错误/临时不可达」，多为源站短暂过载 → 可重试。
  return /\b(?:HTTP\s*)?(?:429|500|502|503|504|52[0-7])\b|fetch failed|ECONNRESET|ETIMEDOUT|socket hang up|timed out/i.test(msg);
}

async function postShopApiWithRetry(http: HttpClient, url: string, body: unknown, referer: string): Promise<any> {
  const retries = parseRetryCount();
  const backoffs = parseRetryBackoffMs();
  let lastError: unknown = null;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await http.postJson(url, body, referer);
    } catch (err) {
      lastError = err;
      if (!isTransientShopApiError(err) || attempt >= retries) throw err;
      await sleep(backoffs[Math.min(attempt, backoffs.length - 1)] ?? 0);
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError ?? "shopApi 请求失败"));
}

async function discoverShopTokens(target: CollectorTarget, http: HttpClient): Promise<string[]> {
  const tokens = new Set<string>();
  const entryToken = shopTokenFromUrl(target.sourceUrl);
  if (entryToken) tokens.add(entryToken);

  const itemUrls = (target.knownItemUrls ?? [])
    .filter(Boolean)
    .filter((url) => normalizeHostname(url) === normalizeHostname(target.baseUrl))
    .slice(0, 20);

  for (const itemUrl of itemUrls) {
    const goodsKey = goodsKeyFromUrl(itemUrl);
    if (!goodsKey) continue;
    const payload = await http
      .postJson(`${target.baseUrl}/shopApi/Shop/goodsInfo`, { goods_key: goodsKey, trade_no: "" }, itemUrl)
      .catch(() => null);
    const token = payload?.data?.user?.token;
    if (token) tokens.add(String(token));
    if (tokens.size >= 3) break;
  }

  return Array.from(tokens);
}

/** 链动小铺 / ShopApi：/shopApi/Shop/{info,categoryList,goodsList}。 */
export const collectShopApi: Collector = async (target, http) => {
  const base = target.baseUrl;
  const tokens = await discoverShopTokens(target, http);
  const offers: CollectorOffer[] = [];

  if (!tokens.length) {
    throw new Error("未找到店铺 token，需要至少一个 /shop/<token> 或 /item/<goods_key> 链接。");
  }

  for (const token of tokens) {
    const shopInfo = await postShopApiWithRetry(http, `${base}/shopApi/Shop/info`, { token, category_key: "" }, `${base}/shop/${token}`);
    if (shopInfo?.code !== 1 || !shopInfo?.data) continue;

    const storeName = cleanText(shopInfo.data.nickname || target.sourceStoreName || target.sourceName);
    const sourceUrl = shopInfo.data.link || `${base}/shop/${token}`;

    const categoriesPayload = await postShopApiWithRetry(
      http,
      `${base}/shopApi/Shop/categoryList`,
      { token, goods_type: "card", category_key: "" },
      sourceUrl,
    );
    const categories: any[] = Array.isArray(categoriesPayload?.data) ? categoriesPayload.data : [];
    const selected = categories.filter((c) => Number(c.goods_count || 0) > 0 && Number(c.id) !== 0);
    const categoryIds = selected.length
      ? selected.map((c) => Number(c.id))
      : categories.some((c) => Number(c.id) === 0)
        ? [0]
        : [];

    for (const categoryId of categoryIds) {
      for (let page = 1; page <= 10; page += 1) {
        const listPayload = await postShopApiWithRetry(
          http,
          `${base}/shopApi/Shop/goodsList`,
          { token, keywords: "", category_id: categoryId, goods_type: "card", current: page, pageSize: 100 },
          sourceUrl,
        );
        const items: any[] = Array.isArray(listPayload?.data?.list) ? listPayload.data.list : [];
        if (!items.length) break;

        for (const item of items) {
          const title = cleanText(item.name);
          const price = numberOrNull(item.price ?? item.real_price);
          if (!title || price === null || isNonComparableTitle(title)) continue;

          const stockCount = numberOrNull(item.extend?.stock_count);
          const status = Number(item.status ?? 1) !== 1 ? "out_of_stock" : statusFromStock(stockCount);

          offers.push({
            sourceTitle: title,
            price,
            status,
            stockCount,
            sourceStoreName: storeName,
            url: item.link || `${base}/item/${item.goods_key}`,
            externalKey: item.goods_key != null ? String(item.goods_key) : null,
            tags: compact([
              cleanText(item.category?.name || ""),
              item.goods_type === "card" ? "卡密" : null,
              item.extend?.send_order === 0 ? "自动发货" : null,
            ]),
          });
        }

        if (items.length < 100) break;
      }
    }
  }

  return offers;
};
