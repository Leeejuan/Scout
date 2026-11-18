ALTER TABLE reports ADD COLUMN delivery_channel TEXT NOT NULL DEFAULT 'telegram';

UPDATE reports SET delivery='skipped',delivery_updated=strftime('%Y-%m-%dT%H:%M:%fZ','now'),
  delivery_error='切换推送渠道时取消尚未发送的 Telegram 简报'
WHERE delivery='pending';

UPDATE reports SET delivery='uncertain',delivery_updated=strftime('%Y-%m-%dT%H:%M:%fZ','now'),
  delivery_error='切换推送渠道时 Telegram 发送结果未确认'
WHERE delivery='sending';

UPDATE jobs SET status='done',lease_until=NULL,lease_token=NULL,error=NULL
WHERE kind='telegram' AND status IN ('queued','running');
