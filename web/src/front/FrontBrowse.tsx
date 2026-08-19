import { useEffect, useRef, useState } from "react";
import { api, PLATFORMS, type ProductCard } from "../api";

// data 与「产生它的查询参数」绑定，渲染只依据 appliedQ（而非实时 q），
// 避免清空搜索/切换平台时用旧数据按新模式渲染导致的错乱。
interface DataState {
  items: ProductCard[];
  total: number;
  pageSize: number;
  appliedQ: string; // 该批数据对应的关键字（""=浏览模式）
}

function freshnessMeta(verifiedAt: string | null): { text: string; stale: boolean } {
  if (!verifiedAt) return { text: "最近确认：未知", stale: true };
  const ms = Date.now() - new Date(verifiedAt).getTime();
  if (!Number.isFinite(ms) || ms < 0) return { text: "最近确认：刚刚", stale: false };
  const hours = Math.floor(ms / 3_600_000);
  if (hours < 1) return { text: "最近确认：1 小时内", stale: false };
  if (hours < 48) return { text: `最近确认：${hours} 小时前`, stale: false };
  const days = Math.floor(hours / 24);
  return { text: `最近确认：${days} 天前`, stale: true };
}

export function FrontBrowse({
  onOpen,
  sourceId,
  sourceName,
  onClearSource,
}: {
  onOpen: (canonicalId: string) => void;
  sourceId?: string;
  sourceName?: string;
  onClearSource: () => void;
}) {
  const [platform, setPlatform] = useState<string>("");
  const [input, setInput] = useState("");
  const [q, setQ] = useState("");
  // 默认按价格排：这是比价工具，打开就该先看到最便宜的。点「相关度」可切回按匹配度排。
  const [sort, setSort] = useState<"relevance" | "price">("price");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<DataState>({ items: [], total: 0, pageSize: 24, appliedQ: "" });
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const reqSeq = useRef(0); // 单调请求序号：只有最新一次请求的响应会被采用

  // 搜索输入防抖
  useEffect(() => {
    const t = setTimeout(() => { setQ(input.trim()); setPage(1); }, 350);
    return () => clearTimeout(t);
  }, [input]);

  useEffect(() => {
    const myId = ++reqSeq.current;
    const forQ = q; // 快照：本次请求对应的关键字
    setLoading(true);
    api.search({
      platform: platform || undefined,
      q: forQ || undefined,
      sort,
      page,
      pageSize: 24,
      sourceId,
    })
      .then((r) => {
        if (reqSeq.current !== myId) return; // 已被更新的请求取代 → 丢弃
        setData({ items: r.items, total: r.total, pageSize: r.pageSize, appliedQ: forQ });
        setErr(null);
      })
      .catch((e) => { if (reqSeq.current === myId) setErr((e as Error).message); })
      .finally(() => { if (reqSeq.current === myId) setLoading(false); });
  }, [platform, q, sort, page, sourceId]);

  const totalPages = Math.max(1, Math.ceil(data.total / data.pageSize));

  return (
    <>
      <div className="card">
        <div className="row" style={{ gap: 10 }}>
          <input style={{ flex: 1, minWidth: 220 }} placeholder="搜索商品，如 plus / claude / 邮箱…" value={input} onChange={(e) => setInput(e.target.value)} />
          <div className="row" style={{ gap: 4 }}>
            <span className="muted">排序</span>
            <button className={`chip ${sort === "relevance" ? "on" : ""}`} onClick={() => { setSort("relevance"); setPage(1); }}>相关度</button>
            <button className={`chip ${sort === "price" ? "on" : ""}`} onClick={() => { setSort("price"); setPage(1); }}>价格</button>
          </div>
        </div>
        <div className="chips">
          {sourceId ? (
            <button
              className="chip on"
              onClick={() => {
                onClearSource();
                setPage(1);
              }}
              title="清除店铺筛选"
            >
              店铺：{sourceName || sourceId} ×
            </button>
          ) : null}
          <button className={`chip ${platform === "" ? "on" : ""}`} onClick={() => { setPlatform(""); setPage(1); }}>全部</button>
          {PLATFORMS.map((p) => (
            <button key={p} className={`chip ${platform === p ? "on" : ""}`} onClick={() => { setPlatform(p); setPage(1); }}>{p}</button>
          ))}
        </div>
      </div>

      {err && <div className="card empty">加载失败：{err}（后端是否已启动？）</div>}
      {!err && !loading && data.items.length === 0 && (
        <div className="card empty">
          {data.appliedQ ? `没有找到与「${data.appliedQ}」匹配的商品。` : "没有匹配的商品。先在后台添加店铺并采集。"}
        </div>
      )}

      <div className="pgrid">
        {data.items.map((c) => {
          const isSearch = Boolean(data.appliedQ);
          const inStock = isSearch ? c.resultAvailabilityRank <= 1 : c.inStockCount > 0;
          const title = isSearch ? (c.resultTitle || c.matchedTitle || c.representativeTitle || c.displayName) : c.displayName;
          const price = isSearch ? c.resultPrice : c.lowestPrice;
          const meta = isSearch && title !== c.displayName
            ? `${c.platform}${c.spec ? ` · ${c.spec}` : ""} · ${c.displayName}`
            : `${c.platform}${c.spec ? ` · ${c.spec}` : ""}`;
          const footer = isSearch
            ? `${c.resultStore || "未知店铺"} · 同类 ${c.storeCount} 家在售${c.canonicalId ? " · 点击比价" : ""}`
            : `${c.storeCount} 家在售${c.canonicalId ? " · 点击比价" : ""}`;
          const buyUrl = isSearch ? c.resultUrl : c.representativeUrl;
          const fresh = freshnessMeta(c.resultVerifiedAt);
          return (
            <div key={isSearch ? c.resultOfferId : c.groupId} className="pcard" onClick={() => c.canonicalId && onOpen(c.canonicalId)} style={{ cursor: c.canonicalId ? "pointer" : "default" }}>
              <div className="muted">{meta}</div>
              <div className="pname" title={title}>{title}</div>
              <div className="row" style={{ justifyContent: "space-between", marginTop: 6 }}>
                <span className="price">¥{price} <span className="muted">{isSearch ? "" : "起"}</span></span>
                <span className={`badge ${inStock ? "b-ok" : "b-danger"}`}>{inStock ? "有货" : "缺货"}</span>
              </div>
              <div className="row" style={{ marginTop: 8, gap: 6 }}>
                <span className="muted">{fresh.text}</span>
                {fresh.stale ? <span className="badge b-muted">待更新</span> : null}
              </div>
              <div className="pcard-actions">
                <div className="muted pcard-foot">{footer}</div>
                {buyUrl ? (
                  <a
                    className="buy-btn"
                    href={buyUrl}
                    target="_blank"
                    rel="noreferrer"
                    onClick={(e) => e.stopPropagation()}
                  >
                    购买
                  </a>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>

      {data.total > data.pageSize && (
        <div className="row" style={{ justifyContent: "center", marginTop: 14, gap: 6 }}>
          <button className="btn" disabled={page <= 1} onClick={() => setPage(page - 1)}>上一页</button>
          <span className="muted">第 {page} / {totalPages} 页 · 共 {data.total} 件</span>
          <button className="btn" disabled={page >= totalPages} onClick={() => setPage(page + 1)}>下一页</button>
        </div>
      )}
    </>
  );
}
