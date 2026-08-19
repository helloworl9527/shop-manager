import type { Collector, CollectorOffer } from "./types";
import { cleanText, numberOrNull, compact, isNonComparableTitle, statusFromStock, localized } from "./util";
import { withVariant } from "../core/ids";

/** 取第一个能解析成数字的值。不能用 ?? 串联：0 是合法库存值，会挡住后面真正该用的字段。 */
function firstNumber(values: unknown[]): number | null {
  for (const value of values) {
    const n = numberOrNull(value);
    if (n !== null) return n;
  }
  return null;
}

/** 独角数卡：/api/v1/public/products，product 可含多个 sku（每个 sku 一条 offer）。 */
export const collectDujiao: Collector = async (target, http) => {
  const payload = await http.fetchJson(`${target.baseUrl}/api/v1/public/products`);
  const products: any[] = Array.isArray(payload?.data) ? payload.data : [];
  const offers: CollectorOffer[] = [];

  for (const product of products) {
    const productTitle = localized(product.title) || cleanText(product.slug);
    const productKey = String(product.slug ?? product.id ?? productTitle);
    const skus: any[] = Array.isArray(product.skus) && product.skus.length ? product.skus : [null];

    skus.forEach((sku, index) => {
      const skuTitle = localized(sku?.title || sku?.name || sku?.label || sku?.spec);
      const title = cleanText(
        skuTitle && skuTitle !== productTitle
          ? `${productTitle} / ${skuTitle}`
          : skus.length > 1 && sku
            ? `${productTitle} / 规格${index + 1}`
            : productTitle,
      );
      const price = numberOrNull(sku?.price_amount ?? product.price_amount);
      if (!title || price === null || isNonComparableTitle(title)) return;

      // 独角数卡有两套互斥的库存字段：自动发货看 auto_stock_available，人工发货看
      // manual_stock_available，另一套恒为 0。原来固定「auto 优先」，而 0 不是 nullish、
      // ?? 不会跳过它，于是人工发货商品一律拿到 0 → 被判缺货 → 从前台列表整个消失。
      const fulfillment = String(sku?.fulfillment_type ?? product.fulfillment_type ?? "");
      const stockCount = firstNumber(
        fulfillment === "manual"
          ? [sku?.manual_stock_available, product.manual_stock_available, sku?.auto_stock_available, product.auto_stock_available]
          : [sku?.auto_stock_available, product.auto_stock_available, sku?.manual_stock_available, product.manual_stock_available],
      );
      const isSoldOut = Boolean(sku?.is_sold_out ?? product.is_sold_out);
      const stockStatus = String(sku?.stock_status || product.stock_status || "");
      // 「不限量」有两种写法：stock_status=unlimited，或库存填 -1。两者都不能按数量判缺货。
      const unlimited = stockStatus === "unlimited" || (stockCount !== null && stockCount < 0);
      const status = isSoldOut || stockStatus === "out_of_stock"
        ? "out_of_stock"
        : unlimited
          ? "in_stock"
          : statusFromStock(stockCount);

      // R1：多 SKU 必须并入 variant 维度，否则同一 product 下多个 SKU 撞 id（URL 也相同）
      const variantKey = sku ? String(sku.id ?? sku.title ?? sku.name ?? `idx${index}`) : null;

      offers.push({
        sourceTitle: title,
        price,
        status,
        // 不限量时不要把 -1 这种哨兵值原样落库，前台会显示成「库存 -1」
        stockCount: unlimited ? null : stockCount,
        url: `${target.baseUrl}/products/${encodeURIComponent(String(product.slug ?? product.id))}`,
        externalKey: withVariant(productKey, variantKey),
        tags: compact([
          localized(product.category?.name),
          product.fulfillment_type === "auto" ? "自动发货" : null,
          product.fulfillment_type === "manual" ? "人工处理" : null,
        ]),
      });
    });
  }

  return offers;
};
