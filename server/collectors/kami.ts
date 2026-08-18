import type { Collector, CollectorOffer } from "./types";
import { cleanText, numberOrNull, compact, isNonComparableTitle, statusFromStock, normalizeHostname } from "./util";

function kamiCommodityUrl(baseUrl: string, id: unknown): string {
  const host = normalizeHostname(baseUrl);
  if (host === "ai666.dnxb.cc") return `${baseUrl}/item/${encodeURIComponent(String(id))}`;
  return `${baseUrl}/?commodity=${encodeURIComponent(String(id))}`;
}

/** 卡密发卡（Faka）：/user/api/index/commodity?limit=100&page=N */
export const collectKami: Collector = async (target, http) => {
  const base = target.baseUrl;
  const offers: CollectorOffer[] = [];
  const pageSizes = [100, 20, 10, 1];
  let lastError: unknown = null;

  for (const limit of pageSizes) {
    offers.length = 0;
    try {
      for (let page = 1; page <= 10; page += 1) {
        const payload = await http.fetchJson(`${base}/user/api/index/commodity?limit=${limit}&page=${page}`);
        const items: any[] = Array.isArray(payload?.data) ? payload.data : [];
        if (!items.length) break;

        for (const item of items) {
          const title = cleanText(item.name);
          const price = numberOrNull(item.user_price ?? item.price);
          if (!title || price === null || isNonComparableTitle(title)) continue;

          const stockCount = numberOrNull(item.stock);
          // 定性库存（如「非常多」）：源站不给数字时保留原文展示
          const stockText = typeof item.stock === "string" && stockCount === null ? cleanText(item.stock) : null;
          const hidden = Number(item.hide || 0) !== 0;
          const disabled = Number(item.status ?? 1) !== 1 || hidden;
          const status = disabled ? "out_of_stock" : statusFromStock(stockCount);

          offers.push({
            sourceTitle: title,
            price,
            status,
            stockCount,
            stockText,
            url: kamiCommodityUrl(base, item.id),
            externalKey: item.id != null ? String(item.id) : null,
            tags: compact([
              cleanText(item.category?.name || ""),
              item.delivery_way === 0 ? "自动发货" : null,
              hidden ? "隐藏商品" : null,
            ]),
          });
        }

        if (items.length < limit) break;
      }
      return offers;
    } catch (err) {
      lastError = err;
      if (!/风控|验证|captcha|challenge|cloudflare|HTTP 403|returned HTTP 403|非 JSON/i.test(err instanceof Error ? err.message : String(err))) {
        throw err;
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError ?? "kami 采集失败"));
};
