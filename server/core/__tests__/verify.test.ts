import { beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type SqliteDatabase } from "../../db/connection";
import { applySchema, seedCanonicalProducts } from "../../db/init";
import { countActiveOffers, getSource, upsertSource } from "../../db/repo";
import { getVerifySessionState, resetVerifySessionForTests, startVerifySession } from "../verify";

function db(): SqliteDatabase {
  const d = openDatabase(":memory:");
  applySchema(d);
  seedCanonicalProducts(d);
  upsertSource(d, { id: "s-cf", name: "CF 店", entryUrl: "https://cf.test/", collectorKind: "browser", collectionMethod: "browser" });
  d.prepare("UPDATE sources SET health_status='manual_required', last_error='Cloudflare 挑战未通过' WHERE id='s-cf'").run();
  return d;
}

async function waitForIdle(): Promise<void> {
  for (let i = 0; i < 50; i += 1) {
    if (getVerifySessionState().status === "idle") return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("verify session did not finish");
}

function fakeContext(page: any) {
  return {
    async newPage() { return page; },
    on() {},
    async close() {},
  };
}

beforeEach(() => {
  resetVerifySessionForTests();
});

describe("VerifySession", () => {
  it("挑战消失后就地采集并恢复 healthy", async () => {
    const d = db();
    const page = {
      async addInitScript() {},
      async goto() {},
      async waitForTimeout() {},
      async close() {},
      async evaluate(fn: unknown) {
        const code = String(fn);
        if (code.includes("document.title")) {
          return { title: "商品列表", bodyText: "ChatGPT Plus PRICE30 CNY", html: "<main>ok</main>" };
        }
        return [{ sourceTitle: "ChatGPT Plus 月卡", price: 30, status: "in_stock", url: "https://cf.test/p/1", tags: ["浏览器采集"], stockCount: 8 }];
      },
    };

    const started = startVerifySession(d, {
      deps: { launchContext: async () => fakeContext(page), pollMs: 1, tabTimeoutMs: 50, sessionTimeoutMs: 500 },
    });
    expect(started.status).toBe("running");
    await waitForIdle();

    const state = getVerifySessionState();
    expect(state.targets[0]).toMatchObject({ status: "collected", offers: 1 });
    expect(getSource(d, "s-cf")!.health_status).toBe("healthy");
    expect(countActiveOffers(d, "s-cf")).toBe(1);
    const run = d.prepare("SELECT mode, status, success_count FROM crawl_runs WHERE source_id='s-cf'").get() as any;
    expect(run).toMatchObject({ mode: "browser-verify", status: "success", success_count: 1 });
  });

  it("挑战一直存在则超时并保持 manual_required", async () => {
    const d = db();
    const page = {
      async addInitScript() {},
      async goto() {},
      async waitForTimeout() {},
      async close() {},
      async evaluate() {
        return { title: "Just a moment...", bodyText: "", html: "<div id=\"challenge-platform\"></div>" };
      },
    };

    startVerifySession(d, {
      deps: { launchContext: async () => fakeContext(page), pollMs: 1, tabTimeoutMs: 1, sessionTimeoutMs: 500 },
    });
    await waitForIdle();

    const state = getVerifySessionState();
    expect(state.targets[0]?.status).toBe("timeout");
    expect(getSource(d, "s-cf")!.health_status).toBe("manual_required");
    const run = d.prepare("SELECT mode, status, failure_count FROM crawl_runs WHERE source_id='s-cf'").get() as any;
    expect(run).toMatchObject({ mode: "browser-verify", status: "timeout", failure_count: 0 });
  });

  it("非挑战页暂时无商品时继续等待，商品出现后写库", async () => {
    const d = db();
    let extractCalls = 0;
    const page = {
      async addInitScript() {},
      async goto() {},
      async waitForTimeout() {
        await new Promise((resolve) => setTimeout(resolve, 1));
      },
      async close() {},
      async evaluate(fn: unknown) {
        const code = String(fn);
        if (code.includes("document.title")) {
          return { title: "商品列表", bodyText: "商品加载中", html: "<main>loading</main>" };
        }
        extractCalls += 1;
        return extractCalls >= 2
          ? [{ sourceTitle: "ChatGPT Plus 月卡", price: 30, status: "in_stock", url: "https://cf.test/p/1", tags: ["浏览器采集"], stockCount: 8 }]
          : [];
      },
    };

    startVerifySession(d, {
      deps: { launchContext: async () => fakeContext(page), pollMs: 1, tabTimeoutMs: 100, sessionTimeoutMs: 500 },
    });
    await waitForIdle();

    const state = getVerifySessionState();
    expect(state.targets[0]).toMatchObject({ status: "collected", offers: 1 });
    expect(extractCalls).toBeGreaterThanOrEqual(2);
  });

  it("非挑战页一直无商品时超时，不写验证通过后未提取到商品失败", async () => {
    const d = db();
    const page = {
      async addInitScript() {},
      async goto() {},
      async waitForTimeout() {
        await new Promise((resolve) => setTimeout(resolve, 1));
      },
      async close() {},
      async evaluate(fn: unknown) {
        const code = String(fn);
        if (code.includes("document.title")) {
          return { title: "商品列表", bodyText: "商品加载中", html: "<main>loading</main>" };
        }
        return [];
      },
    };

    startVerifySession(d, {
      deps: { launchContext: async () => fakeContext(page), pollMs: 1, tabTimeoutMs: 5, sessionTimeoutMs: 500 },
    });
    await waitForIdle();

    const state = getVerifySessionState();
    expect(state.targets[0]?.status).toBe("timeout");
    expect(state.targets[0]?.message).toMatch(/未提取到商品/);
    expect(state.targets[0]?.message).not.toMatch(/验证通过后未提取到商品/);
    expect(getSource(d, "s-cf")!.health_status).toBe("manual_required");
    expect(countActiveOffers(d, "s-cf")).toBe(0);
  });

  it("窗口关闭类错误统一记录为验证窗口已关闭", async () => {
    const d = db();
    const page = {
      async addInitScript() {},
      async goto() {},
      async waitForTimeout() {},
      async close() {},
      async evaluate() {
        throw new Error("Target page, context or browser has been closed");
      },
    };

    startVerifySession(d, {
      deps: { launchContext: async () => fakeContext(page), pollMs: 1, tabTimeoutMs: 50, sessionTimeoutMs: 500 },
    });
    await waitForIdle();

    const state = getVerifySessionState();
    expect(state.targets[0]).toMatchObject({ status: "failed", message: "验证窗口已关闭" });
    const run = d.prepare("SELECT status, message, failure_count FROM crawl_runs WHERE source_id='s-cf'").get() as any;
    expect(run).toMatchObject({ status: "failed", message: "验证窗口已关闭", failure_count: 0 });
  });
});
