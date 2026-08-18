import { computeAvailabilityRank } from "./availability";

export type CollectionMethod = "manual" | "http" | "browser" | "public_json";

const OFFER_VISIBLE_MS = 24 * 60 * 60 * 1000;

const PRIORITY: Record<CollectionMethod, number> = { manual: 95, browser: 90, http: 85, public_json: 40 };
const CONFIDENCE: Record<CollectionMethod, number> = { manual: 0.95, browser: 0.9, http: 0.85, public_json: 0.55 };

export interface FreshnessInput {
  method: CollectionMethod;
  status: string;
  price: number | null;
  url: string;
  verifiedAt: string; // ISO
  hidden?: boolean;
}

export interface FreshnessFields {
  source_status: string;
  effective_status: "available" | "unavailable";
  freshness_status: "fresh";
  verified_at: string;
  expires_at: string;
  source_priority: number;
  confidence: number;
  availability_rank: 0 | 1 | 2 | 3;
}

/** 写入一条 offer 时计算的测活字段（方案 §6）。availability_rank 统一走纯函数。 */
export function computeFreshnessFields(input: FreshnessInput): FreshnessFields {
  const effectiveStatus: "available" | "unavailable" =
    input.status === "out_of_stock" ? "unavailable" : "available";
  const freshnessStatus = "fresh" as const;
  const expiresAt = new Date(new Date(input.verifiedAt).getTime() + OFFER_VISIBLE_MS).toISOString();

  return {
    source_status: input.status,
    effective_status: effectiveStatus,
    freshness_status: freshnessStatus,
    verified_at: input.verifiedAt,
    expires_at: expiresAt,
    source_priority: PRIORITY[input.method],
    confidence: CONFIDENCE[input.method],
    availability_rank: computeAvailabilityRank({
      status: input.status,
      effectiveStatus,
      freshnessStatus,
      price: input.price,
      url: input.url,
      hidden: input.hidden,
    }),
  };
}

/**
 * 差集下架硬规则（方案 §7）：只有完整快照且可信时才允许把缺失商品标下架。
 * 纯函数，便于单测。
 */
export function shouldDelistMissing(input: {
  status: "success" | "partial" | "failed";
  fullSnapshot: boolean;
  seenCount: number;
  previousActiveCount: number;
}): boolean {
  if (input.status !== "success") return false;
  if (!input.fullSnapshot) return false;
  if (input.seenCount <= 0) return false;
  const floor = Math.max(1, Math.floor(input.previousActiveCount * 0.5));
  return input.seenCount >= floor;
}
