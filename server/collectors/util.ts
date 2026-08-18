// 采集器共享小工具（从 PriceAI scripts/collect-prices.mjs 移植）。

export function cleanText(value: unknown): string {
  return String(value ?? "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&#x?[a-f0-9]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function stripHtml(value: unknown): string {
  return cleanText(
    String(value ?? "")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " "),
  );
}

export function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  // 去掉非数字字符后若没有任何数字，返回 null（避免 Number("")===0 把 "非常多"/"无限" 误判成 0）
  const cleaned = String(value).replace(/[^\d.-]/g, "");
  if (!/\d/.test(cleaned)) return null;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

export function compact(values: Array<string | null | undefined>): string[] {
  return values.map((v) => cleanText(v ?? "")).filter(Boolean);
}

export function isNonComparableTitle(title: string): boolean {
  return ["Logo", "打赏", "测试", "公告", "请查看上方店铺", "其他（直接联系客服"].some((k) => title.includes(k));
}

export function statusFromStock(stockCount: number | null): string {
  if (typeof stockCount === "number") {
    if (stockCount <= 0) return "out_of_stock";
    if (stockCount <= 3) return "low_stock";
    return "in_stock";
  }
  return "in_stock";
}

export function localized(value: unknown): string {
  if (!value) return "";
  if (typeof value === "string") return cleanText(value);
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    return cleanText(
      (obj["zh-CN"] as string) ||
        (obj["zh-TW"] as string) ||
        (obj["en-US"] as string) ||
        (Object.values(obj).find(Boolean) as string) ||
        "",
    );
  }
  return cleanText(String(value));
}

export function normalizeHostname(value: string): string {
  try {
    return new URL(value).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return String(value || "").replace(/^https?:\/\//, "").split("/")[0]!.replace(/^www\./, "").toLowerCase();
  }
}

export function deriveBaseUrl(value: string): string {
  try {
    const u = new URL(value);
    return `${u.protocol}//${u.host}`;
  } catch {
    return value;
  }
}

export const PRICE_VALUE_PATTERN = String.raw`(\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)`;

export function shopTokenFromUrl(value: string): string | null {
  try {
    const m = new URL(value).pathname.match(/\/shop\/([^/?#]+)/);
    return m ? decodeURIComponent(m[1]!) : null;
  } catch {
    return null;
  }
}

export function goodsKeyFromUrl(value: string): string | null {
  try {
    const m = new URL(value).pathname.match(/\/item\/([^/?#]+)/);
    return m ? decodeURIComponent(m[1]!) : null;
  } catch {
    return null;
  }
}
