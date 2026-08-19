import { useCallback, useEffect, useState } from "react";
import { SourcesPanel } from "./admin/SourcesPanel";
import { LogsPanel } from "./admin/LogsPanel";
import { FrontBrowse } from "./front/FrontBrowse";
import { ProductDetail } from "./front/ProductDetail";
import { FavoritesPage } from "./front/FavoritesPage";

type View = "front" | "admin";
type Tab = "sources" | "logs";
type Theme = "light" | "dark";

/** 初值取 index.html 里那段脚本已经写好的 data-theme，避免和它打架、闪一次。 */
function initialTheme(): Theme {
  return document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
}

export default function App() {
  const [view, setView] = useState<View>("front");
  const [tab, setTab] = useState<Tab>("sources");
  const [frontTab, setFrontTab] = useState<"browse" | "favorites">("browse");
  const [frontProduct, setFrontProduct] = useState<string | null>(null);
  const [sourceId, setSourceId] = useState<string | undefined>();
  const [sourceName, setSourceName] = useState<string | undefined>();
  const [toast, setToast] = useState<string | null>(null);
  const [theme, setTheme] = useState<Theme>(initialTheme);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    try { localStorage.setItem("theme", theme); } catch { /* 隐私模式下 localStorage 会抛，忽略即可 */ }
  }, [theme]);

  // 没手动选过就跟随系统切换（选过之后以本人选择为准）
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = (e: MediaQueryListEvent) => {
      let saved: string | null = null;
      try { saved = localStorage.getItem("theme"); } catch { /* 同上 */ }
      if (!saved) setTheme(e.matches ? "dark" : "light");
    };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

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
        <button
          className="btn theme-btn"
          title={theme === "dark" ? "切换到日间模式" : "切换到夜间模式"}
          aria-label={theme === "dark" ? "切换到日间模式" : "切换到夜间模式"}
          onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
        >
          {theme === "dark" ? "☀" : "☾"}
        </button>
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
