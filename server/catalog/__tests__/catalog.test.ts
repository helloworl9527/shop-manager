import { describe, it, expect } from "vitest";
import { classifyOffer, canonicalCatalog, getCanonicalProduct } from "../catalog";

const id = (title: string, ctx?: Parameters<typeof classifyOffer>[1]) => classifyOffer(title, ctx).id;

describe("canonicalCatalog 完整性", () => {
  it("含 other-product 兜底且 id 唯一", () => {
    const ids = canonicalCatalog.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain("other-product");
  });
  it("getCanonicalProduct 未知 id 兜底到 other-product", () => {
    expect(getCanonicalProduct("不存在的id").id).toBe("other-product");
  });
});

describe("Plus 多别称归一到 chatgpt-plus", () => {
  for (const t of [
    "ChatGPT Plus 月卡",
    "GPT-Plus 成品号-质保15天",
    "gptplus 直充",
    "PULS 一个月",
    "plus 卡密 自助",
  ]) {
    it(t, () => expect(id(t)).toBe("chatgpt-plus"));
  }
});

describe("ChatGPT 分支消歧", () => {
  it("非 plus 的普号 → free-account", () => expect(id("ChatGPT 非plus 普号")).toBe("chatgpt-free-account"));
  it("纯 plus + 刀数当套餐 → other-product", () => expect(id("纯plus 100刀 额度")).toBe("other-product"));
  it("Team 主导 → team-business", () => expect(id("ChatGPT plus 团队 母号 拼车位")).toBe("chatgpt-team-business"));
  it("Pro 20x → pro-20x", () => expect(id("ChatGPT Pro 20x 200刀")).toBe("chatgpt-pro-20x"));
  it("Pro 5x → pro-5x", () => expect(id("GPT Pro 5x 100刀")).toBe("chatgpt-pro-5x"));
});

describe("其它平台", () => {
  it("Claude Max 20x", () => expect(id("Claude Max x20 官方")).toBe("claude-max-20x"));
  it("Claude Pro", () => expect(id("Claude Pro 月卡")).toBe("claude-pro-month"));
  it("Gemini Ultra", () => expect(id("Google AI Ultra 250美元")).toBe("gemini-ultra"));
  it("Gemini Pro", () => expect(id("Gemini Pro 一年 cdk")).toBe("gemini-pro-year"));
  it("Super Grok", () => expect(id("SuperGrok 激活码")).toBe("super-grok"));
  it("Gmail 邮箱", () => expect(id("谷歌邮箱 gmail 成品")).toBe("gmail-account"));
  it("Apple ID", () => expect(id("美区 Apple ID 成品号")).toBe("apple-id-account"));
  it("接码", () => expect(id("openai 接码 手机号验证")).toBe("openai-phone-verification"));
  it("虚拟卡", () => expect(id("VISA 虚拟卡 0刀卡")).toBe("virtual-card"));
  it("API/CDK", () => expect(id("codex api 额度 兑换码 100刀")).toBe("openai-api-cdk"));
});

describe("上下文兜底", () => {
  it("标题只有 plus，靠分类上下文判到 chatgpt-plus", () => {
    expect(id("plus 续费", { categorySlug: "ChatGPT" })).toBe("chatgpt-plus");
  });
});
