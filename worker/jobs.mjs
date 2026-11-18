import { Problem, parse, service } from './core.mjs';
import { discover, enrich, fulltext, lookup } from './collection.mjs';
import { extract } from './extraction.mjs';
import { generateReport, schedule } from './reports.mjs';
import { sendFeishuReport } from './feishu.mjs';
import { zotero } from './zotero.mjs';

const handlers = {
  lookup: (s, job, now) => lookup(s, job.payload.doi, now),
  discover: (s, job, now) => discover(s, job.payload, now),
  enrich: (s, job, now) => enrich(s, job.payload, now),
  fulltext: (s, job, now) => fulltext(s, job.payload, now),
  extract, report: (s, job, now) => generateReport(s, job.payload, now),
  feishu: (s, job, now) => sendFeishuReport(s, job.payload, now),
  zotero: (s, job, now) => zotero(s, job.payload, now)
};

export async function tick(env, now = new Date()) {
  const s = service(env);
  const started = Date.now();
  const token = crypto.randomUUID();
  const locked = await s.first(`INSERT INTO runtime_lock(name,token,expires) VALUES ('tick',?,?)
    ON CONFLICT(name) DO UPDATE SET token=excluded.token,expires=excluded.expires WHERE runtime_lock.expires<=?
    RETURNING token`, token, started + 180000, started);
  if (!locked) return { outcome: 'busy' };
  let summary;
  try {
    await s.run(`UPDATE reports SET delivery='uncertain',delivery_error='发送中断，等待人工核对',delivery_updated=?
      WHERE delivery='sending' AND delivery_updated<?`, now.toISOString(), new Date(started - 180000).toISOString());
    await schedule(s, now);
    const row = await s.first(`UPDATE jobs SET status='running',lease_token=?,lease_until=?,attempts=attempts+1
      WHERE id=(SELECT id FROM jobs WHERE (status='queued' AND due<=?) OR (status='running' AND lease_until<=?)
      ORDER BY priority,due,id LIMIT 1) RETURNING *`, token, started + 180000, now.valueOf(), started);
    if (!row) return { outcome: 'idle', ...s.usage };
    const job = { ...row, payload: parse(row.payload, {}) };
    let result;
    let error = null;
    try {
      const handler = handlers[job.kind];
      if (!handler) throw new Problem(422, '未知任务');
      result = await handler(s, job, now);
    } catch (caught) {
      error = caught instanceof Problem ? caught.message : '内部任务错误';
      if (!(caught instanceof Problem)) console.error('Scout task error', job.kind, String(caught?.message ?? '').slice(0, 500));
      const transient = !(caught instanceof Problem) || [409, 412, 425, 429, 500, 502, 503, 504].includes(caught.status);
      result = transient && job.attempts < 5
        ? { retry: now.valueOf() + Math.max(caught.retryAfter ?? 0, 600000 * 2 ** (job.attempts - 1)) }
        : { dead: true };
    }
    const continuation = result.next !== undefined;
    const deferred = result.retry != null;
    const status = result.dead ? 'dead' : continuation || deferred ? 'queued' : 'done';
    const outcome = error ? status === 'dead' ? 'failed' : 'retry' : continuation ? 'progress' : deferred ? 'deferred' : 'done';
    const { read, written, external, queries } = s.usage;
    const statements = [
      s.stmt(`UPDATE jobs SET status=?,payload=?,due=?,attempts=?,lease_token=NULL,lease_until=NULL,error=?
        WHERE id=? AND lease_token=?`, status, JSON.stringify(result.next ?? job.payload), result.retry ?? now.valueOf(),
        error ? job.attempts : 0, error, job.id, token),
      s.stmt(`INSERT INTO job_events(job_id,at,outcome,detail,rows_read,rows_written,subrequests)
        VALUES (?,?,?,?,?,?,?)`, job.id, now.toISOString(), outcome, error ?? result.detail ?? null, read, written, queries + external)
    ];
    if (job.kind === 'zotero' && error) statements.push(s.stmt('UPDATE zotero_sync SET status=?,updated=?,error=? WHERE doi=?',
      result.dead ? 'failed' : 'retry', now.toISOString(), error, job.payload.doi));
    if (job.kind === 'feishu' && result.dead) statements.push(s.stmt(`UPDATE reports SET delivery='failed',delivery_updated=?,
      delivery_error=? WHERE period=? AND delivery_channel='feishu' AND delivery='pending'`, now.toISOString(), error, job.payload.period));
    await s.batch(statements);
    summary = { kind: job.kind, outcome, rowsRead: s.usage.read, rowsWritten: s.usage.written,
      external: s.usage.external, d1Statements: s.usage.queries + 1, elapsedMs: Date.now() - started };
    return summary;
  } finally {
    await s.run('DELETE FROM runtime_lock WHERE name=? AND token=?', 'tick', token);
    if (summary) console.log(JSON.stringify({ event: 'scout_tick', ...summary }));
  }
}
