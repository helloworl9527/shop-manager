import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import type { Collector, CollectorOffer, CollectorTarget } from "./types";
import { normalizeKeyFromTitle } from "../core/ids";
import { cleanText, numberOrNull, compact, isNonComparableTitle, statusFromStock, shopTokenFromUrl } from "./util";
import { playwrightProxy } from "../core/proxy";

/** page.evaluate 注入垫片：修复 tsx/esbuild keepNames 注入的 __name 在浏览器内未定义。传字符串避免被改写。 */
export const NAME_SHIM = "globalThis.__name = globalThis.__name || function (f) { return f; };";

const BROWSER_CANDIDATES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
];

const PROFILE_DIR = process.env.SHOP_BROWSER_PROFILE || path.join(os.homedir(), ".shop-manager", "browser-profile");
const PROFILE_UA_FILE = path.join(PROFILE_DIR, "shop-manager-user-agent.txt");
const profileQueue: Array<() => void> = [];
let profileLocked = false;

export class ChallengeBlockedError extends Error {
  constructor(message = "Cloudflare 挑战未通过（无头模式被拦），需有头浏览器或人工处理") {
    super(message);
    this.name = "ChallengeBlockedError";
  }
}

export function isChallengeBlockedError(err: unknown): boolean {
  return err instanceof ChallengeBlockedError || /Cloudflare 挑战未通过|挑战未通过|challenge.*blocked/i.test(err instanceof Error ? err.message : String(err ?? ""));
}

export function browserProfileDir(): string {
  return PROFILE_DIR;
}

function readProfileUserAgent(): string | null {
  try {
    const value = readFileSync(PROFILE_UA_FILE, "utf8").trim();
    return value || null;
  } catch {
    return null;
  }
}

export function saveProfileUserAgent(userAgent: string): void {
  const value = String(userAgent || "").trim();
  if (!value) return;
  try {
    writeFileSync(PROFILE_UA_FILE, value, "utf8");
  } catch {
    // UA 只用于提高 cookie 复用稳定性，写入失败不应阻断采集。
  }
}

export async function acquireProfileLock(): Promise<() => void> {
  if (profileLocked) {
    await new Promise<void>((resolve) => profileQueue.push(resolve));
  }
  profileLocked = true;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const next = profileQueue.shift();
    if (next) {
      next();
    } else {
      profileLocked = false;
    }
  };
}

export function findBrowserPath(): string | null {
  return process.env.BROWSER_PATH || BROWSER_CANDIDATES.find((p) => existsSync(p)) || null;
}

function withTimeout<T>(p: Promise<T>, ms: number, msg: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(msg)), ms);
  });
  return Promise.race([p.finally(() => clearTimeout(timer)), timeout]);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 统一的浏览器会话：启动本机 Chrome（带超时 + 重试一次）→ 跑 fn(page)（带总超时）→ 必定关闭。
 * 默认无头：后端是后台进程，有头窗口易卡在 macOS 自动化授权/无人交互上；无头 Chrome 同样执行 JS、能过阿里云脚本挑战。
 */
async function withBrowser<T>(fn: (page: any) => Promise<T>): Promise<T> {
  const release = await acquireProfileLock();
  const browserPath = findBrowserPath();
  if (!browserPath) {
    release();
    throw new Error("未找到本机浏览器（Chrome/Edge/Brave/Chromium）。可设置环境变量 BROWSER_PATH 指定。");
  }

  let context: any = null;
  try {
    context = await launchPersistentBrowserContext({ headless: process.env.BROWSER_HEADLESS !== "0" });
    const overallMs = Number(process.env.BROWSER_TIMEOUT_MS || 90000);
    return await withTimeout(
      (async () => {
        const page = await context.newPage();
        // 修复 tsx/esbuild 的 keepNames 给 page.evaluate 注入 __name 导致浏览器内 ReferenceError：
        // 导航前注入一个 __name 垫片（传字符串，esbuild 不会改写字符串字面量）
        await page.addInitScript(NAME_SHIM);
        return await fn(page);
      })(),
      overallMs,
      "浏览器采集超时",
    );
  } finally {
    if (context) await context.close().catch(() => {});
    release();
  }
}

