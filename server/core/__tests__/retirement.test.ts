import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  permanentFailureReason, isEmptyRunMessage, leadingEmptyRuns,
  emptyRoundsThreshold, goneFailureThreshold, retireSource,
  retireIfPermanentFailure, retireIfLongEmpty,
} from "../retirement";
import { openDatabase } from "../../db/connection";
import { applySchema } from "../../db/init";
import { upsertSource, getSource, updateSource, recordCrawlRun } from "../../db/repo";
import { randomUUID } from "node:crypto";

describe("确定性失效的判定", () => {
  it("站点明说店铺没了 → shop_gone", () => {
    expect(permanentFailureReason("店铺信息接口拒绝：店铺链接不存在")).toBe("shop_gone");
    expect(permanentFailureReason("店铺已删除")).toBe("shop_gone");
    expect(permanentFailureReason("shop not found")).toBe("shop_gone");
  });

  it("接口 404/410 → endpoint_gone", () => {
    expect(permanentFailureReason("https://pay.qxvx.cn/shopApi/Shop/info returned HTTP 404")).toBe("endpoint_gone");
    expect(permanentFailureReason("https://x.cn/a returned HTTP 410")).toBe("endpoint_gone");
  });

  it("风控与临时故障【绝不】判为失效——停用了就不会自己恢复", () => {
    const transient = [
      "https://pay.ldxp.cn/shopApi/Shop/info 返回验证或风控页面，需要改用本机浏览器采集。",
      "https://pay.ldxp.cn/x returned HTTP 403",
      "https://pay.ldxp.cn/x returned HTTP 429",
      "https://pay.ldxp.cn/x returned HTTP 502",
      "https://pay.ldxp.cn/x returned HTTP 520",
      "fetch failed",
      "代理 http://1.2.3.4:1 不可用：ECONNREFUSED",
      "代理已启用但提取不到可用出口（快代理额度耗尽或提取接口异常）。",
      "采集器待办：未命中已实现采集器，请人工确认或等待后续采集器。",
      "page.goto: net::ERR_TUNNEL_CONNECTION_FAILED",
    ];
    for (const msg of transient) expect(permanentFailureReason(msg), msg).toBeNull();
  });

  it("404 出现在无关位置不误判", () => {
    expect(permanentFailureReason("商品 404 号规格缺货")).toBeNull();
  });
});

describe("空结果的连续计数", () => {
  it("识别空结果消息（含标价 0 的变体）", () => {
    expect(isEmptyRunMessage("采集结果为空")).toBe(true);
    expect(isEmptyRunMessage("采集结果为空（3 条标价 0 已丢弃）")).toBe(true);
    expect(isEmptyRunMessage("返回异常偏少，未做下架")).toBe(false);
    expect(isEmptyRunMessage(null)).toBe(false);
  });

  it("遇到非空立即断开", () => {
    expect(leadingEmptyRuns(["采集结果为空", "采集结果为空", null, "采集结果为空"])).toBe(2);
    expect(leadingEmptyRuns([null, "采集结果为空"])).toBe(0);
    expect(leadingEmptyRuns([])).toBe(0);
  });

  it("阈值可配，且有下限保护", () => {
    expect(emptyRoundsThreshold()).toBe(7);
    process.env.SHOP_RETIRE_EMPTY_ROUNDS = "0";
    expect(emptyRoundsThreshold()).toBe(0); // 0 = 关闭
    process.env.SHOP_RETIRE_EMPTY_ROUNDS = "1";
    expect(emptyRoundsThreshold()).toBe(2); // 一轮就停太急，抬到 2
    delete process.env.SHOP_RETIRE_EMPTY_ROUNDS;
    expect(goneFailureThreshold()).toBe(2);
  });
});

