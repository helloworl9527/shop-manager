import { createHash } from "node:crypto";

/** 购买链接里可能携带商品 id 的查询参数白名单（其余视为 tracking，规范化时丢弃）。 */
const ID_PARAM = /^(commodity|goods_key|goodskey|gid|pid|sku|spu|item|itemid|product|productid|id)$/i;

/**
 * 规范化购买 URL：小写 host、去 fragment、只保留白名单 id 类查询参数、去尾斜杠。
 * 例：https://x.com/?commodity=123&utm=ad#x → https://x.com/?commodity=123
 */
export function urlCanonical(raw: string | null | undefined): string {
  const value = String(raw ?? "").trim();
  if (!value) return "";
  try {
    const u = new URL(value);
    const keep = new URLSearchParams();
    for (const [k, v] of u.searchParams) {
      if (ID_PARAM.test(k)) keep.append(k.toLowerCase(), v);
    }
    keep.sort();
    const query = keep.toString();
    const host = u.host.toLowerCase();
    const path = u.pathname.replace(/\/+$/, "");
    return `${u.protocol}//${host}${path}${query ? `?${query}` : ""}`.toLowerCase();
  } catch {
    return value.toLowerCase();
  }
}

export function normalizeKeyFromTitle(title: string | null | undefined): string {
  return String(title ?? "").toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * 解析外部商品键（offer_id 的去重维度），优先级：
 *   1) 采集器给出的 externalKey（含 SKU/variant，如 goods_key / slug#sku）
 *   2) url_canonical
 *   3) normalize(title)
 */
export function resolveExternalKey(opts: {
  externalKey?: string | null;
  url: string;
  title: string;
}): string {
  const ext = opts.externalKey?.trim();
  if (ext) return ext;
  const uc = urlCanonical(opts.url);
  if (uc) return uc;
  return normalizeKeyFromTitle(opts.title);
}

/** offer_id = sha1(source_id|externalKey)。以 source_id 为前缀 → 店铺改名不漂移。 */
export function buildOfferId(sourceId: string, externalKey: string): string {
  return createHash("sha1").update(`${sourceId}|${externalKey}`).digest("hex");
}

/**
 * 当一个 product 展开成多条 offer 时，把 variant 维度并入外部键。
 * dujiao 多 SKU：variantKey = sku.id ?? sku.title ?? ("idx" + index)。
 */
export function withVariant(productKey: string, variantKey: string | null | undefined): string {
  const v = variantKey?.toString().trim();
  return v ? `${productKey}#${v}` : productKey;
}