export async function launchPersistentBrowserContext(opts: { headless: boolean }): Promise<any> {
  const browserPath = findBrowserPath();
  if (!browserPath) throw new Error("未找到本机浏览器（Chrome/Edge/Brave/Chromium）。可设置环境变量 BROWSER_PATH 指定。");

  let chromium: any;
  try {
    ({ chromium } = await import("playwright-core"));
  } catch {
    throw new Error("缺少 playwright-core，请先安装：npm i playwright-core");
  }

  await mkdir(PROFILE_DIR, { recursive: true });
  const launchMs = Number(process.env.BROWSER_LAUNCH_TIMEOUT_MS || 60000);
  // Linux 小内存服务器：/dev/shm 常仅 64MB，无头 Chrome 会因共享内存不足崩标签页 →
  // --disable-dev-shm-usage 改用 /tmp；--disable-gpu/--disable-extensions 降内存占用。
  const args = [
    "--disable-blink-features=AutomationControlled",
    "--no-sandbox", "--no-first-run", "--no-default-browser-check",
    "--disable-dev-shm-usage", "--disable-gpu", "--disable-extensions",
  ];
  const userAgent = opts.headless ? readProfileUserAgent() : null;
  const proxy = await playwrightProxy();
  const launchOnce = () =>
    withTimeout(
      chromium.launchPersistentContext(PROFILE_DIR, {
        executablePath: browserPath,
        headless: opts.headless,
        timeout: launchMs,
        viewport: { width: 1440, height: 980 },
        userAgent: userAgent ?? undefined,
        // 浏览器采集与 HTTP 采集必须走同一出口：同一家店铺先 HTTP 再回退浏览器时，
        // 若出口 IP 变了，站点侧看到的是「同一会话换了 IP」，比不用代理更可疑。
        proxy,
        args,
      }),
      launchMs + 5000,
      "浏览器启动超时",
    );

  try {
    return await launchOnce();
  } catch {
    return await launchOnce(); // 偶发启动超时（本机 Chrome 占用等）→ 重试一次
  }
}

async function findFreePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((err) => {
        if (err) reject(err);
        else resolve(port);
      });
    });
  });
}

export function buildInteractiveVerificationArgs(port: number, profileDir = PROFILE_DIR): string[] {
  return [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
  ];
}

export function isProfileInUseMessage(message: string): boolean {
  return /profile.*(?:in use|被占用)|user data directory.*(?:in use|already in use)|SingletonLock|ProcessSingleton|Opening in existing browser session/i.test(message);
}

async function waitForCdpEndpoint(port: number, child: ChildProcess, stderrParts: string[], launchMs: number): Promise<string> {
  const endpoint = `http://127.0.0.1:${port}`;
  const childExit: { current: { code: number | null; signal: NodeJS.Signals | null } | null } = { current: null };
  child.once("exit", (code, signal) => {
    childExit.current = { code, signal };
  });

  const started = Date.now();
  while (Date.now() - started < launchMs) {
    const stderr = stderrParts.join("");
    if (isProfileInUseMessage(stderr)) {
      throw new Error("验证用 Chrome profile 正在被占用，请关闭已打开的验证窗口后重试");
    }
    if (childExit.current) {
      const detail = stderr.trim();
      throw new Error(detail ? `验证用 Chrome 启动失败：${detail}` : `验证用 Chrome 启动失败（code=${childExit.current.code ?? "null"} signal=${childExit.current.signal ?? "null"}）`);
    }
    try {
      const res = await fetch(`${endpoint}/json/version`);
      if (res.ok) return endpoint;
    } catch {
      // 调试端口尚未就绪，继续等。
    }
    await sleep(250);
  }

  const stderr = stderrParts.join("");
  if (isProfileInUseMessage(stderr)) {
    throw new Error("验证用 Chrome profile 正在被占用，请关闭已打开的验证窗口后重试");
  }
  throw new Error("验证用 Chrome 调试端口连接超时");
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    const done = () => resolve();
    const killTimer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }, 2000);
    child.once("exit", () => {
      clearTimeout(killTimer);
      done();
    });
    if (!child.kill("SIGTERM")) {
      clearTimeout(killTimer);
      done();
    }
  });
}

