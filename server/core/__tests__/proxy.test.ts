import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  isLiandongSource, withProxySession, proxySessionActive, proxyEnabled,
  resolveCurrentProxy, reportProxyFailure, resetProxyState, isProxyError,
} from "../proxy";

const KDL_ENV = [
  "SHOP_PROXY_KDL_SECRET_ID", "SHOP_PROXY_KDL_SIGNATURE",
  "SHOP_PROXY_KDL_USERNAME", "SHOP_PROXY_KDL_PASSWORD",
  "SHOP_PROXY_ENABLED",
] as const;

/** 让 proxyEnabled() 为真，但不真的去调快代理提取接口。 */
function configureKdl(): void {
  process.env.SHOP_PROXY_KDL_SECRET_ID = "test-secret";
  process.env.SHOP_PROXY_KDL_SIGNATURE = "test-signature";
  process.env.SHOP_PROXY_KDL_USERNAME = "u";
  process.env.SHOP_PROXY_KDL_PASSWORD = "p";
}

const realFetch = globalThis.fetch;
/** 记录提取接口被调用了几次——判断「有没有白烧一个计费 IP」的唯一硬指标。 */
let extractCalls: string[] = [];

beforeEach(() => {
  extractCalls = [];
  resetProxyState();
  globalThis.fetch = (async (input: any) => {
    const url = String(input);
    if (!url.startsWith("https://dps.kdlapi.com/")) return realFetch(input);
    extractCalls.push(url);
    return new Response("203.0.113.7:15818", { status: 200 });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  for (const k of KDL_ENV) delete process.env[k];
  resetProxyState();
});

describe("判定店铺是不是链动小铺", () => {
  it("已定型为 shopApi 的就是链动小铺", () => {
    expect(isLiandongSource({ collectorKind: "shopApi", entryUrl: "https://pay.ldxp.cn/shop/FT7" })).toBe(true);
    // 同为链动小铺系统，换个自建域名照样成立
    expect(isLiandongSource({ collectorKind: "shopApi", entryUrl: "https://manfaka.com/shop/DJV2OHHM" })).toBe(true);
  });

  it("其它已定型的类型一律直连", () => {
    for (const kind of ["kami", "dujiao", "dujiaoHtml", "publicProductsApi", "productsListApi", "genericHtml", "browser"]) {
      expect(isLiandongSource({ collectorKind: kind, entryUrl: "https://example.com/shop/X" })).toBe(false);
    }
  });

  it("kind 还是 auto/空时按 URL 形态判，与 detectCollector 的强信号一致", () => {
    expect(isLiandongSource({ collectorKind: "auto", entryUrl: "https://pay.ldxp.cn/shop/newtoken" })).toBe(true);
    expect(isLiandongSource({ collectorKind: null, entryUrl: "https://pay.qxvx.cn/item/ABC123" })).toBe(true);
    // 库里现有的 auto 店铺都不是这个形态，不该被误判成要用代理
    expect(isLiandongSource({ collectorKind: "auto", entryUrl: "https://shop.azx.us/" })).toBe(false);
    expect(isLiandongSource({ collectorKind: "auto", entryUrl: "https://www.qianxun1688.com/links/F03287C6" })).toBe(false);
    expect(isLiandongSource({ collectorKind: "auto", entryUrl: "https://tomfk.top/" })).toBe(false);
  });

  it("字段缺失不抛错，按直连处理", () => {
    expect(isLiandongSource({})).toBe(false);
    expect(isLiandongSource({ collectorKind: undefined, entryUrl: "不是个 URL" })).toBe(false);
  });
});

describe("代理的启用", () => {
  it("未配快代理时整体关闭，所有店铺直连", async () => {
    expect(proxyEnabled()).toBe(false);
    await withProxySession(async () => {
      expect(proxySessionActive()).toBe(false);
      expect(await resolveCurrentProxy()).toBeNull();
    }, { useProxy: true });
    expect(extractCalls).toHaveLength(0);
  });

  it("SHOP_PROXY_ENABLED=0 可在保留凭据的前提下临时关掉", () => {
    configureKdl();
    process.env.SHOP_PROXY_ENABLED = "0";
    expect(proxyEnabled()).toBe(false);
  });
});

describe("只有链动小铺消耗代理额度", () => {
  beforeEach(configureKdl);

  it("链动小铺的会话提取出口 IP", async () => {
    await withProxySession(async () => {
      expect(proxySessionActive()).toBe(true);
      const entry = (await resolveCurrentProxy())!;
      expect(entry.server).toBe("http://203.0.113.7:15818");
      expect(entry.username).toBe("u");
    }, { useProxy: true });
    expect(extractCalls).toHaveLength(1);
  });

  it("非链动小铺的会话完全不碰提取接口", async () => {
    await withProxySession(async () => {
      expect(proxySessionActive()).toBe(false);
      expect(await resolveCurrentProxy()).toBeNull();
    }, { useProxy: false });
    expect(extractCalls).toHaveLength(0);
  });

  it("会话之外一律直连，不会静默提一个计费 IP", async () => {
    expect(proxySessionActive()).toBe(false);
    expect(await resolveCurrentProxy()).toBeNull();
    expect(extractCalls).toHaveLength(0);
  });

  it("同一个临时 IP 跨店铺复用，不是每家店提一个", async () => {
    for (const _ of [1, 2, 3]) {
      await withProxySession(async () => { await resolveCurrentProxy(); }, { useProxy: true });
    }
    expect(extractCalls).toHaveLength(1);
  });

  it("出口失效后才重新提取", async () => {
    await withProxySession(async () => {
      const entry = (await resolveCurrentProxy())!;
      reportProxyFailure(entry);
      await resolveCurrentProxy();
    }, { useProxy: true });
    expect(extractCalls).toHaveLength(2);
  });

  it("直连会话里的失败不会连累代理缓存", async () => {
    let entry: any = null;
    await withProxySession(async () => { entry = await resolveCurrentProxy(); }, { useProxy: true });
    await withProxySession(async () => {
      reportProxyFailure({ id: "别家:1", server: "http://别家:1", url: "http://别家:1" });
    }, { useProxy: false });
    await withProxySession(async () => {
      expect((await resolveCurrentProxy())!.id).toBe(entry.id);
    }, { useProxy: true });
    expect(extractCalls).toHaveLength(1);
  });
});

describe("提取接口异常时的处置", () => {
  beforeEach(configureKdl);

  it("提取失败返回 null，由上层决定是报错还是直连", async () => {
    globalThis.fetch = (async () => new Response("", { status: 503 })) as typeof fetch;
    await withProxySession(async () => {
      expect(await resolveCurrentProxy()).toBeNull();
    }, { useProxy: true });
  });

  it("提取接口回吐内网地址时丢弃，不让代理成为访问内网的跳板", async () => {
    globalThis.fetch = (async () => new Response("127.0.0.1:8080", { status: 200 })) as typeof fetch;
    await withProxySession(async () => {
      expect(await resolveCurrentProxy()).toBeNull();
    }, { useProxy: true });
  });
});

describe("区分代理故障与站点故障", () => {
  it("连接类错误算代理故障", () => {
    expect(isProxyError(Object.assign(new Error("x"), { code: "ECONNREFUSED" }))).toBe(true);
    expect(isProxyError(new Error("Proxy Authentication Required 407"))).toBe(true);
  });

  it("站点返回的 520 / 风控页不算代理故障", () => {
    expect(isProxyError(new Error("https://pay.example.cn returned HTTP 520"))).toBe(false);
    expect(isProxyError(new Error("返回验证或风控页面"))).toBe(false);
  });
});

describe("undici 包装后的错误也能识别", () => {
  it("从 cause 里认出连接错误", () => {
    const wrapped = new TypeError("fetch failed");
    (wrapped as any).cause = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    expect(isProxyError(wrapped)).toBe(true);
  });

  it("从 AggregateError.errors 里认出连接错误", () => {
    const wrapped = new TypeError("fetch failed");
    const agg: any = new Error("all attempts failed");
    agg.errors = [Object.assign(new Error("timeout"), { code: "UND_ERR_CONNECT_TIMEOUT" })];
    (wrapped as any).cause = agg;
    expect(isProxyError(wrapped)).toBe(true);
  });

  it("包装了站点错误则不算代理故障", () => {
    const wrapped = new TypeError("fetch failed");
    (wrapped as any).cause = new Error("HTTP 520 from upstream");
    expect(isProxyError(wrapped)).toBe(false);
  });

  it("循环引用不会死循环", () => {
    const a: any = new Error("a");
    const b: any = new Error("b");
    a.cause = b; b.cause = a;
    expect(isProxyError(a)).toBe(false);
  });
});
