import { useEffect, useState } from "react";
import { api, type CrawlRun, type ProbeAttempt } from "../api";

const STATUS: Record<string, { label: string; cls: string }> = {
  success: { label: "成功", cls: "b-ok" },
  partial: { label: "部分", cls: "b-warn" },
  failed: { label: "失败", cls: "b-danger" },
};

interface RunDetails {
  resolvedKind?: string;
  evidence?: string | null;
  attempts?: ProbeAttempt[];
  fellBackToBrowser?: boolean;
}

function parseDetails(value: string): RunDetails {
  try {
    const parsed = JSON.parse(value || "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function LogsPanel() {
  const [runs, setRuns] = useState<CrawlRun[]>([]);
  const [err, setErr] = useState<string | null>(null);

  const load = async () => {
    try {
      setRuns(await api.listCrawlRuns(80));
      setErr(null);
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  useEffect(() => {
    load();
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, []);

  return (
    <div className="card">
      <div className="row" style={{ marginBottom: 10, justifyContent: "space-between" }}>
        <strong style={{ fontSize: 14 }}>采集日志</strong>
        <button className="btn" onClick={load}>刷新</button>
      </div>
      {err && <div className="empty">加载失败：{err}（后端是否已启动？）</div>}
      {!err && runs.length === 0 && <div className="empty">暂无采集记录。</div>}
      {runs.length > 0 && (
        <table>
          <thead>
            <tr><th>时间</th><th>店铺</th><th>方式</th><th>状态</th><th>写入/失败</th><th>信息</th></tr>
          </thead>
          <tbody>
            {runs.map((r) => {
              const s = STATUS[r.status] ?? { label: r.status, cls: "b-muted" };
              const details = parseDetails(r.details);
              const attempts = Array.isArray(details.attempts) ? details.attempts : [];
              const attemptText = attempts.map((a) => `${a.step}:${a.ok ? "ok" : "miss"} ${a.ms}ms`).join(" | ");
              return (
                <tr key={r.id}>
                  <td className="muted">{new Date(r.started_at).toLocaleString()}</td>
                  <td>{r.source_name || "—"}</td>
                  <td className="muted">{r.mode}</td>
                  <td><span className={`badge ${s.cls}`}>{s.label}</span></td>
                  <td className="muted">{r.success_count} / {r.failure_count}</td>
                  <td className="muted" style={{ maxWidth: 340 }} title={[r.message, details.evidence, attemptText].filter(Boolean).join("\n")}>
                    <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.message || details.evidence || ""}</div>
                    <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {details.resolvedKind ? `类型：${details.resolvedKind}` : ""}
                      {details.fellBackToBrowser ? " · 已回退浏览器" : ""}
                      {attempts.length ? ` · 探测 ${attempts.length} 步` : ""}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