export async function launchInteractiveVerificationContext(_opts: { headless: boolean }): Promise<any> {
  const browserPath = findBrowserPath();
  if (!browserPath) throw new Error("未找到本机浏览器（Chrome/Edge/Brave/Chromium）。可设置环境变量 BROWSER_PATH 指定。");

  let chromium: any;
  try {
    ({ chromium } = await import("playwright-core"));
  } catch {
    throw new Error("缺少 playwright-core，请先安装：npm i playwright-core");
  }

  await mkdir(PROFILE_DIR, { recursive: true });
  const port = await findFreePort();
  const args = buildInteractiveVerificationArgs(port, PROFILE_DIR);
  const stderrParts: string[] = [];
  const child = spawn(browserPath, args, { stdio: ["ignore", "ignore", "pipe"] });
  child.stderr?.on("data", (chunk) => {
    stderrParts.push(String(chunk));
    if (stderrParts.join("").length > 8000) stderrParts.splice(0, stderrParts.length - 1);
  });

  let browser: any = null;
  let closed = false;
  const closeHandlers = new Set<() => void>();
  const emitClose = () => {
    for (const handler of closeHandlers) handler();
  };

  try {
    const launchMs = Number(process.env.BROWSER_LAUNCH_TIMEOUT_MS || 60000);
    const endpoint = await waitForCdpEndpoint(port, child, stderrParts, launchMs);
    browser = await chromium.connectOverCDP(endpoint);
    browser.on?.("disconnected", emitClose);
    child.on("exit", emitClose);

    return {
      async newPage() {
        const context = browser.contexts()[0];
        if (!context) throw new Error("验证用 Chrome 未返回可用上下文");
        return await context.newPage();
      },
      on(event: string, handler: () => void) {
        if (event === "close") closeHandlers.add(handler);
      },
      async close() {
        if (closed) return;
        closed = true;
        try {
          browser?.disconnect?.();
        } catch {
          // 断开 CDP 失败也要继续关闭子进程。
        }
        await stopChild(child);
      },
    };
  } catch (err) {
    try {
      browser?.disconnect?.();
    } catch {
      // 忽略清理错误，保留原始启动错误。
    }
    await stopChild(child).catch(() => {});
    throw err;
  }
}

const waitMs = () => Number(process.env.BROWSER_WAIT_MS || 8000);
const renderWaitMs = () => Number(process.env.BROWSER_RENDER_WAIT_MS || 12000);
const challengeMaxMs = () => Number(process.env.BROWSER_CHALLENGE_TIMEOUT_MS || 24000);
const challengePollMs = () => Number(process.env.BROWSER_CHALLENGE_POLL_MS || 2000);

export interface BrowserPageSnapshot {
  title: string;
  bodyText: string;
  html: string;
}

export function isCloudflareChallengeSnapshot(snapshot: BrowserPageSnapshot): boolean {
  const value = `${snapshot.title}\n${snapshot.bodyText.slice(0, 1000)}\n${snapshot.html.slice(0, 4000)}`;
  return /Just a moment|请稍候|cf-chl|__cf_chl|challenge-platform|challenge-form|cloudflare/i.test(value);
}

export async function pageSnapshot(page: any): Promise<BrowserPageSnapshot> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return (await page.evaluate(() => ({
        title: document.title || "",
        bodyText: document.body?.innerText || document.body?.textContent || "",
        html: document.documentElement?.innerHTML || "",
      }))) as BrowserPageSnapshot;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!/Execution context was destroyed|Cannot find context|navigation/i.test(message) || attempt === 2) throw err;
      await page.waitForTimeout(500);
    }
  }
  return { title: "", bodyText: "", html: "" };
}

export async function gotoWithRetry(page: any, url: string): Promise<void> {
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
  } catch (err) {
    if (!/Timeout|超时/i.test(err instanceof Error ? err.message : String(err))) throw err;
    await page.goto(url, { waitUntil: "commit", timeout: 45000 });
  }
}

export async function waitForChallengeToClear(page: any, maxMs = challengeMaxMs(), pollMs = challengePollMs()): Promise<BrowserPageSnapshot> {
  const started = Date.now();
  let latest = await pageSnapshot(page);
  while (isCloudflareChallengeSnapshot(latest)) {
    if (Date.now() - started >= maxMs) {
      throw new ChallengeBlockedError();
    }
    await page.waitForTimeout(pollMs);
    latest = await pageSnapshot(page);
  }
  return latest;
}

function priceSignalCount(value: string): number {
  return (
    value.match(/[¥￥]\s*\d|\d[\d,]*\s*(?:元|CNY|RMB)|PRICE\s*\d/gi) ?? []
  ).length;
}

