import { describe, it, expect, afterEach } from "vitest";
import { hostMinGapMs } from "../http";

const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
});

describe("按域名限速配置", () => {
  it("默认 500ms", () => {
    delete process.env.SHOP_HTTP_HOST_MIN_GAP_MS;
    expect(hostMinGapMs()).toBe(500);
  });

  it("可通过环境变量调大（境外 VPS 场景）", () => {
    process.env.SHOP_HTTP_HOST_MIN_GAP_MS = "1500";
    expect(hostMinGapMs()).toBe(1500);
  });

  it("非法值回落到默认，负数收敛为 0", () => {
    process.env.SHOP_HTTP_HOST_MIN_GAP_MS = "abc";
    expect(hostMinGapMs()).toBe(500);
    process.env.SHOP_HTTP_HOST_MIN_GAP_MS = "-100";
    expect(hostMinGapMs()).toBe(0);
  });
});

describe("限速实际生效", () => {
  it("同域名连续请求被拉开间隔，不同域名互不影响", async () => {
    process.env.SHOP_HTTP_HOST_MIN_GAP_MS = "120";
    process.env.SHOP_HTTP_JITTER_MS = "0";
    // 动态导入以读取到刚设置的环境变量下的模块状态（模块内维护 per-host 时间表）
    const { httpClient } = await import("../http");

    const seen: Array<{ host: string; at: number }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: any) => {
      seen.push({ host: new URL(String(input)).hostname, at: Date.now() });
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    try {
      // 同域名 3 次 + 另一域名 1 次，全部并发发起
      await Promise.all([
        httpClient.fetchJson("https://throttle-a.test/1"),
        httpClient.fetchJson("https://throttle-a.test/2"),
        httpClient.fetchJson("https://throttle-a.test/3"),
        httpClient.fetchJson("https://throttle-b.test/1"),
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }

    const a = seen.filter((s) => s.host === "throttle-a.test").map((s) => s.at).sort((x, y) => x - y);
    expect(a).toHaveLength(3);
    // 相邻两次至少间隔一个最小间隔（留 20ms 计时容差）
    expect(a[1]! - a[0]!).toBeGreaterThanOrEqual(100);
    expect(a[2]! - a[1]!).toBeGreaterThanOrEqual(100);

    // 另一域名不必等待 A 域名的节流
    const b = seen.find((s) => s.host === "throttle-b.test")!;
    expect(b.at - a[0]!).toBeLessThan(100);
  });
});
