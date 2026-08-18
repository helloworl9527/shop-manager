import { useEffect, useState } from "react";
import { api, type ProductOffer } from "../api";

const RANK: Record<number, { label: string; cls: string }> = {
  0: { label: "有货", cls: "b-ok" },
  1: { label: "少量", cls: "b-warn" },
  2: { label: "缺货", cls: "b-danger" },
  3: { label: "未知", cls: "b-muted" },
};

function freshnessMeta(verifiedAt: string | null): { text: string; stale: boolean } {
  if (!verifiedAt) return { text: "未知", stale: true };
  const ms = Date.now() - new Date(verifiedAt).getTime();
  if (!Number.isFinite(ms) || ms < 0) return { text: "刚刚", stale: false };
  const hours = Math.floor(ms / 3_600_000);
  if (hours < 1) return { text: "1 小时内", stale: false };
  if (hours < 48) return { text: `${hours} 小时前`, stale: false };
  return { text: `${Math.floor(hours / 24)} 天前`, stale: true };
}

export function ProductDetail({ canonicalId, onBack, notify }: { canonicalId: string; onBack: () => void; notify?: (m: string) => void }) {
  const [canonical, setCanonical] = useState<any>(null);
  const [offers, setOffers] = useState<ProductOffer[]>([]);
  const [favs, setFavs] = useState<Set<string>>(new Set());
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    Promise.all([api.getProductOffers(canonicalId), api.favoriteIds()])
      .then(([r, ids]) => { if (alive) { setCanonical(r.canonical); setOffers(r.offers); setFavs(new Set(ids)); setErr(null); } })
      .catch((e) => { if (alive) setErr((e as Error).message); });
    return () => { alive = false; };
  }, [canonicalId]);

  const toggleFav = async (offerId: string) => {
    const next = new Set(favs);
    try {
      if (favs.has(offerId)) {
        await api.removeFavorite(offerId);
        next.delete(offerId);
        notify?.("已取消收藏");
      } else {
        await api.addFavorite(offerId);
        next.add(offerId);
        notify?.("已收藏");
      }
      setFavs(next);
    } catch (e) {
      notify?.(`操作失败：${(e as Error).message}`);
    }
  };

  const toggleSourceFav = async (sourceId: string | null, current: boolean) => {
    if (!sourceId) return notify?.("该报价没有关联店铺");
    try {
      await api.setSourceFavorite(sourceId, !current);
      setOffers((rows) => rows.map((row) => row.sourceId === sourceId ? { ...row, sourceFavorite: !current } : row));
      notify?.(current ? "已取消收藏店铺" : "已收藏店铺");
    } catch (e) {
      notify?.(`店铺收藏失败：${(e as Error).message}`);
    }
  };

  const inStock = offers.filter((o) => o.availabilityRank <= 1);

  return (
    <>
      <div className="row" style={{ marginBottom: 12 }}>
        <button className="btn" onClick={onBack}>← 返回</button>
        <strong style={{ fontSize: 16 }}>{canonical?.display_name || canonicalId}</strong>
        {canonical?.spec && <span className="badge b-muted">{canonical.spec}</span>}
      </div>

      {err && <div className="card empty">加载失败：{err}</div>}

      <div className="card">
        <div className="muted" style={{ marginBottom: 8 }}>
          共 {offers.length} 条报价，{inStock.length} 条有货 · 按有货与价格排序
        </div>
        {offers.length === 0 ? (
          <div className="empty">暂无报价。</div>
        ) : (
          <table>
            <thead>
              <tr><th></th><th>店铺</th><th>商品标题</th><th>价格</th><th>库存</th><th>最近确认</th><th>状态</th><th style={{ textAlign: "right" }}>操作</th></tr>
            </thead>
            <tbody>
              {offers.map((o) => {
                const r = RANK[o.availabilityRank] ?? RANK[3];
                const faved = favs.has(o.id);
                const fresh = freshnessMeta(o.verifiedAt);
                return (
                  <tr key={o.id}>
                    <td>
                      <button className="star" onClick={() => toggleFav(o.id)} title={faved ? "取消收藏" : "收藏"} aria-label="收藏">
                        {faved ? "★" : "☆"}
                      </button>
                    </td>
                    <td>
                      <button
                        className="star"
                        onClick={() => toggleSourceFav(o.sourceId, o.sourceFavorite)}
                        title={o.sourceFavorite ? "取消收藏店铺" : "收藏店铺"}
                        aria-label="收藏店铺"
                      >
                        {o.sourceFavorite ? "★" : "☆"}
                      </button>
                      <span style={{ marginLeft: 6 }}>{o.sourceStoreName || o.sourceName}</span>
                    </td>
                    <td className="muted" style={{ maxWidth: 260, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={o.sourceTitle}>{o.sourceTitle}</td>
                    <td><strong>{o.price != null ? `¥${o.price}` : "—"}</strong></td>
                    <td className="muted">{o.stockText || (o.stockCount != null ? o.stockCount : "—")}</td>
                    <td>
                      <span className="muted">{fresh.text}</span>
                      {fresh.stale ? <span className="badge b-muted" style={{ marginLeft: 6 }}>待更新</span> : null}
                    </td>
                    <td><span className={`badge ${r.cls}`}>{r.label}</span></td>
                    <td style={{ textAlign: "right" }}>
                      {o.availabilityRank <= 1
                        ? <a className="btn primary" href={o.url} target="_blank" rel="noreferrer">购买 ↗</a>
                        : <span className="muted">—</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
