import { describe, it, expect } from "vitest";
import { computeAvailabilityRank } from "../availability";

const base = { price: 30, url: "https://x/item/1", status: "in_stock", effectiveStatus: "available", freshnessStatus: "fresh" };

describe("computeAvailabilityRank", () => {
  it("有货且数据完整 → 0", () => {
    expect(computeAvailabilityRank(base)).toBe(0);
  });

  it("少量 → 1", () => {
    expect(computeAvailabilityRank({ ...base, status: "low_stock" })).toBe(1);
  });

  it("缺货 → 2", () => {
    expect(computeAvailabilityRank({ ...base, status: "out_of_stock" })).toBe(2);
  });

  it("关键回归：out_of_stock 同时 effective=unavailable 仍应是 2，而非 3", () => {
    expect(computeAvailabilityRank({ ...base, status: "out_of_stock", effectiveStatus: "unavailable" })).toBe(2);
  });

  it("仅 effective=unavailable（status 非缺货）→ 2", () => {
    expect(computeAvailabilityRank({ ...base, status: "in_stock", effectiveStatus: "unavailable" })).toBe(2);
  });

  it("未知状态 → 3，不会被当成有货", () => {
    expect(computeAvailabilityRank({ ...base, status: "unknown" })).toBe(3);
  });

  it("无价 → 3", () => {
    expect(computeAvailabilityRank({ ...base, price: null })).toBe(3);
  });

  it("无 url → 3", () => {
    expect(computeAvailabilityRank({ ...base, url: "" })).toBe(3);
  });

  it("过期只表示陈旧度，不影响排序等级", () => {
    expect(computeAvailabilityRank({ ...base, freshnessStatus: "expired" })).toBe(0);
  });

  it("stale → 3（优先于 in_stock）", () => {
    expect(computeAvailabilityRank({ ...base, effectiveStatus: "stale" })).toBe(3);
  });

  it("hidden → 3", () => {
    expect(computeAvailabilityRank({ ...base, hidden: 1 })).toBe(3);
  });

  it("有序短路：hidden 优先于 out_of_stock 仍判 3", () => {
    expect(computeAvailabilityRank({ ...base, hidden: true, status: "out_of_stock" })).toBe(3);
  });

  it("大小写/空格不敏感", () => {
    expect(computeAvailabilityRank({ ...base, status: " IN_STOCK " })).toBe(0);
  });

  it("空对象兜底 → 3", () => {
    expect(computeAvailabilityRank({})).toBe(3);
  });
});
