import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { runtime, testToken } from './test-runtime.mjs';
import { isolateProfiler } from './cpu-profile.mjs';

const doi = '10.1093/jcmc/zmaf025';
const publisherSource = 'https://academic.oup.com/jcmc/article/31/1/zmaf025/8456523';
const capture = process.env.SCOUT_LIVE_CAPTURE_DIR;
const profileEnabled = process.env.SCOUT_PROFILE === 'true';
const calls = new Set();
async function outbound(request) {
  const url = new URL(request.url);
  calls.add(url.hostname);
  if (capture) {
    if (url.hostname === 'api.crossref.org') return Response.json(JSON.parse(await readFile(resolve(capture, 'scout-crossref.json'), 'utf8')));
    if (url.hostname === 'api.openalex.org') return Response.json(JSON.parse(await readFile(resolve(capture, 'scout-openalex.json'), 'utf8')));
    return new Response(null, { status: 403 });
  }
  const headers = {};
  if (url.hostname === 'api.openalex.org' && process.env.OPENALEX_API_KEY) headers.Authorization = 'Bearer ' + process.env.OPENALEX_API_KEY;
  if (url.hostname === 'api.crossref.org' && process.env.CROSSREF_MAILTO) url.searchParams.set('mailto', process.env.CROSSREF_MAILTO);
  return fetch(url, { redirect: 'manual', headers, signal: AbortSignal.timeout(10000) });
}

const r = await runtime({ http: outbound, inspector: profileEnabled, bindings: { SCOUT_AI_DAILY_NEURONS: '0' } });
let profile;
try {
  if (profileEnabled) profile = await isolateProfiler(r.mf);
  const tick = () => profile ? profile.measure(() => r.tick()) : r.tick();
  const paperPath = '/paper?doi=' + encodeURIComponent(doi);
  const queued = await r.request('/lookup', { doi: 'https://doi.org/' + doi.toUpperCase() });
  assert.equal(queued.status, 202);
  const runs = [await tick(), await tick(), await tick()];
  if (runs.some(run => run.outcome === 'retry' || run.outcome === 'failed')) {
    console.error((await r.db.prepare("SELECT kind,error FROM jobs WHERE error IS NOT NULL").all()).results);
  }
  assert.deepEqual(runs.map(run => [run.kind, run.outcome]), [['lookup','done'],['enrich','done'],['fulltext','done']]);
  const paper = await r.request(paperPath).then(res => res.json());
  assert.equal(paper.doi, doi);
  assert.match(paper.title, /Taking stock of social media privacy/i);
  assert.match(paper.openalex_id, /^https:\/\/openalex\.org\/W\d+$/);
  assert.ok(paper.abstract?.length > 100);
  assert.ok(paper.oa_locations.length > 0);
  assert.ok(paper.authors.length > 0);
  if (paper.status === 'pending') {
    assert.equal((await r.request('/screen', { doi, status: 'included', source: publisherSource, subtype: 'Research Article',
      reason: 'Publisher article reports an original meta-analysis with research questions, methods and results.' })).status, 200);
  }
  assert.equal((await r.request('/lookup', { doi })).status, 202);
  runs.push(await tick());
  assert.equal((await r.db.prepare('SELECT COUNT(*) AS n FROM papers WHERE doi=?').bind(doi).first()).n, 1);
  const list = await r.request('/library?q=' + encodeURIComponent(doi)).then(res => res.json());
  assert.equal(list.rows[0].doi, doi);
  const detail = await r.request(paperPath).then(res => res.json());
  assert.equal(detail.first_seen, paper.first_seen);
  for (const format of ['bib', 'ris']) {
    const response = await r.request('/export?doi=' + encodeURIComponent(doi) + '&format=' + format);
    assert.equal(response.status, 200);
    assert.ok((await response.text()).includes(doi));
  }
  console.log(JSON.stringify({ live: !capture, doi, contacted: [...calls], evidence: detail.evidence_state, journal: detail.journal,
    approvedBy: detail.screening_reviewer === 'owner' ? 'publisher-based manual screening' : 'source metadata', runs }, null, 2));
  if (process.argv.includes('--serve')) {
    process.env.SCOUT_WORKER_URL = (await r.mf.ready).href;
    process.env.SCOUT_API_TOKEN = testToken;
    process.env.SCOUT_LOCAL_DEV = 'true';
    process.env.SCOUT_PASSWORD = 'scout-validation-login-2026';
    process.env.SCOUT_SESSION_SECRET = crypto.randomUUID() + crypto.randomUUID();
    const { localServer } = await import('./local-web.mjs');
    await new Promise(resolve => {
      process.once('SIGINT', resolve);
      process.once('SIGTERM', resolve);
    });
    localServer.close();
  }
} finally {
  profile?.close();
  await r.close();

}
