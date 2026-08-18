import { describe, it, expect } from "vitest";
import { isWafError, isNetworkError, shouldFallbackToBrowser } from "../waf";

describe("isWafError", () => {
  it("识别风控/验证页错误", () => {
    expect(isWafError(new Error("https://pay.ldxp.cn/shopApi/Shop/info 返回验证或风控页面，需要改用本机浏览器采集。"))).toBe(true);
    expect(isWafError(new Error("challenge detected"))).toBe(true);
  });
  it("普通错误不算风控", () => {
    expect(isWafError(new Error("未找到店铺 token"))).toBe(false);
  });
});

describe("isNetworkError / shouldFallbackToBrowser", () => {
  it("fetch failed 等网络层失败 → 网络错误，应回退浏览器", () => {
    expect(isNetworkError(new Error("fetch failed"))).toBe(true);
    expect(isNetworkError(new Error("ECONNRESET"))).toBe(true);
    expect(shouldFallbackToBrowser(new Error("fetch failed"))).toBe(true); // ldxp 实际报错
  });
  it("HTTP 429/5xx 不再触发浏览器回退", () => {
    expect(isNetworkError(new Error("returned HTTP 429"))).toBe(false);
    expect(isNetworkError(new Error("returned HTTP 500"))).toBe(false);
    expect(isNetworkError(new Error("returned HTTP 503"))).toBe(false);
    expect(shouldFallbackToBrowser(new Error("returned HTTP 429"))).toBe(false);
    expect(shouldFallbackToBrowser(new Error("returned HTTP 500"))).toBe(false);
  });
  it("风控页也应回退", () => {
    expect(shouldFallbackToBrowser(new Error("返回验证或风控页面，需要改用本机浏览器采集"))).toBe(true);
  });
  it("业务错误(无 token)不回退", () => {
    expect(shouldFallbackToBrowser(new Error("未找到店铺 token"))).toBe(false);
  });
});
