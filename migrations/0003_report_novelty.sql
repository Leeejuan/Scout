CREATE TABLE report_signals (
  signal TEXT PRIMARY KEY,
  period TEXT NOT NULL REFERENCES reports(period)
);
