import "./load-env";
import { openDatabase } from "./db/connection";
import { defaultDbPath } from "./db/init";
import { targetFromSource, type SourceRow } from "./db/repo";
import { collectShopApi } from "./collectors/shopApi";
import { collectorFor, detectCollector } from "./collectors";
import { httpClient } from "./core/http";

const db = openDatabase(defaultDbPath(), { readonly: true });
const allSources = db.prepare(
  `SELECT id, name, name_source, base_url, entry_url, collection_method, collector_kind,
          kind_detected_at, kind_evidence, notes, enabled, favorite, favorited_at,
          consecutive_failures, health_status
   FROM sources
   WHERE collector_kind='browser'
   ORDER BY created_at`,
).all() as SourceRow[];
db.close();
const requestedIds = new Set(
  String(process.env.DIAG_SOURCE_IDS ?? "").split(",").map((id) => id.trim()).filter(Boolean),
);
const sources = requestedIds.size ? allSources.filter((source) => requestedIds.has(source.id)) : allSources;
const delayMs = Math.max(0, Number(process.env.DIAG_DELAY_MS ?? 0) || 0);

for (const source of sources) {
  if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
  const target = targetFromSource(source);
  const started = Date.now();
  let probeKind = "unknown";
  let offers = 0;
  let error = "";

  try {
    if (/\/(shop|item)\/[^/?#]+/.test(target.sourceUrl)) {
      probeKind = "shopApi";
      offers = (await collectShopApi(target, httpClient)).length;
    } else {
      const detected = await detectCollector(target, httpClient);
      probeKind = detected.kind;
      let found = detected.offers ?? [];
      if (!found.length && !["browser", "pending", "unsupported", "auto"].includes(detected.kind)) {
        found = await collectorFor(detected.kind, target.sourceUrl)(target, httpClient);
      }
      offers = found.length;
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  console.log(JSON.stringify({
    id: source.id,
    enabled: Boolean(source.enabled),
    host: new URL(source.entry_url).hostname,
    probeKind,
    offers,
    ms: Date.now() - started,
    error,
  }));
}
