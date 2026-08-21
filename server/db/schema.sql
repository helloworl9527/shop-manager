-- 店铺商品管理系统 — SQLite schema (M1)
-- 对应方案 v5 §4。注意：PRAGMA foreign_keys 由连接层 openDatabase() 在每个连接上启用。

-- 1) 标准品 / 分类
CREATE TABLE IF NOT EXISTS canonical_products (
  id           TEXT PRIMARY KEY,
  slug         TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  platform     TEXT NOT NULL,
  product_type TEXT NOT NULL,
  spec         TEXT NOT NULL DEFAULT '',
  summary      TEXT NOT NULL DEFAULT '',
  aliases      TEXT NOT NULL DEFAULT '[]',   -- JSON 数组
  is_active    INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

-- 2) 店铺
CREATE TABLE IF NOT EXISTS sources (
  id                        TEXT PRIMARY KEY,
  name                      TEXT NOT NULL,
  name_source               TEXT NOT NULL DEFAULT 'auto',
  base_url                  TEXT,
  entry_url                 TEXT NOT NULL,
  collection_method         TEXT NOT NULL DEFAULT 'manual',   -- manual/http/browser/public_json
  collector_kind            TEXT,
  kind_detected_at          TEXT,
  kind_evidence             TEXT,
  enabled                   INTEGER NOT NULL DEFAULT 1,
  notes                     TEXT,
  health_status             TEXT NOT NULL DEFAULT 'unknown',  -- unknown/healthy/retrying/partial/failing/disabled
  last_checked_at           TEXT,
  last_success_at           TEXT,
  consecutive_failures      INTEGER NOT NULL DEFAULT 0,
  last_error                TEXT,
  favorite                  INTEGER NOT NULL DEFAULT 0,
  favorited_at              TEXT,
  collector_lock_until      TEXT,
  collector_lock_owner      TEXT,
  collector_lock_started_at TEXT,
  created_at                TEXT NOT NULL,
  updated_at                TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sources_favorite_at ON sources(favorite, favorited_at DESC);

-- 3) 商品报价
CREATE TABLE IF NOT EXISTS raw_offers (
  id                             TEXT PRIMARY KEY,
  source_id                      TEXT REFERENCES sources(id) ON DELETE SET NULL,
  source_name                    TEXT NOT NULL,
  source_store_name              TEXT,
  source_title                   TEXT NOT NULL,
  source_offer_key               TEXT,                      -- 外部商品键(含 SKU/variant)
  url                            TEXT NOT NULL,
  url_canonical                  TEXT,                      -- 规范化购买URL
  price                          REAL,
  currency                       TEXT NOT NULL DEFAULT 'CNY',
  status                         TEXT NOT NULL DEFAULT 'unknown',          -- in_stock/low_stock/out_of_stock/unknown
  source_status                  TEXT NOT NULL DEFAULT 'unknown',
  effective_status               TEXT NOT NULL DEFAULT 'low_confidence',   -- available/unavailable/stale/low_confidence
  freshness_status               TEXT NOT NULL DEFAULT 'fresh',            -- fresh/expired
  availability_rank              INTEGER NOT NULL DEFAULT 3,               -- 0有货/1少量/2缺货/3未知或不可售（由 computeAvailabilityRank 计算）
  tags                           TEXT NOT NULL DEFAULT '[]',               -- JSON 数组
  stock_count                    INTEGER,
  stock_text                     TEXT,                                     -- 定性库存原文（如「非常多」）
  hidden                         INTEGER NOT NULL DEFAULT 0,
  shadowed                       INTEGER NOT NULL DEFAULT 0,  -- 1=同一商品链接被更新的另一个源采到，本行不对外展示（由 recomputeShadowedOffers 计算）
  canonical_product_id           TEXT REFERENCES canonical_products(id) ON DELETE SET NULL,  -- 自动分类
  manual_canonical_product_id    TEXT REFERENCES canonical_products(id) ON DELETE SET NULL,  -- 人工覆盖（优先）
  effective_canonical_product_id TEXT GENERATED ALWAYS AS (
                                   COALESCE(manual_canonical_product_id, canonical_product_id)
                                 ) STORED,
  search_group_id                TEXT GENERATED ALWAYS AS (
                                   CASE
                                     WHEN COALESCE(manual_canonical_product_id, canonical_product_id) IS NULL
                                       OR COALESCE(manual_canonical_product_id, canonical_product_id) = 'other-product'
                                     THEN 'offer:' || id
                                     ELSE COALESCE(manual_canonical_product_id, canonical_product_id)
                                   END
                                 ) STORED,
  category_slug                  TEXT,
  captured_at                    TEXT NOT NULL,
  source_updated_at              TEXT,
  last_seen_at                   TEXT NOT NULL,
  verified_at                    TEXT,
  expires_at                     TEXT,
  source_priority                INTEGER NOT NULL DEFAULT 50,
  confidence                     REAL NOT NULL DEFAULT 0.5,
  last_failed_at                 TEXT,
  failure_reason                 TEXT,
  created_at                     TEXT NOT NULL,
  updated_at                     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_offers_source     ON raw_offers(source_id);
CREATE INDEX IF NOT EXISTS idx_offers_effcanon   ON raw_offers(effective_canonical_product_id);
CREATE INDEX IF NOT EXISTS idx_offers_group      ON raw_offers(search_group_id);
CREATE INDEX IF NOT EXISTS idx_offers_status_exp ON raw_offers(status, expires_at);
CREATE INDEX IF NOT EXISTS idx_offers_urlcanon   ON raw_offers(url_canonical);
CREATE INDEX IF NOT EXISTS idx_offers_srckey     ON raw_offers(source_id, source_offer_key);
CREATE INDEX IF NOT EXISTS idx_offers_public_group_rank_price
  ON raw_offers(hidden, search_group_id, availability_rank, price);
CREATE INDEX IF NOT EXISTS idx_offers_public_category_group_rank_price
  ON raw_offers(hidden, category_slug, search_group_id, availability_rank, price);

-- 4) 采集日志
CREATE TABLE IF NOT EXISTS crawl_runs (
  id            TEXT PRIMARY KEY,
  source_id     TEXT REFERENCES sources(id) ON DELETE SET NULL,
  source_name   TEXT,
  mode          TEXT NOT NULL,                 -- http/browser/manual
  status        TEXT NOT NULL,                 -- success/partial/failed
  started_at    TEXT NOT NULL,
  finished_at   TEXT,
  success_count INTEGER NOT NULL DEFAULT 0,
  failure_count INTEGER NOT NULL DEFAULT 0,
  message       TEXT,
  details       TEXT NOT NULL DEFAULT '{}'     -- JSON: fullSnapshot/seenCount/anomaly/skippedSources
);