describe("落库行为", () => {
  let db: any;
  const SRC = "s-retire";

  beforeEach(() => {
    db = openDatabase(":memory:");
    applySchema(db);
    clock = 0;
    upsertSource(db, { id: SRC, name: "测试店", entryUrl: "https://pay.ldxp.cn/shop/TKN", collectorKind: "shopApi" });
  });
  afterEach(() => {
    db.close();
    delete process.env.SHOP_RETIRE_EMPTY_ROUNDS;
  });

  // 递增时间戳：recentRunMessages 按 started_at DESC 取，顺序必须是确定的
  let clock = 0;
  const addRun = (message: string | null) => {
    clock += 1;
    const at = new Date(Date.UTC(2026, 0, 1, 0, 0, clock)).toISOString();
    recordCrawlRun(db, {
      id: randomUUID(), sourceId: SRC, sourceName: "测试店", mode: "http", status: message ? "partial" : "success",
      startedAt: at, finishedAt: at, successCount: 0, failureCount: 0, message, details: {},
    });
  };

  it("停用会保留用户原有备注", () => {
    updateSource(db, SRC, { notes: "这家是老板娘的店" });
    retireSource(db, SRC, "shop_gone", "店铺链接不存在");
    const s = getSource(db, SRC)!;
    expect(s.enabled).toBe(0);
    expect(s.notes).toContain("[自动停用] 店铺已不存在");
    expect(s.notes).toContain("这家是老板娘的店");
  });

  it("店铺不存在立即停用；404 要连续失败到阈值才停", () => {
    expect(retireIfPermanentFailure(db, SRC, "店铺链接不存在", 1)).toContain("店铺已不存在");
    updateSource(db, SRC, { enabled: true });
    expect(retireIfPermanentFailure(db, SRC, "a returned HTTP 404", 1)).toBeNull();
    expect(getSource(db, SRC)!.enabled).toBe(1);
    expect(retireIfPermanentFailure(db, SRC, "a returned HTTP 404", 2)).toContain("站点接口已下线");
    expect(getSource(db, SRC)!.enabled).toBe(0);
  });

  it("风控消息再多次也不会停用", () => {
    for (let i = 1; i <= 30; i += 1) {
      expect(retireIfPermanentFailure(db, SRC, "返回验证或风控页面，需要改用本机浏览器采集。", i)).toBeNull();
    }
    expect(getSource(db, SRC)!.enabled).toBe(1);
  });

  it("空店满阈值才停用，本轮结果计入", () => {
    process.env.SHOP_RETIRE_EMPTY_ROUNDS = "3";
    addRun("采集结果为空");
    expect(retireIfLongEmpty(db, SRC, "采集结果为空")).toBeNull(); // 历史 1 + 本轮 1 = 2
    addRun("采集结果为空");
    const line = retireIfLongEmpty(db, SRC, "采集结果为空");           // 历史 2 + 本轮 1 = 3
    expect(line).toContain("连续 3 轮");
    expect(getSource(db, SRC)!.enabled).toBe(0);
  });

  it("中间采到过商品就重新计数", () => {
    process.env.SHOP_RETIRE_EMPTY_ROUNDS = "3";
    addRun("采集结果为空");
    addRun("采集结果为空");
    addRun(null); // 采到了
    expect(retireIfLongEmpty(db, SRC, "采集结果为空")).toBeNull();
    expect(getSource(db, SRC)!.enabled).toBe(1);
  });

  it("本轮不是空结果时不参与判定", () => {
    process.env.SHOP_RETIRE_EMPTY_ROUNDS = "2";
    addRun("采集结果为空");
    addRun("采集结果为空");
    expect(retireIfLongEmpty(db, SRC, null)).toBeNull();
  });

  it("阈值设 0 可整体关闭", () => {
    process.env.SHOP_RETIRE_EMPTY_ROUNDS = "0";
    for (let i = 0; i < 20; i += 1) addRun("采集结果为空");
    expect(retireIfLongEmpty(db, SRC, "采集结果为空")).toBeNull();
    expect(getSource(db, SRC)!.enabled).toBe(1);
  });

  it("重新启用后能重新拿满一个完整周期，而不是空一轮就又被停掉", () => {
    process.env.SHOP_RETIRE_EMPTY_ROUNDS = "3";
    addRun("采集结果为空");
    addRun("采集结果为空");
    expect(retireIfLongEmpty(db, SRC, "采集结果为空")).toContain("连续 3 轮");
    // 停用那一轮落库的是停用说明（orchestrator 的行为），连续计数在此断开
    addRun("[自动停用] 长期没有商品：连续 3 轮采集结果为空（本轮：采集结果为空）");
    updateSource(db, SRC, { enabled: true });
    expect(retireIfLongEmpty(db, SRC, "采集结果为空")).toBeNull();
    expect(getSource(db, SRC)!.enabled).toBe(1);
  });
});
