import { useEffect, useMemo, useState } from "react";
import { api, type Favorite, type FavoriteStore } from "../api";

const UNCATEGORIZED = "未分类";

export function FavoritesPage({
  notify,
}: {
  notify?: (m: string) => void;
}) {
  const [items, setItems] = useState<Favorite[]>([]);
  const [stores, setStores] = useState<FavoriteStore[]>([]);
  const [categories, setCategories] = useState<string[]>([]);
  const [err, setErr] = useState<string | null>(null);

  const [adding, setAdding] = useState(false);
  const [url, setUrl] = useState("");
  const [category, setCategory] = useState("");
  const [busy, setBusy] = useState(false);

  const load = () => Promise.all([api.listFavorites(), api.listFavoriteStores()])
    .then(([favorites, favoriteStores]) => {
      setItems(favorites);
      setStores(favoriteStores.items);
      setCategories(favoriteStores.categories);
      setErr(null);
    })
    .catch((e) => setErr((e as Error).message));
  useEffect(() => { load(); }, []);

  const remove = async (offerId: string) => {
    try { await api.removeFavorite(offerId); await load(); notify?.("已移除收藏"); }
    catch (e) { notify?.(`移除失败：${(e as Error).message}`); }
  };

  // 分组展示：有分类的在前（按名排序），未分类兜底放最后
  const grouped = useMemo(() => {
    const map = new Map<string, FavoriteStore[]>();
    for (const s of stores) {
      const key = s.category ?? UNCATEGORIZED;
      const list = map.get(key);
      if (list) list.push(s);
      else map.set(key, [s]);
    }
    return [...map.entries()].sort((a, b) =>
      a[0] === UNCATEGORIZED ? 1 : b[0] === UNCATEGORIZED ? -1 : a[0].localeCompare(b[0], "zh"));
  }, [stores]);

  const addStore = async () => {
    const value = url.trim();
    if (!value) return;
    setBusy(true);
    try {
      const r = await api.addFavoriteStore({ url: value, category: category.trim() || undefined });
      await load();
      setUrl("");
      setAdding(false);
      const via = r.nameVia === "proxy" ? "（走代理取到店铺名）" : r.nameVia === "fallback" ? "（未能取到店铺名，已用链接兜底，可点名字改）" : "";
      notify?.(r.created ? `已收藏「${r.row.name}」${via}` : `已在收藏里：「${r.row.name}」`);
    } catch (e) {
      notify?.(`收藏失败：${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const rename = async (s: FavoriteStore) => {
    const next = window.prompt("店铺名称", s.name);
    if (next == null || !next.trim() || next.trim() === s.name) return;
    try { await api.updateFavoriteStore(s.id, { name: next.trim() }); await load(); notify?.("已改名"); }
    catch (e) { notify?.(`改名失败：${(e as Error).message}`); }
  };

  const recategorize = async (s: FavoriteStore) => {
    const next = window.prompt(`分类（留空表示${UNCATEGORIZED}）\n已有：${categories.join("、") || "无"}`, s.category ?? "");
    if (next == null) return;
    try { await api.updateFavoriteStore(s.id, { category: next.trim() || null }); await load(); notify?.("已更新分类"); }
    catch (e) { notify?.(`更新分类失败：${(e as Error).message}`); }
  };

  const removeStore = async (s: FavoriteStore) => {
    if (!window.confirm(`移除收藏「${s.name}」？${s.collected ? "\n这家同时是采集店铺，移除后后台的 ★ 也会取消（不影响采集）。" : ""}`)) return;
    try { await api.removeFavoriteStore(s.id); await load(); notify?.("已移除收藏店铺"); }
    catch (e) { notify?.(`移除失败：${(e as Error).message}`); }
  };

  return (
    <>
    <div className="card">
      <div className="row" style={{ marginBottom: 10, justifyContent: "space-between" }}>
        <strong style={{ fontSize: 14 }}>收藏店铺（{stores.length}）</strong>
        <div className="row">
          <span className="muted">点击店铺名打开链接 · ★ 表示同时是采集店铺</span>
          <button className="btn primary" onClick={() => setAdding((v) => !v)}>{adding ? "取消" : "+ 新增链接"}</button>
        </div>
      </div>

      {adding && (
        <div className="row" style={{ marginBottom: 12, gap: 8, flexWrap: "wrap" }}>
          <input
            style={{ flex: "2 1 320px" }}
            placeholder="店铺链接，如 https://pay.ldxp.cn/shop/pdxai"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !busy) void addStore(); }}
            autoFocus
          />
          <input
            style={{ flex: "1 1 160px" }}
            placeholder="分类（可留空）"
            list="fav-store-categories"
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !busy) void addStore(); }}
          />
          <datalist id="fav-store-categories">
            {categories.map((c) => <option key={c} value={c} />)}
          </datalist>
          <button className="btn primary" onClick={() => void addStore()} disabled={busy || !url.trim()}>
            {busy ? "识别店铺名…" : "收藏"}
          </button>
          <span className="muted" style={{ flexBasis: "100%" }}>只收藏链接、探测一次店铺名，不采集商品。</span>
        </div>
      )}

      {stores.length === 0 ? (
        <div className="empty">还没有收藏店铺。点「+ 新增链接」直接添加，或在后台给采集店铺点 ★。</div>
      ) : (
        grouped.map(([group, list]) => (
          <div key={group} style={{ marginBottom: 14 }}>
            <div className="muted" style={{ marginBottom: 6, fontSize: 12 }}>{group}（{list.length}）</div>
            <div className="source-fav-grid">
              {list.map((s) => (
                <div key={s.id} className="source-fav-card">
                  <a className="source-fav-title" href={s.url} target="_blank" rel="noreferrer">
                    {s.collected ? "★ " : ""}{s.name}
                  </a>
                  <span className="muted">{s.url}</span>
                  <div className="row" style={{ marginTop: 6, gap: 6 }}>
                    <button className="btn" onClick={() => void rename(s)}>改名</button>
                    <button className="btn" onClick={() => void recategorize(s)}>分类</button>
                    <button className="btn danger" onClick={() => void removeStore(s)}>移除</button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))
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
