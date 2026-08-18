import type { Collector, CollectorOffer } from "./types";
import { cleanText, numberOrNull, compact, isNonComparableTitle, statusFromStock, localized } from "./util";
import { withVariant } from "../core/ids";

function productsFromPayload(payload: any): any[] {
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.data?.data)) return payload.data.data;
  if (Array.isArray(payload?.items)) return payload.items;
  return [];
}

function totalPagesFromPayload(payload: any): number | null {
  const raw = payload?.pagination?.total_page ?? payload?.data?.pagination?.total_page ?? payload?.meta?.last_page;
  const value = numberOrNull(raw);
  return value && value > 0 ? Math.floor(value) : null;
}

function skuLabel(sku: any): string {
  const direct = localized(sku?.title || sku?.name || sku?.label || sku?.spec);
  if (direct) return direct;
  const spec = sku?.spec_values;
  if (!spec || typeof spec !== "object") return "";
  return Object.values(spec).map((v) => localized(v)).filter(Boolean).join(" / ");
}

function offerStatus(product: any, sku: any, stockCount: number | null): string {
  const stockStatus = String(sku?.stock_status || product?.stock_status || "").toLowerCase();
  const soldOut = Boolean(sku?.is_sold_out ?? product?.is_sold_out);
  if (soldOut || stockStatus === "out_of_stock") return "out_of_stock";
  if (stockStatus === "low_stock") return "low_stock";
  return statusFromStock(stockCount);
}

function productUrl(baseUrl: string, product: any): string {
  const key = product?.slug ?? product?.id;
  return key == null ? baseUrl : `${baseUrl}/products/${encodeURIComponent(String(key))}`;
}

function mapProduct(baseUrl: string, product: any): CollectorOffer[] {
  const productTitle = localized(product?.title) || cleanText(product?.slug);
  const productKey = String(product?.slug ?? product?.id ?? productTitle);
  const skus: any[] = Array.isArray(product?.skus) && product.skus.length ? product.skus : [null];

  return skus.flatMap((sku, index) => {
    if (sku && (sku.enabled === false || sku.is_active === false)) return [];
    const skuTitle = skuLabel(sku);
    const title = cleanText(
      skuTitle && skuTitle !== productTitle && skus.length > 1
        ? `${productTitle} / ${skuTitle}`
        : productTitle,
    );
    const price = numberOrNull(sku?.price_amount ?? product?.price_amount);
    if (!title || price === null || isNonComparableTitle(title)) return [];

    const stockCount = numberOrNull(
      sku?.auto_stock_available ??
        sku?.manual_stock_available ??
        sku?.upstream_stock ??
        product?.auto_stock_available ??
        product?.manual_stock_available,
    );
    const variantKey = sku ? String(sku.id ?? sku.sku_code ?? skuTitle ?? `idx${index}`) : null;
    const productTags = Array.isArray(product?.tags) ? product.tags.map((tag: unknown) => cleanText(tag)).filter(Boolean) : [];

    return [{
      sourceTitle: title,
      price,
      status: offerStatus(product, sku, stockCount),
      stockCount,
      url: productUrl(baseUrl, product),
      externalKey: withVariant(productKey, variantKey),
      tags: compact([
        localized(product?.category?.name),
        product?.fulfillment_type === "auto" ? "自动发货" : null,
        product?.fulfillment_type === "manual" ? "人工处理" : null,
        ...productTags.slice(0, 5),
      ]),
    }];
  });
}

/** 公开商品 API：/api/v1/public/products?page=N&page_size=100。 */
export const collectPublicProductsApi: Collector = async (target, http) => {
  const offers: CollectorOffer[] = [];
  const pageSize = 100;

  for (let page = 1; page <= 20; page += 1) {
    const payload = await http.fetchJson(`${target.baseUrl}/api/v1/public/products?page=${page}&page_size=${pageSize}`);
    const products = productsFromPayload(payload);
    if (!products.length) break;
    offers.push(...products.flatMap((product) => mapProduct(target.baseUrl, product)));

    const totalPages = totalPagesFromPayload(payload);
    if (totalPages !== null && page >= totalPages) break;
    if (products.length < pageSize) break;
  }

  return offers;
};