export async function waitForContentSettled(page: any, maxMs = renderWaitMs(), pollMs = 1500): Promise<BrowserPageSnapshot> {
  const started = Date.now();
  let prevLen = -1;
  let latest = await pageSnapshot(page);

  while (Date.now() - started < maxMs) {
    const bodyText = latest.bodyText.trim();
    const len = bodyText.length;
    if (priceSignalCount(bodyText) >= 1) return latest;
    if (len > 500 && prevLen >= 0 && Math.abs(len - prevLen) < len * 0.05) return latest;
    prevLen = len;
    await page.waitForTimeout(pollMs);
    latest = await pageSnapshot(page);
  }

  return latest;
}

/** 在页面里执行的通用 DOM 提取（兜底，用于没有已知接口的 HTML 站）。 */
export function extractOffersInPage(): Array<{ sourceTitle: string; price: number | null; status: string; url: string; tags: string[]; stockCount: number | null }> {
  const pricePattern = /(?:[¥￥]\s*|PRICE\s*|价格[:：]?\s*|(?:^|\s))(\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)(?:\s*(?:元|CNY|RMB))?/i;
  const stockPattern = /库存[:：]?\s*(\d+)/;
  const selectors = ["article", "li", "a", "button", "[class*='product']", "[class*='goods']", "[class*='item']", "[class*='card']", "[class*='shop']"];
  const nodes = Array.from(document.querySelectorAll(selectors.join(",")));
  const seen = new Set<string>();
  const results: Array<{ sourceTitle: string; price: number | null; status: string; url: string; tags: string[]; stockCount: number | null }> = [];
  for (const node of nodes) {
    const text = ((node as HTMLElement).innerText || node.textContent || "").replace(/\s+/g, " ").trim();
    if (text.length < 8 || text.length > 520) continue;
    if (/版权所有|保留所有权利|隐私政策|服务条款|copyright|privacy|terms/i.test(text)) continue;
    const priceMatch = text.match(pricePattern);
    if (!priceMatch) continue;
    const priceText = priceMatch[1];
    if (!priceText) continue;
    const price = Number(priceText.replace(/,/g, ""));
    if (!Number.isFinite(price)) continue;
    if (price >= 2000 && price <= 2100 && /©|版权|copyright|保留所有权利/i.test(text)) continue;
    const linkNode = (node as HTMLElement).closest("a") || (node as HTMLElement).querySelector?.("a");
    const url = (linkNode as HTMLAnchorElement)?.href || window.location.href;
    const key = `${text}|${url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const stockMatch = text.match(stockPattern);
    const stockCount = stockMatch ? Number(stockMatch[1]) : null;
    const status =
      text.includes("库存：0") || text.includes("库存:0") || text.includes("缺货") || text.includes("售罄")
        ? "out_of_stock"
        : stockCount !== null && stockCount <= 3
          ? "low_stock"
          : "in_stock";
    const title = text.replace(/库存[:：]?\s*\d+/g, "").replace(/(?:[¥￥]\s*|PRICE\s*|价格[:：]?\s*)?\d[\d,.]*(?:\s*(?:元|CNY|RMB))?/gi, "").replace(/下单|购买|自动发货|人工处理/g, "").trim().slice(0, 180);
    if (!title || title.length < 4) continue;
    results.push({ sourceTitle: title, price, status, url, tags: ["浏览器采集"], stockCount });
  }
  return results.slice(0, 120);
}

/** 通用 HTML 兜底浏览器采集（DOM 提取）。 */
export const collectBrowser: Collector = async (target) =>
  withBrowser(async (page) => {
    await gotoWithRetry(page, target.sourceUrl);
    await waitForChallengeToClear(page);
    await waitForContentSettled(page);
    const raw = (await page.evaluate(extractOffersInPage)) as Array<{ sourceTitle: string; price: number | null; status: string; url: string; tags: string[]; stockCount: number | null }>;
    if (raw.length === 0) {
      throw new Error("浏览器采集未提取到商品（页面渲染后仍无内容或无价格特征）");
    }
    return raw.map<CollectorOffer>((o) => ({ ...o, externalKey: `br:${normalizeKeyFromTitle(o.sourceTitle)}`, sourceStoreName: target.sourceStoreName }));
  });

/**
 * 链动小铺/ShopApi 的浏览器采集：先用浏览器过掉阿里云 WAF（拿到 acw 风控 cookie），
 * 再在页面上下文里直接调 /shopApi/Shop/* 接口拿结构化数据——比 DOM 抓取可靠得多。
 */
/** 在已导航（且已过验证）的页面里调 shopApi 接口拿结构化数据。供自动回退与人工模式复用。 */
export async function extractShopApiViaPage(page: any, base: string, token: string): Promise<{ ok: boolean; storeName: string; items: any[] }> {
  return (await page.evaluate(
    async ({ base, token }: { base: string; token: string }) => {
      const post = async (path: string, body: unknown) => {
        const r = await fetch(base + path, {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json, text/plain, */*", visitorid: "probe" + Math.random().toString(36).slice(2, 10) },
          body: JSON.stringify(body),
        });
        const t = await r.text();
        try { return JSON.parse(t); } catch { return null; }
      };
      const info: any = await post("/shopApi/Shop/info", { token, category_key: "" });
      if (!info || info.code !== 1 || !info.data) return { ok: false, storeName: "", items: [] as any[] };
      const storeName = info.data.nickname || "";
      const cats: any = await post("/shopApi/Shop/categoryList", { token, goods_type: "card", category_key: "" });
      const categories: any[] = cats && Array.isArray(cats.data) ? cats.data : [];
      const selected = categories.filter((c) => Number(c.goods_count || 0) > 0 && Number(c.id) !== 0);
      const catIds = selected.length ? selected.map((c) => Number(c.id)) : categories.some((c) => Number(c.id) === 0) ? [0] : [];
      const items: any[] = [];
      for (const cid of catIds) {
        for (let p = 1; p <= 10; p++) {
          const list: any = await post("/shopApi/Shop/goodsList", { token, keywords: "", category_id: cid, goods_type: "card", current: p, pageSize: 100 });
          const arr: any[] = list && list.data && Array.isArray(list.data.list) ? list.data.list : [];
          if (!arr.length) break;
          for (const it of arr) {
            items.push({
              name: it.name, price: it.price != null ? it.price : it.real_price, status: it.status,
              stock: it.extend ? it.extend.stock_count : null, goods_key: it.goods_key, link: it.link,
              goods_type: it.goods_type, send_order: it.extend ? it.extend.send_order : null,
              category_name: it.category ? it.category.name : "",
            });
          }
          if (arr.length < 100) break;
        }
      }
      return { ok: true, storeName, items };
    },
    { base, token },
  )) as { ok: boolean; storeName: string; items: any[] };
}

/** 把 shopApi 原始 items 映射成 CollectorOffer。 */
export function mapShopApiItems(result: { storeName: string; items: any[] }, target: CollectorTarget): CollectorOffer[] {
  const offers: CollectorOffer[] = [];
  for (const it of result.items) {
    const title = cleanText(it.name);
    const price = numberOrNull(it.price);
    if (!title || price === null || isNonComparableTitle(title)) continue;
    const stockCount = numberOrNull(it.stock);
    const status = Number(it.status ?? 1) !== 1 ? "out_of_stock" : statusFromStock(stockCount);
    offers.push({
      sourceTitle: title,
      price,
      status,
      stockCount,
      sourceStoreName: result.storeName || target.sourceStoreName,
      url: it.link || `${target.baseUrl}/item/${it.goods_key}`,
      externalKey: it.goods_key != null ? String(it.goods_key) : null,
      tags: compact([cleanText(it.category_name || ""), it.goods_type === "card" ? "卡密" : null, it.send_order === 0 ? "自动发货" : null]),
    });
  }
  return offers;
}

export const collectShopApiViaBrowser: Collector = async (target) => {
  const token = shopTokenFromUrl(target.sourceUrl);
  if (!token) throw new Error("ShopApi 浏览器采集需要 /shop/<token> 链接。");
  return withBrowser(async (page) => {
    await gotoWithRetry(page, target.sourceUrl);
    await waitForChallengeToClear(page);
    await page.waitForTimeout(waitMs()); // 等阿里云 JS 挑战自动过 + 重载，cookie 落定
    const result = await extractShopApiViaPage(page, target.baseUrl, token);
    if (!result.ok) throw new Error("浏览器内调用 shopApi 仍失败（站点可能需要人工验证/登录，或风控更严）。");
    return mapShopApiItems(result, target);
  });
};
