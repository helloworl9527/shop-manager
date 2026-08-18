import { useEffect, useState } from "react";
import { api, type Favorite, type FavoriteSourceSummary } from "../api";

export function FavoritesPage({
  notify,
}: {
  notify?: (m: string) => void;
}) {
  const [items, setItems] = useState<Favorite[]>([]);
  const [sources, setSources] = useState<FavoriteSourceSummary[]>([]);
  const [err, setErr] = useState<string | null>(null);

  const load = () => Promise.all([api.listFavorites(), api.listFavoriteSources()])
    .then(([favorites, favoriteSources]) => {
      setItems(favorites);
      setSources(favoriteSources);
      setErr(null);
    })
    .catch((e) => setErr((e as Error).message));
  useEffect(() => { load(); }, []);

  const remove = async (offerId: string) => {
    try { await api.removeFavorite(offerId); await load(); notify?.("已移除收藏"); }
    catch (e) { notify?.(`移除失败：${(e as Error).message}`); }
  };

  return (
    <>
    <div className="card">
      <div className="row" style={{ marginBottom: 10, justifyContent: "space-between" }}>
        <strong style={{ fontSize: 14 }}>收藏店铺（{sources.length}）</strong>
        <span className="muted">点击店铺直接打开店铺链接</span>
      </div>
      {sources.length === 0 ? (
        <div className="empty">还没有收藏店铺。</div>
      ) : (
        <div className="source-fav-grid">
          {sources.map((s) => (
            <a key={s.id} className="source-fav-card" href={s.entry_url} target="_blank" rel="noreferrer">
              <span className="source-fav-title">★ {s.name}</span>
              <span className="muted">{s.entry_url}</span>
            </a>
          ))}
        </div>
      )}
    </div>

    <div className="card">
      <div className="row" style={{ marginBottom: 10, justifyContent: "space-between" }}>
        <strong style={{ fontSize: 14 }}>我的收藏（{items.length}）</strong>
        <span className="muted">已存快照，商品下架也能回看</span>
      </div>
      {err && <div className="empty">加载失败：{err}</div>}
      {!err && items.length === 0 && <div className="empty">还没有收藏。在商品详情里点 ☆ 收藏。</div>}
      {items.length > 0 && (
        <table>
          <thead>
            <tr><th>商品</th><th>店铺</th><th>收藏价</th><th>现价 / 状态</th><th style={{ textAlign: "right" }}>操作</th></tr>
          </thead>
          <tbody>
            {items.map((f) => (
              <tr key={f.id}>
                <td style={{ maxWidth: 260, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={f.title}>{f.title}</td>
                <td className="muted">{f.store || "—"}</td>
                <td className="muted">{f.priceSnapshot != null ? `¥${f.priceSnapshot}` : "—"}</td>
                <td>
                  {f.live
                    ? <span><strong>{f.currentPrice != null ? `¥${f.currentPrice}` : "—"}</strong> <span className={`badge ${f.currentAvailabilityRank != null && f.currentAvailabilityRank <= 1 ? "b-ok" : "b-danger"}`}>{f.currentAvailabilityRank != null && f.currentAvailabilityRank <= 1 ? "有货" : "缺货"}</span></span>
                    : <span className="badge b-muted">已下架</span>}
                </td>
                <td style={{ textAlign: "right" }}>
                  <div className="row" style={{ justifyContent: "flex-end" }}>
                    {f.live && f.url && <a className="btn primary" href={f.url} target="_blank" rel="noreferrer">跳转 ↗</a>}
                    <button className="btn danger" onClick={() => remove(f.offerId)}>移除</button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
    </>
  );
}
