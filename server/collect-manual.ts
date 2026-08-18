import "./load-env";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { openDatabase } from "./db/connection";
import { defaultDbPath } from "./db/init";
import {
  getSource, findSourceByEntryUrl, upsertSource, targetFromSource,
  upsertOffers, recordCrawlRun, markSourceSuccess, nowIso,
} from "./db/repo";
import { findBrowserPath, extractShopApiViaPage, mapShopApiItems, extractOffersInPage, NAME_SHIM } from "./collectors/browser";
import { shopTokenFromUrl, normalizeHostname } from "./collectors/util";
import { normalizeKeyFromTitle } from "./core/ids";
import type { CollectorOffer } from "./collectors/types";

/**
 * 人工验证采集（WAF / 需滑块或登录的站点）：
 *   npm run collect:manual -- --url https://pay.qxvx.cn/shop/JYKGUAEK
 * 弹出可见浏览器 → 你手动过验证/滑块/登录 → 回终端按回车 → 采集并写库。
 */
function parseArgs(argv: string[]) {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]!;
    if (a.startsWith("--")) { out[a.slice(2)] = argv[i + 1] && !argv[i + 1]!.startsWith("--") ? argv[++i]! : "true"; }
  }
  return out;
}

function deriveName(url: string): string {
  try {
    const u = new URL(url);
    const token = shopTokenFromUrl(url);
    return token ? `${u.hostname.replace(/^www\./, "")} / ${token}` : u.hostname.replace(/^www\./, "");
  } catch { return url; }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dbPath = args.db || defaultDbPath();
  const db = openDatabase(dbPath);

  try {
    let source = args.source ? getSource(db, args.source) : args.url ? findSourceByEntryUrl(db, args.url) : undefined;
    if (!source && args.url) {
      const id = `src-${normalizeHostname(args.url).split(".")[0] || "shop"}-${randomUUID().slice(0, 6)}`;
      upsertSource(db, {
        id,
        name: deriveName(args.url),
        entryUrl: args.url,
        collectorKind: "browser",
        collectionMethod: "browser",
        kindDetectedAt: nowIso(),
        kindEvidence: "终端人工验证模式创建，使用浏览器采集",
      });
      source = getSource(db, id);
    }
    if (!source) {
      console.error("用法: --url <店铺链接>  或  --source <已存在的店铺id>");
      process.exit(1);
    }

    const target = targetFromSource(source);
    const token = shopTokenFromUrl(target.sourceUrl);
    const browserPath = findBrowserPath();
    if (!browserPath) {
      console.error("未找到本机浏览器（Chrome/Edge/Brave）。可设环境变量 BROWSER_PATH 指定。");
      process.exit(1);
    }
    let chromium: any;
    try { ({ chromium } = await import("playwright-core")); } catch {
      console.error("缺少 playwright-core，请先 npm install。");
      process.exit(1);
    }

    const browser = await chromium.launch({ executablePath: browserPath, headless: false, args: ["--disable-blink-features=AutomationControlled"] });
    try {
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
      await page.addInitScript(NAME_SHIM);
      console.log(`\n已打开：${target.sourceUrl}`);
      await page.goto(target.sourceUrl, { waitUntil: "domcontentloaded", timeout: 60000 });

      const rl = createInterface({ input: stdin, output: stdout });
      await rl.question("\n>>> 在弹出的浏览器窗口里完成验证/滑块/登录，看到商品页面后，回到这里按【回车】开始采集…\n");
      rl.close();

      const startedAt = nowIso();
      let offers: CollectorOffer[] = [];
      if (token) {
        const result = await extractShopApiViaPage(page, target.baseUrl, token);
        if (!result.ok) {
          console.error("仍无法调用 shopApi —— 可能验证没真正通过或需要登录。可在浏览器里再确认页面已正常显示商品后重试。");
          recordCrawlRun(db, { id: randomUUID(), sourceId: source.id, sourceName: source.name, mode: "browser", status: "failed", startedAt, finishedAt: nowIso(), successCount: 0, failureCount: 1, message: "人工验证后仍被拦", details: { manual: true } });
          process.exit(1);
        }
        offers = mapShopApiItems(result, target);
      } else {
        const raw = (await page.evaluate(extractOffersInPage)) as any[];
        offers = raw.map((o) => ({ ...o, externalKey: `br:${normalizeKeyFromTitle(o.sourceTitle)}`, sourceStoreName: target.sourceStoreName }));
      }

      const r = upsertOffers(db, target, "browser", offers);
      recordCrawlRun(db, {
        id: randomUUID(), sourceId: source.id, sourceName: source.name, mode: "browser",
        status: offers.length ? "success" : "partial", startedAt, finishedAt: nowIso(),
        successCount: r.written, failureCount: 0, message: "人工验证后浏览器采集", details: { manual: true, received: offers.length },
      });
      markSourceSuccess(db, source.id, offers.length ? "success" : "partial", nowIso());

      console.log(`\n采集完成：${offers.length} 条（写入 ${r.written}）。回前台刷新即可看到。`);
      if (offers.length) console.table(offers.slice(0, 12).map((o) => ({ 商品: o.sourceTitle.slice(0, 30), 价格: o.price, 状态: o.status })));
    } finally {
      await browser.close().catch(() => {});
    }
  } finally {
    db.close();
  }
}

main().catch((e) => {
  console.error("人工采集失败：", e instanceof Error ? e.message : e);
  process.exit(1);
});
