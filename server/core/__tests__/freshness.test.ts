import { describe, it, expect } from "vitest";
import { computeFreshnessFields, shouldDelistMissing } from "../freshness";

describe("computeFreshnessFields", () => {
  const at = "2026-06-29T00:00:00.000Z";
  it("有货 http：available/fresh，rank 0，过期=+24h", () => {
    const f = computeFreshnessFields({ method: "http", status: "in_stock", price: 30, url: "https://x/1", verifiedAt: at });
    expect(f.effective_status).toBe("available");
    expect(f.availability_rank).toBe(0);
    expect(f.expires_at).toBe("2026-06-30T00:00:00.000Z");
    expect(f.source_priority).toBe(85);
  });
  it("缺货：unavailable，rank 2", () => {
    const f = computeFreshnessFields({ method: "http", status: "out_of_stock", price: 30, url: "https://x/1", verifiedAt: at });
    expect(f.effective_status).toBe("unavailable");
    expect(f.availability_rank).toBe(2);
  });
  it("browser 方法优先级 90", () => {
    expect(computeFreshnessFields({ method: "browser", status: "in_stock", price: 1, url: "u", verifiedAt: at }).source_priority).toBe(90);
  });
});

describe("shouldDelistMissing 硬规则", () => {
  const ok = (o: Parameters<typeof shouldDelistMissing>[0]) => shouldDelistMissing(o);
  it("正常完整快照允许下架", () => {
    expect(ok({ status: "success", fullSnapshot: true, seenCount: 40, previousActiveCount: 50 })).toBe(true);
  });
  it("非 success 不下架", () => {
    expect(ok({ status: "partial", fullSnapshot: true, seenCount: 40, previousActiveCount: 50 })).toBe(false);
  });
  it("非完整快照不下架", () => {
    expect(ok({ status: "success", fullSnapshot: false, seenCount: 40, previousActiveCount: 50 })).toBe(false);
  });
  it("空结果不下架", () => {
    expect(ok({ status: "success", fullSnapshot: true, seenCount: 0, previousActiveCount: 50 })).toBe(false);
  });
  it("返回异常偏少(<上次一半)不下架", () => {
    expect(ok({ status: "success", fullSnapshot: true, seenCount: 20, previousActiveCount: 50 })).toBe(false);
  });
  it("恰好达到一半阈值允许", () => {
    expect(ok({ status: "success", fullSnapshot: true, seenCount: 25, previousActiveCount: 50 })).toBe(true);
  });
  it("首次采集(previousActive=0)允许", () => {
    expect(ok({ status: "success", fullSnapshot: true, seenCount: 5, previousActiveCount: 0 })).toBe(true);
  });
});
