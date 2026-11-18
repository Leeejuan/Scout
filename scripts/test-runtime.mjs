import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { convertV4MiniflareOptions, Miniflare } from 'miniflare';

const root = fileURLToPath(new URL('../', import.meta.url));
export const testToken = 'scout-local-test-token-0123456789abcdef';

export async function runtime({ http, bindings = {}, inspector = false } = {}) {
  const modules = ['test/worker-harness.mjs', ...(await readdir(root + 'worker')).filter(name => name.endsWith('.mjs')).map(name => 'worker/' + name)]
    .map(path => ({ type: 'ESModule', path: root + path }));
  const mf = new Miniflare(convertV4MiniflareOptions({
    ...(inspector ? { inspectorPort: 0 } : {}),
    cf: false, telemetry: { enabled: false },
    workers: [{
      name: 'scout-test', modules, modulesRoot: root, compatibilityDate: '2026-01-01',
      d1Databases: { SCOUT_DB: 'scout-test' }, ...(http ? { outboundService: http } : {}),
      bindings: { SCOUT_API_TOKEN: testToken, SCOUT_AI_DAILY_NEURONS: '6000', ...bindings }
    }]
  }));
  let db;
  try {
    db = await mf.getD1Database('SCOUT_DB');
    const dir = new URL('../migrations/', import.meta.url);
    for (const file of (await readdir(dir)).filter(name => name.endsWith('.sql')).sort()) {
      const sql = await readFile(new URL(file, dir), 'utf8');
      await db.batch(sql.split(';').map(line => line.trim()).filter(Boolean).map(line => db.prepare(line)));
    }
  } catch (error) {
    await mf.dispose();
    throw error;
  }
  const request = (path, data, token = testToken) => mf.dispatchFetch('http://scout.local' + path, {
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    ...(data === undefined ? {} : { method: 'POST', body: JSON.stringify(data) })
  });
  const tick = async now => (await request('/test/tick' + (now ? '?now=' + encodeURIComponent(now) : ''))).json();
  return { mf, db, request, tick, close: () => mf.dispose() };
}
