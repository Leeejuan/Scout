CREATE TABLE journals (
  issn TEXT PRIMARY KEY, name TEXT NOT NULL, fields TEXT NOT NULL, policy_url TEXT NOT NULL,
  publisher_host TEXT, tier TEXT NOT NULL CHECK(tier IN ('pilot','expanded')), verified_on TEXT NOT NULL
);
CREATE TABLE papers (
  doi TEXT PRIMARY KEY, issn TEXT NOT NULL REFERENCES journals(issn), title TEXT NOT NULL,
  published TEXT NOT NULL, publisher_url TEXT NOT NULL, crossref_url TEXT NOT NULL,
  authors TEXT NOT NULL DEFAULT '[]', citation TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','included','excluded')),
  subtype TEXT, screening_url TEXT, screening_reason TEXT, screening_reviewer TEXT,
  abstract TEXT, abstract_source TEXT, openalex_id TEXT UNIQUE, openalex_checked TEXT,
  oa_locations TEXT NOT NULL DEFAULT '[]', refs TEXT NOT NULL DEFAULT '[]',
  cited_count INTEGER, tags TEXT NOT NULL DEFAULT '[]', regions TEXT NOT NULL DEFAULT '[]',
  evidence_state TEXT NOT NULL DEFAULT 'record' CHECK(evidence_state IN ('record','abstract','fulltext')),
  evidence_updated TEXT, first_seen TEXT NOT NULL, last_verified TEXT NOT NULL
);
CREATE INDEX papers_library ON papers(status,published DESC,doi);
CREATE INDEX papers_changes ON papers(status,evidence_updated DESC,doi);
CREATE TABLE documents (
  doi TEXT PRIMARY KEY REFERENCES papers(doi), source TEXT NOT NULL, format TEXT NOT NULL,
  coverage TEXT NOT NULL CHECK(coverage IN ('body','excerpt')), imported TEXT NOT NULL
);
CREATE TABLE passages (
  doi TEXT NOT NULL REFERENCES documents(doi) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL, locator TEXT NOT NULL, content TEXT NOT NULL,
  PRIMARY KEY(doi,ordinal)
);
CREATE TABLE judgments (
  doi TEXT NOT NULL REFERENCES papers(doi), field TEXT NOT NULL, value TEXT NOT NULL,
  quote TEXT NOT NULL, locator TEXT NOT NULL, source TEXT NOT NULL,
  level TEXT NOT NULL CHECK(level IN ('abstract','fulltext')), origin TEXT NOT NULL CHECK(origin IN ('author','inferred')),
  reviewed INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(doi,field,locator,quote,value)
);
CREATE TABLE searches (
  id TEXT PRIMARY KEY, mode TEXT NOT NULL, started TEXT NOT NULL, lower_date TEXT NOT NULL,
  upper_date TEXT NOT NULL, journals TEXT NOT NULL
);
CREATE TABLE search_slices (
  search_id TEXT NOT NULL REFERENCES searches(id), issn TEXT NOT NULL REFERENCES journals(issn),
  lower_date TEXT NOT NULL, upper_date TEXT NOT NULL, cursor TEXT NOT NULL DEFAULT '*',
  pages INTEGER NOT NULL DEFAULT 0, returned INTEGER NOT NULL DEFAULT 0, omitted INTEGER NOT NULL DEFAULT 0,
  total_expected INTEGER, omissions TEXT NOT NULL DEFAULT '{}', error TEXT,
  restarts INTEGER NOT NULL DEFAULT 0, done INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(search_id,issn,lower_date)
);
CREATE TABLE jobs (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, payload TEXT NOT NULL, priority INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','done','dead')),
  attempts INTEGER NOT NULL DEFAULT 0, due INTEGER NOT NULL, lease_until INTEGER, lease_token TEXT, error TEXT
);
CREATE INDEX jobs_ready ON jobs(status,priority,due);
CREATE TABLE job_events (
  id INTEGER PRIMARY KEY, job_id TEXT NOT NULL, at TEXT NOT NULL,
  outcome TEXT NOT NULL, detail TEXT, rows_read INTEGER, rows_written INTEGER, subrequests INTEGER
);
CREATE TABLE ai_budget (
  utc_day TEXT PRIMARY KEY, neurons INTEGER NOT NULL, calls INTEGER NOT NULL
);
CREATE TABLE reports (
  period TEXT PRIMARY KEY, window_start TEXT NOT NULL, window_end TEXT NOT NULL,
  generated TEXT NOT NULL, content TEXT NOT NULL, digest TEXT,
  delivery TEXT NOT NULL CHECK(delivery IN ('skipped','pending','sending','sent','uncertain','failed')),
  delivery_updated TEXT, telegram_id TEXT, delivery_error TEXT
);
CREATE TABLE topics (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, content TEXT NOT NULL, signature TEXT NOT NULL UNIQUE,
  created TEXT NOT NULL, updated TEXT NOT NULL, period TEXT REFERENCES reports(period),
  status TEXT NOT NULL DEFAULT 'candidate' CHECK(status IN ('candidate','saved','archived'))
);
CREATE TABLE zotero_sync (
  doi TEXT PRIMARY KEY REFERENCES papers(doi), item_key TEXT, note_key TEXT,
  status TEXT NOT NULL DEFAULT 'queued', updated TEXT NOT NULL, error TEXT
);
CREATE TABLE runtime_lock (name TEXT PRIMARY KEY, token TEXT NOT NULL, expires INTEGER NOT NULL);
CREATE INDEX search_slices_status ON search_slices(search_id,done);
CREATE INDEX job_events_recent ON job_events(at DESC);
CREATE INDEX papers_journal ON papers(issn,status,published);
CREATE TABLE oa_budget (utc_day TEXT PRIMARY KEY, downloads INTEGER NOT NULL);
