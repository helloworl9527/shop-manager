import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  parseProxyLine, parseProxyList, loadProxyPool, resetProxyPool, proxyPoolEnabled,
  withProxySession, currentProxy, reportProxyFailure, isProxyError,
} from "../proxy";

let dir = "";
function writePool(lines: string[]): string {
  const file = path.join(dir, "proxies.txt");
  writeFileSync(file, lines.join("\n"), "utf8");
  return file;
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "proxy-test-"));
  resetProxyPool();
});
afterEach(() => {
  delete process.env.SHOP_PROXY_FILE;
  delete process.env.SHOP_PROXY_ENABLED;
  resetProxyPool();
  rmSync(dir, { recursive: true, force: true });
});

describe("解析代理配置", () => {
  it("host:port:user:pass", () => {
    const e = parseProxyLine("gate2.example.com:7778:USER_A:secret")!;
    expect(e.server).toBe("http://gate2.example.com:7778");
    expect(e.username).toBe("USER_A");
    expect(e.password).toBe("secret");
    expect(e.url).toBe("http://USER_A:secret@gate2.example.com:7778");
  });

  it("URL 形式与无认证形式", () => {
    expect(parseProxyLine("http://u:p@h.example.com:8080")!.username).toBe("u");
    const bare = parseProxyLine("h.example.com:8080")!;
    expect(bare.username).toBeUndefined();
    expect(bare.url).toBe("http://h.example.com:8080");
  });

  it("密码含冒号不被截断", () => {
    expect(parseProxyLine("h.example.com:8080:u:a:b:c")!.password).toBe("a:b:c");
  });

  it("跳过空行、注释与无效行", () => {
    expect(parseProxyLine("")).toBeNull();
    expect(parseProxyLine("# 注释")).toBeNull();
    expect(parseProxyLine("nonsense")).toBeNull();
    expect(parseProxyLine("h.example.com:notaport")).toBeNull();
  });

  it("去重，并丢弃指向内网的代理", () => {
    const list = parseProxyList([
      "a.example.com:1:u:p",
      "a.example.com:1:u:p",
      "127.0.0.1:8080:u:p",
      "192.168.1.5:3128",
      "b.example.com:2:u:p",
    ].join("\n"));
    expect(list.map((p) => p.server)).toEqual(["http://a.example.com:1", "http://b.example.com:2"]);
  });
});

describe("池的启用", () => {
  it("未配置文件时不启用", () => {
    expect(proxyPoolEnabled()).toBe(false);
    expect(currentProxy()).toBeNull();
  });

  it("SHOP_PROXY_ENABLED=0 可强制关闭", () => {
    process.env.SHOP_PROXY_FILE = writePool(["a.example.com:1:u:p"]);
    process.env.SHOP_PROXY_ENABLED = "0";
    expect(loadProxyPool()).toEqual([]);
  });

  it("文件不存在时退化为直连而非报错", () => {
    process.env.SHOP_PROXY_FILE = path.join(dir, "missing.txt");
    expect(loadProxyPool()).toEqual([]);
  });
});

describe("会话粘性与轮换", () => {
  beforeEach(() => {
    process.env.SHOP_PROXY_FILE = writePool([
      "a.example.com:1:u:p", "b.example.com:2:u:p", "c.example.com:3:u:p",
    ]);
  });

  it("同一会话内始终是同一个出口", async () => {
    await withProxySession("src-1", async () => {
      const first = currentProxy()!;
      expect(currentProxy()!.id).toBe(first.id);
      expect(currentProxy()!.id).toBe(first.id);
    });
  });

  it("不同会话轮换到不同出口", async () => {
    const ids: string[] = [];
    for (const key of ["s1", "s2", "s3"]) {
      await withProxySession(key, async () => { ids.push(currentProxy()!.id); });
    }
    expect(new Set(ids).size).toBe(3);
  });

  it("会话之外不使用代理（直连）", () => {
    expect(currentProxy()).toBeNull();
  });

  it("代理失效后本会话改用其它出口，且不再分配给新会话", async () => {
    let dead = "";
    await withProxySession("s1", async () => {
      const entry = currentProxy()!;
      dead = entry.id;
      reportProxyFailure(entry);
      expect(currentProxy()!.id).not.toBe(dead);
    });
    const later: string[] = [];
    for (const key of ["s2", "s3", "s4", "s5"]) {
      await withProxySession(key, async () => { later.push(currentProxy()!.id); });
    }
    expect(later).not.toContain(dead);
  });

  it("全部代理都在冷却时仍放行，不至于整轮采集失败", async () => {
    for (const key of ["s1", "s2", "s3"]) {
      await withProxySession(key, async () => { reportProxyFailure(currentProxy()!); });
    }
    await withProxySession("s9", async () => { expect(currentProxy()).not.toBeNull(); });
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
