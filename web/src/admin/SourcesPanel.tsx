import { useCallback, useEffect, useMemo, useState } from "react";
import { api, COLLECTOR_KINDS, type Source, type SourceMethodDrift, type Job, type SourceProbeResult, type VerifyPendingSource, type VerifySessionState, type VerifyTargetState } from "../api";

const HEALTH: Record<string, { label: string; cls: string }> = {
  healthy: { label: "正常", cls: "b-ok" },
  retrying: { label: "重试中", cls: "b-warn" },
  partial: { label: "部分", cls: "b-warn" },
  failing: { label: "失败", cls: "b-danger" },
  manual_required: { label: "待验证", cls: "b-warn" },
  disabled: { label: "停用", cls: "b-muted" },
  unknown: { label: "未采集", cls: "b-muted" },
};

const KIND_LABELS: Record<string, string> = {
  auto: "自动识别",
  kami: "异次元/卡网",
  dujiao: "独角 API",
  dujiaoHtml: "独角 HTML",
  shopApi: "链动小铺",
  publicProductsApi: "公开商品 API",
  genericHtml: "通用 HTML",
  browser: "需浏览器",
  pending: "待办",
  unsupported: "不支持",
};

function kindLabel(kind: string | null | undefined): string {
  const value = kind || "auto";
  return KIND_LABELS[value] ?? value;
}

const VERIFY_LABELS: Record<VerifyTargetState["status"], { label: string; cls: string }> = {
  waiting: { label: "等待验证", cls: "b-warn" },
  passed: { label: "已通过", cls: "b-ok" },
  collected: { label: "已采集", cls: "b-ok" },
  failed: { label: "失败", cls: "b-danger" },
  timeout: { label: "超时", cls: "b-danger" },
};

function looksProbeable(value: string): boolean {
  const text = value.trim();
  return /^https?:\/\//i.test(text) || /^[\w.-]+\.[a-z]{2,}/i.test(text);
}

