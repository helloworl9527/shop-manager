import { describe, expect, it } from "vitest";
import { canAutoUpdateStoreName, isWeakSourceName, resolveStoreName } from "../sourceProbe";
import type { HttpClient } from "../http";

function httpWithHtml(html: string): HttpClient {
  return {
    async fetchJson() { throw new Error("unused"); },
    async fetchText() { return html; },
    async postJson() { throw new Error("unused"); },
  };
}

const target = {
  sourceId: "probe",
  sourceName: "shop.test",
  sourceUrl: "https://shop.test/",
  baseUrl: "https://shop.test",
};

describe("sourceProbe 店名解析", () => {
  it("优先使用采集器返回的接口店名", async () => {
    const name = await resolveStoreName(target, httpWithHtml(`<meta property="og:site_name" content="HTML 店">`), [
      { sourceTitle: "ChatGPT Plus", price: 10, status: "in_stock", url: "https://shop.test/p/1", tags: [], stockCount: 1, sourceStoreName: "接口店名" },
    ]);
    expect(name).toBe("接口店名");
  });

  it("从 HTML og、品牌节点、title 中提取品牌名，抓不到时回退域名", async () => {
    await expect(resolveStoreName(target, httpWithHtml(`<meta property="og:site_name" content="宝钗杂货铺">`))).resolves.toBe("宝钗杂货铺");
    await expect(resolveStoreName(target, httpWithHtml(`<a class="navbar-brand">大橘AI</a><title>备用标题</title>`))).resolves.toBe("大橘AI");
    await expect(resolveStoreName(target, httpWithHtml(`<title>自助服务 - 自动发货商城</title>`))).resolves.toBe("自助服务");
    await expect(resolveStoreName(target, httpWithHtml(`<html></html>`))).resolves.toBe("shop.test");
  });

  it("弱名可自动回填，manual 名称不覆盖", () => {
    expect(isWeakSourceName("18", "https://shop.test/")).toBe(true);
    expect(isWeakSourceName("shop.test", "https://shop.test/")).toBe(true);
    expect(isWeakSourceName("用户自定义", "https://shop.test/")).toBe(false);
    expect(canAutoUpdateStoreName({ name: "18", name_source: "auto", entry_url: "https://shop.test/" }, "真实店名")).toBe(true);
    expect(canAutoUpdateStoreName({ name: "18", name_source: "manual", entry_url: "https://shop.test/" }, "真实店名")).toBe(false);
  });
});
