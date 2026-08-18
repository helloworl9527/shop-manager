/**
 * availability_rank 统一计算（方案 v5 §4.2 / F1）。
 *
 * 唯一权威实现：所有采集器/写库路径都必须调用此纯函数，
 * 不允许各自硬编码排序语义，避免同一状态算出不同 rank。
 *
 * 有序判定，第一条命中即止（消除「out_of_stock 通常也把 effective_status
 * 设为 unavailable」导致的 2/3 歧义）：
 *   1) hidden / 无 price / 无 url / status=unknown / effective=stale → 3
 *   2) status=out_of_stock 或 effective=unavailable                  → 2
 *   3) status=low_stock                                              → 1
 *   4) status=in_stock                                               → 0
 *   5) 其它                                                          → 3
 *
 * 注意：freshness_status / expires_at 只用于后台陈旧度展示，不再影响前台可见性或排序。
 */

export type AvailabilityRank = 0 | 1 | 2 | 3;

export interface AvailabilityInput {
  status?: string | null;
  effectiveStatus?: string | null;
  freshnessStatus?: string | null;
  price?: number | null;
  url?: string | null;
  hidden?: boolean | number | null;
}

function norm(value: string | null | undefined): string {
  return String(value ?? "").trim().toLowerCase();
}

export function computeAvailabilityRank(input: AvailabilityInput): AvailabilityRank {
  const hidden = input.hidden === true || input.hidden === 1;
  const hasPrice = typeof input.price === "number" && Number.isFinite(input.price);
  const hasUrl = typeof input.url === "string" && input.url.trim().length > 0;
  const status = norm(input.status);
  const effective = norm(input.effectiveStatus);

  // 1) 未知 / 不可用 / 隐藏 / 缺数据
  if (hidden || !hasPrice || !hasUrl || status === "unknown" || effective === "stale") {
    return 3;
  }
  // 2) 明确缺货 / 不可售
  if (status === "out_of_stock" || effective === "unavailable") {
    return 2;
  }
  // 3) 少量
  if (status === "low_stock") {
    return 1;
  }
  // 4) 有货
  if (status === "in_stock") {
    return 0;
  }
  // 5) 兜底
  return 3;
}