export function SourcesPanel({ notify }: { notify: (m: string) => void }) {
  const [sources, setSources] = useState<Source[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [name, setName] = useState("");
  const [entryUrl, setEntryUrl] = useState("");
  const [kind, setKind] = useState<string>("auto");
  const [busy, setBusy] = useState(false);
  const [probing, setProbing] = useState(false);
  const [probe, setProbe] = useState<SourceProbeResult | null>(null);
  const [probeErr, setProbeErr] = useState<string | null>(null);
  const [reclassifying, setReclassifying] = useState(false);
  const [audit, setAudit] = useState<SourceMethodDrift[]>([]);
  const [pendingVerify, setPendingVerify] = useState<VerifyPendingSource[]>([]);
  const [verifyStatus, setVerifyStatus] = useState<VerifySessionState>({ status: "idle", targets: [] });

  const load = useCallback(async () => {
    try {
      setSources(await api.listSources());
    } catch (e) {
      notify(`加载店铺失败：${(e as Error).message}`);
    }
  }, [notify]);
  const loadAudit = useCallback(async () => {
    try {
      setAudit((await api.auditSources()).methodDrift);
    } catch {
      /* 后端未启动时静默 */
    }
  }, []);
  const pollJobs = async () => {
    try {
      setJobs(await api.listJobs());
    } catch {
      /* 后端未启动时静默 */
    }
  };
  const loadVerifyPending = useCallback(async () => {
    try {
      setPendingVerify(await api.listVerifyPending());
    } catch {
      /* 后端未启动时静默 */
    }
  }, []);

  const pollVerify = useCallback(async () => {
    try {
      const next = await api.verifyStatus();
      setVerifyStatus((prev) => {
        if (prev.status === "running" && next.status === "idle") {
          void load();
          void loadVerifyPending();
        }
        return next;
      });
    } catch {
      /* 后端未启动时静默 */
    }
  }, [load, loadVerifyPending]);

  useEffect(() => {
    load();
    loadAudit();
    pollJobs();
    loadVerifyPending();
    pollVerify();
    const t = setInterval(pollJobs, 2000);
    const v = setInterval(pollVerify, 2000);
    return () => {
      clearInterval(t);
      clearInterval(v);
    };
  }, [load, loadAudit, loadVerifyPending, pollVerify]);

  useEffect(function autoProbeWhenUrlChanges() {
    const url = entryUrl.trim();
    setProbe(null);
    setProbeErr(null);
    if (!looksProbeable(url)) return;
    const timer = window.setTimeout(async () => {
      setProbing(true);
      try {
        setProbe(await api.probeSource(url));
        setProbeErr(null);
      } catch (e) {
        setProbeErr((e as Error).message);
      } finally {
        setProbing(false);
      }
    }, 650);
    return () => window.clearTimeout(timer);
  }, [entryUrl]);

  const activeAll = useMemo(() => jobs.some((j) => j.job_type === "all" && (j.status === "pending" || j.status === "running")), [jobs]);
  const verifyRunning = verifyStatus.status === "running";
  const pendingVerifyCount = pendingVerify.length || sources.filter((s) => s.health_status === "manual_required").length;
  const activeBySource = useMemo(() => {
    const s = new Set<string>();
    for (const j of jobs) if (j.source_id && (j.status === "pending" || j.status === "running")) s.add(j.source_id);
    return s;
  }, [jobs]);

  const resetForm = () => {
    setName("");
    setEntryUrl("");
    setKind("auto");
    setProbe(null);
    setProbeErr(null);
  };

  const runProbeNow = async () => {
    if (!entryUrl.trim()) return notify("请填写入口 URL");
    setProbing(true);
    try {
      setProbe(await api.probeSource(entryUrl.trim()));
      setProbeErr(null);
    } catch (e) {
      setProbeErr((e as Error).message);
    } finally {
      setProbing(false);
    }
  };

  const addManual = async () => {
    if (!entryUrl.trim()) return notify("请填写入口 URL");
    setBusy(true);
    try {
      const manualName = name.trim();
      await api.addSource({
        name: manualName || undefined,
        nameSource: manualName ? "manual" : "auto",
        entryUrl: entryUrl.trim(),
        collectorKind: kind,
        collectionMethod: kind === "browser" ? "browser" : "http",
      });
      resetForm();
      await load();
      notify("已添加店铺");
    } catch (e) {
      const msg = (e as Error).message;
      notify(/已存在/.test(msg) ? "该链接已存在，未重复添加" : `添加失败：${msg}`);
    } finally {
      setBusy(false);
    }
  };

  const addFromProbe = async (mode: "confirm" | "browser" | "pending") => {
    if (!probe) return notify("请先完成识别");
    if (probe.duplicate) return notify("该链接已存在，未重复添加");
    const collectorKind = mode === "browser" ? "browser" : mode === "pending" ? "pending" : probe.kind;
    const evidence = probe.evidence;
    const manualName = name.trim();
    const autoName = probe.storeName || undefined;
    const shouldWriteProbeOffers = mode === "confirm" && probe.offers.length > 0;
    setBusy(true);
    try {
      const source = await api.addSource({
        name: manualName || autoName,
        nameSource: manualName ? "manual" : "auto",
        entryUrl: probe.normalized.entryUrl,
        baseUrl: probe.normalized.baseUrl,
        collectorKind,
        collectionMethod: collectorKind === "browser" ? "browser" : "http",
        kindEvidence: evidence,
        kindDetectedAt: new Date().toISOString(),
        enabled: mode !== "pending",
        notes: mode === "pending" ? evidence : null,
        offers: shouldWriteProbeOffers ? probe.offers : undefined,
      });
      resetForm();
      await load();
      if (mode === "browser") {
        await api.collect({ sourceId: source.id });
        pollJobs();
        notify("已添加并加入浏览器采集队列");
      } else {
        notify(mode === "pending" ? "已存为待办" : shouldWriteProbeOffers ? `已添加店铺，并入库 ${probe.offers.length} 个识别商品` : "已添加店铺");
      }
    } catch (e) {
      const msg = (e as Error).message;
      notify(/已存在/.test(msg) ? "该链接已存在，未重复添加" : `添加失败：${msg}`);
    } finally {
      setBusy(false);
    }
  };

  const reclassify = async () => {
    setReclassifying(true);
    try {
      const r = await api.reclassify();
      notify(`分类已重建：更新 ${r.updated} 条`);
    } catch (e) {
      notify(`重建分类失败：${(e as Error).message}`);
    } finally {
      setReclassifying(false);
    }
  };

  const collect = async (sourceId?: string) => {
    try {
      const r = await api.collect(sourceId ? { sourceId } : { all: true });
      notify(r.created ? "已加入采集队列" : r.note === "covered-by-active-all" ? "全量任务进行中，已覆盖" : "该任务已在队列中");
      pollJobs();
    } catch (e) {
      notify(`采集失败：${(e as Error).message}`);
    }
  };

  const startVerify = async () => {
    try {
      const state = await api.startVerify();
      setVerifyStatus(state);
      notify(state.targets.length ? "真实 Chrome 窗口已打开，请在其中完成验证" : "当前没有待验证站点");
    } catch (e) {
      notify(`启动验证失败：${(e as Error).message}`);
      pollVerify();
    }
  };

  const cancelVerify = async () => {
    try {
      setVerifyStatus(await api.cancelVerify());
      notify("已取消验证会话");
      await loadVerifyPending();
    } catch (e) {
      notify(`取消验证失败：${(e as Error).message}`);
    }
  };

  const toggle = async (s: Source) => {
    try {
      await api.updateSource(s.id, { enabled: !s.enabled });
      await load();
    } catch (e) {
      notify(`更新失败：${(e as Error).message}`);
    }
  };

  const toggleFavorite = async (s: Source) => {
    try {
      await api.setSourceFavorite(s.id, !s.favorite);
      await load();
      notify(s.favorite ? "已取消收藏店铺" : "已收藏店铺");
    } catch (e) {
      notify(`更新收藏失败：${(e as Error).message}`);
    }
  };

  const remove = async (s: Source) => {
    if (!window.confirm(`删除店铺「${s.name}」？其报价也会一并删除。`)) return;
    try {
      await api.deleteSource(s.id, true);
      await load();
      notify("已删除");
    } catch (e) {
      notify(`删除失败：${(e as Error).message}`);
    }
  };

  return (
    <>
      <div className="card">
        <div className="row" style={{ marginBottom: 10, justifyContent: "space-between" }}>
          <strong style={{ fontSize: 14 }}>店铺（{sources.length}）</strong>
          <div className="row">
            <button className="btn" onClick={startVerify} disabled={verifyRunning || pendingVerifyCount === 0}>
              {verifyRunning ? "验证窗口已打开" : `一键验证${pendingVerifyCount ? `（${pendingVerifyCount}）` : ""}`}
            </button>
            <button className="btn primary" onClick={() => collect()} disabled={activeAll}>
              {activeAll ? "全量采集中…" : "采集全部"}
            </button>
          </div>
        </div>
        {(pendingVerifyCount > 0 || verifyStatus.targets.length > 0) ? (
          <div className="verify-panel">
            <div className="row" style={{ justifyContent: "space-between" }}>
              <div className="row">
                <span className={`badge ${verifyRunning ? "b-warn" : pendingVerifyCount > 0 ? "b-warn" : "b-muted"}`}>
                  {verifyRunning ? "验证中" : pendingVerifyCount > 0 ? `${pendingVerifyCount} 个站点待人工验证` : "验证完成"}
                </span>
                <span className="muted">{verifyRunning ? "将打开一个真实 Chrome 窗口，请在其中完成验证；出现勾选框请手动点击。" : verifyStatus.message || "验证通过后会自动写库并恢复状态"}</span>
              </div>
              {verifyRunning ? <button className="btn danger" onClick={cancelVerify}>取消验证</button> : null}
            </div>
            {verifyStatus.targets.length > 0 ? (
              <div className="verify-list">
                {verifyStatus.targets.map((target) => {
                  const v = VERIFY_LABELS[target.status];
                  return (
                    <div className="verify-row" key={target.sourceId}>
                      <span className={`badge ${v.cls}`}>{v.label}</span>
                      <span className="verify-name">{target.name}</span>
                      <span className="muted verify-url">{target.url}</span>
                      <span className="muted">{target.offers != null ? `${target.offers} 条` : target.message || ""}</span>
                    </div>
                  );
                })}
              </div>
            ) : null}
          </div>
        ) : null}
        {audit.length > 0 ? (
          <div className="verify-panel" style={{ marginTop: 10 }}>
            <div className="row" style={{ justifyContent: "space-between" }}>
              <div className="row">
                <span className="badge b-warn">采集器巡检</span>
                <span className="muted">{audit.length} 个非浏览器店铺仍记录为 browser method，下次采集会自动校正。</span>
              </div>
            </div>
          </div>
        ) : null}
        <div className="form-grid">
          <input placeholder="店铺名称（可留空，自动识别品牌名）" value={name} onChange={(e) => setName(e.target.value)} />
          <input placeholder="入口 URL（必填），如 https://pay.ldxp.cn/shop/XXXX" value={entryUrl} onChange={(e) => setEntryUrl(e.target.value)} />
          <select value={kind} onChange={(e) => setKind(e.target.value)}>
            {COLLECTOR_KINDS.map((k) => <option key={k} value={k}>{kindLabel(k)}</option>)}
          </select>
          <button className="btn" onClick={runProbeNow} disabled={probing || !entryUrl.trim()}>{probing ? "识别中…" : "识别"}</button>
        </div>
        <div className="row" style={{ marginTop: 8 }}>
          <button className="btn" onClick={addManual} disabled={busy}>直接添加</button>
          <span className="muted">自动识别后可预览报价并确认入库；直接添加保留手动兜底。</span>
        </div>
        {(probing || probeErr || probe) ? (
          <div className="probe-box">
            {probing ? <div className="muted">正在识别店铺类型…</div> : null}
            {probeErr ? <div className="badge b-danger">识别失败：{probeErr}</div> : null}
            {probe ? (
              <>
                <div className="row" style={{ justifyContent: "space-between" }}>
                  <div className="row">
                    <span className={`badge ${probe.kind === "browser" || probe.kind === "pending" ? "b-warn" : "b-ok"}`}>{kindLabel(probe.kind)}</span>
                    <span className="muted">{probe.storeName || probe.normalized.entryUrl}</span>
                  </div>
                  {probe.duplicate ? <span className="badge b-warn">已存在：{probe.duplicate.name}</span> : null}
                </div>
                <div className="muted probe-evidence">{probe.evidence}</div>
                {probe.offers.length > 0 ? (
                  <div className="probe-preview">
                    {probe.offers.slice(0, 10).map((offer, index) => (
                      <div className="probe-offer" key={`${offer.url}-${index}`}>
                        <span>{offer.sourceTitle}</span>
                        <span className="muted">{offer.price === null ? "—" : `¥${offer.price}`}</span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="muted">暂无预览报价。</div>
                )}
                {probe.attempts.length > 0 ? (
                  <div className="probe-attempts">
                    {probe.attempts.map((a, index) => (
                      <span className={`badge ${a.ok ? "b-ok" : "b-muted"}`} key={`${a.step}-${index}`} title={a.message || ""}>
                        {a.step} · {a.ms}ms
                      </span>
                    ))}
                  </div>
                ) : null}
                <div className="row" style={{ marginTop: 10 }}>
                  {probe.kind !== "browser" && probe.kind !== "pending" ? (
                    <button className="btn primary" onClick={() => addFromProbe("confirm")} disabled={busy || Boolean(probe.duplicate)}>确认添加</button>
                  ) : null}
                  <button className="btn" onClick={() => addFromProbe("browser")} disabled={busy || Boolean(probe.duplicate)}>用浏览器试采</button>
                  <button className="btn" onClick={() => addFromProbe("pending")} disabled={busy || Boolean(probe.duplicate)}>存为待办</button>
                </div>
              </>
            ) : null}
          </div>
        ) : null}
      </div>

      <div className="card">
        {sources.length === 0 ? (
          <div className="empty">还没有店铺，先在上方添加一个。</div>
        ) : (
          <table>
            <thead>
              <tr><th>店铺 / 类型</th><th>入口</th><th>状态</th><th>上次成功</th><th style={{ textAlign: "right" }}>操作</th></tr>
            </thead>
            <tbody>
              {sources.map((s) => {
                const h = HEALTH[s.health_status] ?? HEALTH.unknown;
                const running = activeBySource.has(s.id) || activeAll;
                return (
                  <tr key={s.id}>
                    <td>
                      <div>{s.name}</div>
                      <div className="muted" title={s.kind_evidence || undefined}>
                        {kindLabel(s.collector_kind)}
                        {s.kind_detected_at ? ` · ${new Date(s.kind_detected_at).toLocaleString()}` : ""}
                      </div>
                    </td>
                    <td className="muted" style={{ maxWidth: 240, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.entry_url}</td>
                    <td>
                      <span className={`badge ${h.cls}`}>{s.enabled ? h.label : "已停用"}</span>
                      {s.last_error && <div className="muted" title={s.last_error} style={{ maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.last_error}</div>}
                    </td>
                    <td className="muted">{s.last_success_at ? new Date(s.last_success_at).toLocaleString() : "—"}</td>
                    <td>
                      <div className="row" style={{ justifyContent: "flex-end" }}>
                        <button className="btn star-btn" onClick={() => toggleFavorite(s)} title={s.favorite ? "取消收藏店铺" : "收藏店铺"}>
                          {s.favorite ? "★" : "☆"}
                        </button>
                        <button className="btn" onClick={() => collect(s.id)} disabled={running || !s.enabled} title="抓取商品；若失败会自动重新识别店铺类型并重试">{running ? "采集中…" : "采集"}</button>
                        <button className="btn" onClick={() => toggle(s)}>{s.enabled ? "停用" : "启用"}</button>
                        <button className="btn danger" onClick={() => remove(s)}>删除</button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      <div className="row" style={{ justifyContent: "flex-end", marginTop: 4 }}>
        <span className="muted" style={{ fontSize: 12 }}>维护</span>
        <button className="btn" onClick={reclassify} disabled={reclassifying} title="重新对存量报价套用分类目录。仅在调整分类目录后需要；日常采集已自动归类。">
          {reclassifying ? "重建分类中…" : "重建分类"}
        </button>
      </div>
    </>
  );
}