-- 5) 收藏（offer 级 + 快照 + 双重去重，对多 SKU 友好）
CREATE TABLE IF NOT EXISTS favorites (
  id                            INTEGER PRIMARY KEY AUTOINCREMENT,
  offer_id                      TEXT NOT NULL UNIQUE,
  url_canonical_snapshot        TEXT,
  source_offer_key_snapshot     TEXT,
  source_id_snapshot            TEXT,
  source_store_name_snapshot    TEXT,
  title_snapshot                TEXT,
  canonical_product_id_snapshot TEXT,
  price_snapshot                REAL,
  currency_snapshot             TEXT DEFAULT 'CNY',
  status_snapshot               TEXT,
  note                          TEXT,
  created_at                    TEXT NOT NULL,
  updated_at                    TEXT NOT NULL
);
-- 同 URL 不同 SKU 可分别收藏；无 SKU 键时退化为按 URL 唯一
CREATE UNIQUE INDEX IF NOT EXISTS uq_fav_url_key ON favorites(url_canonical_snapshot, source_offer_key_snapshot)
  WHERE url_canonical_snapshot IS NOT NULL AND source_offer_key_snapshot IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_fav_url_nokey ON favorites(url_canonical_snapshot)
  WHERE url_canonical_snapshot IS NOT NULL AND source_offer_key_snapshot IS NULL;

-- 6) 采集任务队列（DB 级防重）
CREATE TABLE IF NOT EXISTS collection_jobs (
  id           TEXT PRIMARY KEY,
  job_type     TEXT NOT NULL,                  -- all/source
  source_id    TEXT REFERENCES sources(id) ON DELETE SET NULL,
  source_name  TEXT,
  status       TEXT NOT NULL DEFAULT 'pending',-- pending/running/success/partial/failed/manual_required/cancelled
  priority     INTEGER NOT NULL DEFAULT 0,
  attempts     INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 1,
  requested_by TEXT,
  locked_by    TEXT,
  locked_until TEXT,
  started_at   TEXT,
  finished_at  TEXT,
  last_error   TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
-- 同一 source 处于 pending/running 时只能有一个任务
CREATE UNIQUE INDEX IF NOT EXISTS uq_jobs_active_source ON collection_jobs(source_id)
  WHERE source_id IS NOT NULL AND status IN ('pending','running');
-- 全量任务同时只允许一个在跑
CREATE UNIQUE INDEX IF NOT EXISTS uq_jobs_active_all ON collection_jobs(job_type)
  WHERE job_type = 'all' AND status IN ('pending','running');

-- 收藏的店铺链接。与 sources 分开：收藏只是"记住这个店铺入口"，不参与采集。
-- source_id 非空 = 这条是后台给采集店铺点 ★ 同步过来的（前台显示 ★ 标记）。
CREATE TABLE IF NOT EXISTS favorite_stores (
  id          TEXT PRIMARY KEY,
  url         TEXT NOT NULL UNIQUE,            -- 规范化后的店铺入口链接
  name        TEXT NOT NULL,
  name_source TEXT NOT NULL DEFAULT 'auto',    -- auto/manual：手动改过名就不再被自动覆盖
  category    TEXT,                            -- NULL = 未分类
  note        TEXT,
  source_id   TEXT REFERENCES sources(id) ON DELETE SET NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_fav_stores_category ON favorite_stores(category, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS uq_fav_stores_source ON favorite_stores(source_id) WHERE source_id IS NOT NULL;
