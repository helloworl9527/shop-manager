import { useCallback, useState } from "react";
import { SourcesPanel } from "./admin/SourcesPanel";
import { LogsPanel } from "./admin/LogsPanel";
import { FrontBrowse } from "./front/FrontBrowse";
import { ProductDetail } from "./front/ProductDetail";
import { FavoritesPage } from "./front/FavoritesPage";

type View = "front" | "admin";
type Tab = "sources" | "logs";

export default function App() {
  const [view, setView] = useState<View>("front");
  const [tab, setTab] = useState<Tab>("sources");
  const [frontTab, setFrontTab] = useState<"browse" | "favorites">("browse");
  const [frontProduct, setFrontProduct] = useState<string | null>(null);
  const [sourceId, setSourceId] = useState<string | undefined>();
  const [sourceName, setSourceName] = useState<string | undefined>();
  const [toast, setToast] = useState<string | null>(null);

  const notify = useCallback((msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast(null), 2500);
  }, []);

  return (
    <div className="app">
      <div className="topbar">
        <h1>店铺商品管理</h1>
        <span className="badge b-muted">{view === "admin" ? "后台" : "前台"}</span>
        <span className="spacer" />
        <button className="btn primary" onClick={() => setView(view === "admin" ? "front" : "admin")}>
          {view === "admin" ? "前台预览" : "进入后台"}
        </button>
      </div>

      {view === "admin" ? (
        <>
          <div className="tabs">
            <button className={`btn tab ${tab === "sources" ? "on" : ""}`} onClick={() => setTab("sources")}>店铺管理</button>
            <button className={`btn tab ${tab === "logs" ? "on" : ""}`} onClick={() => setTab("logs")}>采集日志</button>
          </div>
          {tab === "sources" ? <SourcesPanel notify={notify} /> : <LogsPanel />}
        </>
      ) : frontProduct ? (
        <ProductDetail canonicalId={frontProduct} onBack={() => setFrontProduct(null)} notify={notify} />
      ) : (
        <>
          <div className="tabs">
            <button className={`btn tab ${frontTab === "browse" ? "on" : ""}`} onClick={() => setFrontTab("browse")}>浏览</button>
            <button className={`btn tab ${frontTab === "favorites" ? "on" : ""}`} onClick={() => setFrontTab("favorites")}>我的收藏</button>
          </div>
          {frontTab === "browse" ? (
            <FrontBrowse
              onOpen={(id) => setFrontProduct(id)}
              sourceId={sourceId}
              sourceName={sourceName}
              onClearSource={() => {
                setSourceId(undefined);
                setSourceName(undefined);
              }}
            />
          ) : (
            <FavoritesPage notify={notify} />
          )}
        </>
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
