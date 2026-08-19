import type { Collector, CollectorOffer } from "./types";
import { cleanText, numberOrNull, compact, isNonComparableTitle, statusFromStock } from "./util";
import { withVariant } from "../core/ids";

/**
 * 商品列表 API：GET /api/products → { code, message, data: { list: [...] } }。
 *
 * 与 publicProductsApi（独角数卡的 /api/v1/public/products）是两套不同的后端：
 * 这里的列表项只给 base_price（多规格商品的「起价」），真实分档价在
 * GET /api/products/{id} 的 specs[] 里，故对 has_specs 的商品再取一次详情。
 */

interface SpecRow {
  id?: unknown;
  name?: unknown;
  price?: unknown;
  stock_available?: unknown;
  fulfillment_type?: unknown;
}

function listFromPayload(payload: any): any[] {
  if (Array.isArray(payload?.data?.list)) return payload.data.list;
  if (Array.isArray(payload?.data)) return payload.data;
  return [];
}

function deliveryTag(value: unknown): string | null {
  const text = String(value ?? "").toLowerCase();
  if (text === "auto" || text === "automatic") return "自动发货";
  if (text === "manual") return "人工处理";
  if (text === "finished_account") return "成品号";
  return null;
}

function productUrl(baseUrl: string, id: unknown): string {
  return id == null ? baseUrl : `${baseUrl}/product/${encodeURIComponent(String(id))}`;
}

function offersFromSpecs(baseUrl: string, product: any, specs: SpecRow[]): CollectorOffer[] {
  const productTitle = cleanText(product?.title);
  const productKey = String(product?.id ?? productTitle);

  return specs.flatMap((spec, index) => {
    const specName = cleanText(spec?.name);
    // 单规格时规格名往往与商品名重复，拼上只会污染标题
    const title = cleanText(specName && specs.length > 1 ? `${productTitle} / ${specName}` : productTitle);
    const price = numberOrNull(spec?.price ?? product?.base_price);
    if (!title || price === null || isNonComparableTitle(title)) return [];

    const stockCount = numberOrNull(spec?.stock_available ?? product?.stock_available);
    return [{
      sourceTitle: title,
      price,
      status: statusFromStock(stockCount),
      stockCount,
      url: productUrl(baseUrl, product?.id),
      externalKey: withVariant(productKey, specs.length > 1 ? String(spec?.id ?? specName ?? `idx${index}`) : null),
      tags: compact([deliveryTag(spec?.fulfillment_type ?? product?.delivery_type)]),
    }];
  });
}

export const collectProductsListApi: Collector = async (target, http) => {
  const payload = await http.fetchJson(`${target.baseUrl}/api/products`);
  const products = listFromPayload(payload);
  const offers: CollectorOffer[] = [];

  for (const product of products) {
    if (!product?.has_specs) {
      offers.push(...offersFromSpecs(target.baseUrl, product, [{
        price: product?.base_price,
        stock_available: product?.stock_available,
        fulfillment_type: product?.delivery_type,
      }]));
      continue;
    }
    // 多规格才取详情：省掉大部分单品的额外请求，降低对站点的请求密度
    try {
      const detail = await http.fetchJson(`${target.baseUrl}/api/products/${encodeURIComponent(String(product.id))}`);
      const specs = Array.isArray(detail?.data?.specs) ? (detail.data.specs as SpecRow[]) : [];
      offers.push(...offersFromSpecs(target.baseUrl, product, specs.length ? specs : [{
        price: product?.base_price,
        stock_available: product?.stock_available,
        fulfillment_type: product?.delivery_type,
      }]));
    } catch {
      // 详情取不到就退回列表价，总比整个商品丢掉好
      offers.push(...offersFromSpecs(target.baseUrl, product, [{
        price: product?.base_price,
        stock_available: product?.stock_available,
        fulfillment_type: product?.delivery_type,
      }]));
    }
  }

  return offers;
};
