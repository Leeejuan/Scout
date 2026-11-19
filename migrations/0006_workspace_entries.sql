CREATE TABLE workspace_entries (
  owner TEXT NOT NULL,
  id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('judgment','topic')),
  content TEXT NOT NULL CHECK(json_valid(content)),
  created TEXT NOT NULL,
  updated TEXT NOT NULL,
  PRIMARY KEY(owner,id)
);
CREATE INDEX workspace_entries_recent ON workspace_entries(owner,updated DESC,id);
CREATE INDEX jobs_extract_doi ON jobs(json_extract(payload,'$.doi')) WHERE kind='extract';
