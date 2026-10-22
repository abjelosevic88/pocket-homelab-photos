-- Cloud accounts a person connected to index photos in place (Nextcloud, WebDAV, S3, Google Drive,
-- OneDrive, Dropbox). secret holds the sealed password / keys / OAuth token, never plain text.
CREATE TABLE cloud_accounts (
  id           INTEGER PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL,
  name         TEXT NOT NULL DEFAULT '',
  root         TEXT NOT NULL DEFAULT '',
  via          TEXT NOT NULL DEFAULT '',
  config       TEXT NOT NULL DEFAULT '{}',   -- non-secret fields (url, username, bucket, region…)
  secret       TEXT NOT NULL DEFAULT '',     -- sealed JSON
  login        TEXT NOT NULL DEFAULT '',
  status       TEXT NOT NULL DEFAULT 'idle',
  error        TEXT NOT NULL DEFAULT '',
  cursor       TEXT NOT NULL DEFAULT '',     -- provider change token (OneDrive delta link)
  last_scan_at TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX cloud_accounts_user ON cloud_accounts(user_id);

CREATE TABLE cloud_items (
  id                INTEGER PRIMARY KEY,
  account_id        INTEGER NOT NULL REFERENCES cloud_accounts(id) ON DELETE CASCADE,
  remote_id         TEXT NOT NULL,
  path              TEXT NOT NULL DEFAULT '',
  name              TEXT NOT NULL DEFAULT '',
  mime              TEXT NOT NULL DEFAULT '',
  size              INTEGER NOT NULL DEFAULT 0,
  etag              TEXT NOT NULL DEFAULT '',
  modified_at       TEXT NOT NULL DEFAULT '',
  taken_at          TEXT NOT NULL DEFAULT '',
  sort_at           TEXT NOT NULL DEFAULT '',  -- taken_at, else modified_at
  width             INTEGER NOT NULL DEFAULT 0,
  height            INTEGER NOT NULL DEFAULT 0,
  lat               REAL,
  lon               REAL,
  city              TEXT NOT NULL DEFAULT '',
  country           TEXT NOT NULL DEFAULT '',
  camera            TEXT NOT NULL DEFAULT '',
  video             INTEGER NOT NULL DEFAULT 0,
  duration_ms       INTEGER NOT NULL DEFAULT 0,
  web_url           TEXT NOT NULL DEFAULT '',
  thumb_ref         TEXT NOT NULL DEFAULT '',  -- provider thumbnail hint (Drive link, Nextcloud file id)
  indexed           INTEGER NOT NULL DEFAULT 0, -- metadata read for this etag
  geocoded          INTEGER NOT NULL DEFAULT 0,
  index_error       TEXT NOT NULL DEFAULT '',
  imported_asset_id TEXT NOT NULL DEFAULT '',
  import_status     TEXT NOT NULL DEFAULT '',
  seen_scan         INTEGER NOT NULL DEFAULT 0,
  UNIQUE (account_id, remote_id)
);
CREATE INDEX cloud_items_sort ON cloud_items(account_id, sort_at DESC, id DESC);
CREATE INDEX cloud_items_located ON cloud_items(account_id) WHERE lat IS NOT NULL;

-- Reverse-geocoded places, keyed by coordinates rounded to ~1 km.
CREATE TABLE geocache (
  key     TEXT PRIMARY KEY,
  city    TEXT NOT NULL DEFAULT '',
  country TEXT NOT NULL DEFAULT ''
);
