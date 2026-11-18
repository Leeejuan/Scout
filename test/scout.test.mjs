import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { runtime } from '../scripts/test-runtime.mjs';
import { day, myDate, normalizeDoi, rollingStart, shift } from '../worker/core.mjs';
import { groundedClaims } from '../worker/extraction.mjs';
import { parseJats, parseTei } from '../worker/documents.mjs';
import { scheduledPeriod, validateSynthesis } from '../worker/reports.mjs';
import handler from '../api/scout.js';

const doi = '10.55555/scout-example';
const journal = '1083-6101';
const publication = shift(day(), -44);
const publisher = 'https://academic.oup.com/jcmc/article/scout';
const abstract = 'The study addresses user confidence. Users adjusted their privacy settings.';
const sample = {
  DOI: doi.toUpperCase(), title: ['Privacy on social media in Malaysia'], ISSN: [journal], type: 'journal-article',
  published: { 'date-parts': [publication.split('-').map(Number)] }, resource: { primary: { URL: publisher } },
  author: [{ given: 'Ada', family: 'Lee' }, { given: 'Sam', family: 'Lin' }],
  abstract: '<jats:p>' + abstract + '</jats:p>', volume: '1', issue: '2', page: '1–10'
};

const alex = dto => ({
  doi: 'https://doi.org/' + dto, id: 'https://openalex.org/W123456', type: 'article',
  authorships: [{ author: { id: 'https://openalex.org/A123', display_name: 'Ada Lee' }, countries: ['SG'] }],
  referenced_works: ['https://openalex.org/W654321'], cited_by_count: 3,
  best_oa_location: { is_oa: true, landing_page_url: publisher, version: 'publishedVersion', license: 'cc-by' }
});

function publisherHtml(doiValue = doi, type = 'Research Article') {
  const body = ['Introduction','Methods','Discussion','Conclusions'].map(name => '<h2>' + name + '</h2><p>' +
    ('Users adjusted their privacy settings. We ran an experiment with 38 participants. ').repeat(10) + '</p>').join('');
  return '<meta name="citation_doi" content="' + doiValue + '"><meta name="citation_article_type" content="' +
    type + '"><div class="article-body">' + body + '</div>';
}

const feishuWebhook = 'https://open.feishu.cn/open-apis/bot/v2/hook/synthetic-scout';
const feishuSecret = 'synthetic-feishu-signing-secret';
const feishuBindings = { FEISHU_WEBHOOK_URL: feishuWebhook, FEISHU_SIGNING_SECRET: feishuSecret };

async function assertFeishuCard(request, reportUrl) {
  assert.equal(request.url, feishuWebhook);
  assert.equal(request.method, 'POST');
  const message = await request.json();
  assert.match(message.timestamp, /^\d{10}$/);
  assert.ok(Math.abs(Date.now() / 1000 - Number(message.timestamp)) < 60);
  const expected = createHmac('sha256', message.timestamp + '\n' + feishuSecret).digest('base64');
  assert.equal(message.sign, expected);
  assert.equal(message.msg_type, 'interactive');
  assert.equal(message.card.schema, '2.0');
  const button = message.card.body.elements.find(item => item.tag === 'button');
  assert.equal(button.text.content, '查看完整简报');
  assert.deepEqual(button.behaviors, [{ type: 'open_url', default_url: reportUrl }]);
  return message.card;
}

const jsonVersion = (data, version, extra) => Response.json(data, { headers: { 'Last-Modified-Version': String(version), ...extra } });

test('DOI, date windows and conservative extraction', () => {
  assert.equal(normalizeDoi(' HTTPS://DX.DOI.ORG/10.55555%2FSCOUT-EXAMPLE '), doi);
  assert.equal(normalizeDoi('not a DOI'), null);
  assert.equal(rollingStart('2028-02-29'), '2025-02-28');
  assert.deepEqual(myDate(new Date('2026-12-15T23:59:59Z')), { date: '2026-12-16', hour: 7 });
  assert.equal(scheduledPeriod(new Date('2026-12-16T00:00:00Z')), '2026-12-16');
  const text = 'The study addresses user confidence.';
  assert.deepEqual(groundedClaims({ claims: [
    { field: 'methods', value: 'study', quote: text },
    { field: 'methods', value: 'regression', quote: text },
    { field: 'limitations', value: 'confidence', quote: text }
  ] }, { content: text }, 'abstract'), []);
  assert.equal(parseJats('<article article-type="editorial"><article-id pub-id-type="doi">' + doi + '</article-id><body><p>text.</p></body></article>', doi).screening.status, 'excluded');
  assert.equal(parseTei('<teiHeader><idno type="DOI">10.55555/another</idno></teiHeader><body><p>text.</p></body>', doi), null);
  assert.deepEqual(validateSynthesis({ state: [{ text: 'No source', ids: [1,1,99] }] },
    [{ doi }], new Set([doi])).state, []);
});

test('real D1 migrations, discovery, screening, OA HTML, export and Zotero idempotency', async t => {
  const items = [
    { key: 'BASE0001', version: 1, data: { itemType: 'journalArticle', DOI: doi.toUpperCase(), collections: ['OTHERCOL'], extra: 'personal metadata' } }
  ];
  const notes = [{ key: 'USERNOTE', data: { itemType: 'note', note: 'My own reading note', tags: [] } }];
  let version = 1;
  let writes = 0;
  const http = async req => {
    const url = new URL(req.url);
    if (url.hostname === 'api.crossref.org') return Response.json({ message: sample });
    if (url.hostname === 'api.openalex.org') return Response.json(alex(doi));
    if (url.hostname === 'academic.oup.com') return new Response(publisherHtml(), { headers: { 'content-type': 'text/html' } });
    assert.equal(req.headers.get('zotero-api-key'), 'synthetic-zotero-token');
    if (url.pathname.endsWith('/items/top')) return jsonVersion(items, version);
    if (url.pathname.endsWith('/children')) return jsonVersion(notes.filter(note => note.data.tags.length), version);
    if (url.pathname.endsWith('/items/BASE0001')) {
      if (req.method === 'GET') return jsonVersion(items[0], version);
      assert.equal(req.headers.get('if-unmodified-since-version'), String(items[0].version));
      assert.deepEqual(await req.json(), { collections: ['OTHERCOL','TESTCOLL'] });
      items[0].data.collections.push('TESTCOLL');
      items[0].version = ++version;
      writes++;
      return new Response(null, { status: 204, headers: { 'Last-Modified-Version': String(version) } });
    }
    if (url.pathname.endsWith('/items') && req.method === 'POST') {
      assert.equal(req.headers.get('if-unmodified-since-version'), String(version));
      const [note] = await req.json();
      assert.equal(note.itemType, 'note');
      assert.equal(note.parentItem, 'BASE0001');
      notes.push({ key: 'SCOUTNOT', data: note });
      writes++;
      return jsonVersion({ successful: { '0': { key: 'SCOUTNOT' } } }, ++version);
    }
    throw new Error('Unexpected request ' + url.href);
  };
  const r = await runtime({ http, bindings: { ZOTERO_API_KEY: 'synthetic-zotero-token', ZOTERO_LIBRARY_ID: '7', ZOTERO_COLLECTION_KEY: 'TESTCOLL' } });
  t.after(r.close);
  assert.equal((await r.request('/library', undefined, 'wrong')).status, 401);
  assert.equal((await r.request('/lookup', { doi: doi.toUpperCase() })).status, 202);
  assert.equal((await r.tick()).kind, 'lookup');
  assert.equal((await r.tick()).kind, 'enrich');
  assert.equal((await r.request('/library').then(res => res.json())).rows.length, 0);
  assert.equal((await r.tick()).kind, 'fulltext');
  assert.equal((await r.tick()).kind, 'extract');
  const paperPath = '/paper?doi=' + encodeURIComponent(doi);
  const paper = await r.request(paperPath).then(res => res.json());
  assert.equal(paper.status, 'included');
  assert.equal(paper.evidence_state, 'fulltext');
  assert.equal(paper.document.format, 'html');
  assert.equal(paper.judgments.find(row => row.field === 'findings').locator, '摘要');
  assert.ok(!paper.judgments.some(row => ['methods','limitations'].includes(row.field)));
  assert.deepEqual(paper.regions, ['MY','SEA']);
  assert.equal(paper.authors[0].id, 'https://openalex.org/A123');
  assert.equal(paper.refs[0], 'https://openalex.org/W654321');
  assert.equal((await r.request('/lookup', { doi: 'https://doi.org/' + doi })).status, 202);
  assert.equal((await r.tick()).kind, 'lookup');
  assert.equal((await r.db.prepare('select count(*) AS n from papers').first()).n, 1);
  assert.equal((await r.request(paperPath).then(res => res.json())).first_seen, paper.first_seen);
  assert.equal((await r.request('/overview', undefined, 'wrong')).status, 401);
  const overview = await r.request('/overview').then(res => res.json());
  assert.deepEqual(overview.months, [{ month: publication.slice(0, 7), status: 'included', evidence_state: 'fulltext', count: 1 }]);
  assert.ok(overview.domains.some(row => row.tag === 'digital' && row.count === 1));
  assert.equal(overview.journals, 2);
  const bib = await r.request('/export?format=bib&doi=' + encodeURIComponent(doi));
  assert.match(await bib.text(), /doi = \{10\.55555\/scout-example\}/);
  const ris = await r.request('/export?format=ris&doi=' + encodeURIComponent(doi));
  assert.match(await ris.text(), /DO  - 10\.55555\/scout-example/);
  for (let i = 0; i < 2; i++) {
    assert.equal((await r.request('/zotero', { doi })).status, 202);
    assert.deepEqual((await r.tick()).outcome, 'done');
  }
  assert.equal(writes, 2);
  assert.equal(items.length, 1);
  assert.equal(notes.length, 2);
  assert.equal(notes[0].data.note, 'My own reading note');
  assert.equal((await r.request(paperPath).then(res => res.json())).zotero.status, 'synced');
});

test('persistent page progress records omissions and survives pagination', async t => {
  const seen = [];
  const http = async req => {
    const url = new URL(req.url);
    const offset = Number(url.searchParams.get('offset'));
    seen.push(offset);
    const records = Array.from({ length: offset ? 1 : 6 }, (_, i) => ({
      ...sample, DOI: '10.55555/discover-' + (offset + i), published: { 'date-parts': [[2025, 1, 1]] },
      type: i === 1 ? 'posted-content' : 'journal-article',
      title: i === 2 ? ['Editorial: A new volume'] : sample.title
    }));
    return Response.json({ message: { items: records, 'total-results': 7 } });
  };
  const r = await runtime({ http });
  t.after(r.close);
  const planned = await r.request('/backfill', { tier: 'pilot' }).then(res => res.json());
  const other = await r.request('/backfill', { tier: 'pilot' }).then(res => res.json());
  assert.equal(planned.id, other.id);
  const [first] = (await r.db.prepare("SELECT id FROM jobs WHERE kind='discover' ORDER BY id LIMIT 1").all()).results;
  await r.db.prepare('UPDATE jobs SET priority=0 WHERE id=?').bind(first.id).run();
  assert.equal((await r.tick()).outcome, 'progress');
  assert.equal((await r.tick()).outcome, 'done');
  assert.deepEqual(seen, [0,6]);
  const rows = await r.request('/search?id=' + encodeURIComponent(planned.id)).then(res => res.json());
  assert.ok(rows.some(row => row.done === 1 && row.returned === 7));
  assert.equal((await r.db.prepare("SELECT count(*) AS n FROM papers WHERE status='excluded'").first()).n, 2);
});

test('UTC reservation includes failure, concurrency and smaller caps', async t => {
  const r = await runtime();
  t.after(r.close);
  const failures = await r.request('/test/budget?now=2026-11-01T23:59:59Z&fail=1');
  assert.equal(failures.status, 503);
  const results = await Promise.all(Array.from({ length: 24 }, async () =>
    r.request('/test/budget?now=2026-11-01T23:59:59Z').then(res => res.json())));
  assert.equal(results.filter(result => result.deferred).length, 5);
  const next = await r.request('/test/budget?now=2026-11-02T00:00:00Z').then(res => res.json());
  assert.ok(next.result);
  const budgets = (await r.db.prepare('SELECT utc_day,neurons,calls FROM ai_budget ORDER BY utc_day').all()).results;
  assert.deepEqual(budgets, [{ utc_day: '2026-11-01', neurons: 6000, calls: 20 }, { utc_day: '2026-11-02', neurons: 300, calls: 1 }]);
  const small = await runtime({ bindings: { SCOUT_AI_DAILY_NEURONS: '899' } });
  t.after(small.close);
  const capped = await Promise.all(Array.from({ length: 4 }, () =>
    small.request('/test/budget?now=2026-11-02T00:00:00Z').then(res => res.json())));
  assert.equal(capped.filter(result => result.result).length, 2);
});

test('scheduled report persists before Feishu and ambiguous outcomes never auto-republish', async t => {
  let calls = 0;
  let persisted;
  let r;
  const http = async req => {
    if (new URL(req.url).hostname === 'api.crossref.org') return Response.json({ message: { items: [], 'total-results': 0 } });
    if (new URL(req.url).hostname !== 'open.feishu.cn') throw new Error('unexpected external request');
    persisted = await r.db.prepare('SELECT delivery FROM reports WHERE period=?').bind('2026-12-16').first();
    const card = await assertFeishuCard(req, 'https://scout.example/?report=2026-12-16');
    assert.match(card.body.elements[0].text.content, /Finding/);
    calls++;
    return Response.json({ code: 10000 }, { status: 500 });
  };
  r = await runtime({ http, bindings: { SCHEDULE_ENABLED: 'true', FEISHU_ENABLED: 'true', SCOUT_WEB_URL: 'https://scout.example', ...feishuBindings } });
  t.after(r.close);
  const future = '2026-12-16T03:00:00Z';
  const before = '2026-12-16T00:00:00Z';
  const names = [doi, '10.55555/another'];
  for (const [i, id] of names.entries()) {
    await r.db.prepare(`INSERT INTO papers(doi,issn,title,published,publisher_url,crossref_url,status,tags,authors,refs,
      first_seen,last_verified,evidence_updated,evidence_state) VALUES(?,?,?,?,?,?,'included','["digital"]',?,?,?, ?,?,'fulltext')`)
      .bind(id,journal,'Communication research ' + i,'2026-12-10',publisher,'https://api.crossref.org',JSON.stringify([{name:'A. Lee'},{name:'B. Lin'}]),
        JSON.stringify(i === 0 ? [names[1]] : []),before,before,before).run();
    await r.db.prepare("INSERT INTO judgments VALUES(?,'findings',?,?,?,?,'fulltext','author',1)")
      .bind(id, 'Finding ' + i, 'Documented finding ' + i, 'Results', publisher).run();
  }
  assert.equal((await r.tick(before)).kind, 'discover');
  assert.equal((await r.tick(before)).kind, 'discover');
  assert.equal((await r.tick(future)).kind, 'report');
  assert.equal((await r.db.prepare('SELECT COUNT(*) AS n FROM searches').first()).n, 1);
  const report = await r.request('/report?period=2026-12-16').then(res => res.json());
  assert.equal(report.delivery, 'pending');
  assert.equal(report.delivery_channel, 'feishu');
  assert.equal(report.content.relationships.citations.length, 1);
  assert.equal(report.content.relationships.similarity.length, 1);
  assert.equal(report.content.synthesis.disagreements[0].compare.length, 2);
  assert.equal(report.content.synthesis.disagreements[0].compare[0].dimensions.measurement, null);
  assert.equal((await r.request('/topics').then(res => res.json())).length, 1);
  assert.equal((await r.tick(future)).kind, 'feishu');
  assert.deepEqual(persisted, { delivery: 'sending' });
  assert.equal((await r.request('/report?period=2026-12-16').then(res => res.json())).delivery, 'uncertain');
  await r.tick(future);
  assert.equal(calls, 1);
  assert.equal((await r.request('/feishu-reconcile', { period: '2026-12-16', action: 'sent', checkedDelivered: true })).status, 200);
  assert.equal((await r.request('/report?period=2026-12-16').then(res => res.json())).delivery, 'sent');
});

test('Vercel shell requires private session and blocks cross-origin mutations', async t => {
  const set = { SCOUT_LOCAL_DEV: 'true', SCOUT_PASSWORD: 'synthetic-password-not-for-use', SCOUT_SESSION_SECRET: 'synthetic-session-secret-32-characters' };
  const previous = Object.fromEntries(Object.keys(set).map(key => [key, process.env[key]]));
  Object.assign(process.env, set);
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const server = createServer(handler).listen(0, '127.0.0.1');
  t.after(() => server.close());
  await once(server, 'listening');
  const base = 'http://127.0.0.1:' + server.address().port;
  const send = (action, opts) => fetch(base + '/api/scout?action=' + action, opts);
  assert.equal((await send('library')).status, 401);
  const login = origin => send('login', { method: 'POST', headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify({ password: set.SCOUT_PASSWORD }) });
  assert.equal((await login('https://external.test')).status, 403);
  const success = await login(base);
  assert.equal(success.status, 200);
  const cookie = success.headers.get('set-cookie').split(';')[0];
  assert.equal((await send('session', { headers: { cookie } }).then(res => res.json())).signedIn, true);
  assert.equal((await send('session', { headers: { cookie: cookie + 'x' } }).then(res => res.json())).signedIn, false);
});

test('Preview serves research data before login and keeps management actions authenticated', async t => {
  const token = 'synthetic-readonly-test-worker-token';
  const requests = [];
  const worker = createServer((req, res) => {
    requests.push({ path: req.url, method: req.method, token: req.headers.authorization });
    const content = req.url.startsWith('/paper') ? { doi, zotero: { item_key: 'private-test-key' } } :
      req.url.startsWith('/report') ? { demo: true, telegram_id: 'private-test-id' } : { reachable: true };
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(content));
  }).listen(0, '127.0.0.1');
  t.after(() => worker.close());
  await once(worker, 'listening');
  const set = { VERCEL_ENV: 'preview', SCOUT_LOCAL_DEV: 'true', SCOUT_API_TOKEN: token,
    SCOUT_WORKER_URL: 'http://127.0.0.1:' + worker.address().port,
    SCOUT_PASSWORD: 'synthetic-password-not-for-use', SCOUT_SESSION_SECRET: 'synthetic-session-secret-32-characters' };
  const previous = Object.fromEntries(Object.keys(set).map(key => [key, process.env[key]]));
  Object.assign(process.env, set);
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const web = createServer(handler).listen(0, '127.0.0.1');
  t.after(() => web.close());
  await once(web, 'listening');
  const base = 'http://127.0.0.1:' + web.address().port;
  const send = (action, opts) => fetch(base + '/api/scout?action=' + action, opts);
  const post = (body, cookie) => ({ method: 'POST', headers: { origin: base, 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body) });
  const session = await send('session').then(res => res.json());
  assert.deepEqual(session, { signedIn: false, readWithoutLogin: true, managementAvailable: true });
  assert.equal((await send('overview')).status, 200);
  assert.deepEqual(await send('paper&doi=' + encodeURIComponent(doi)).then(res => res.json()), { doi });
  assert.deepEqual(await send('report&period=feishu-test').then(res => res.json()), { demo: true });
  assert.equal((await send('activity')).status, 401);
  assert.equal((await send('zotero', post({ doi }))).status, 401);
  assert.equal(requests.length, 3);
  const login = await send('login', post({ password: set.SCOUT_PASSWORD }));
  const cookie = login.headers.get('set-cookie').split(';')[0];
  assert.equal((await send('activity', { headers: { cookie } })).status, 200);
  assert.equal((await send('zotero', post({ doi }, cookie))).status, 200);
  assert.ok(requests.every(entry => entry.token === 'Bearer ' + token));
  process.env.VERCEL_ENV = 'production';
  assert.equal((await send('overview')).status, 401);
});

test('local text retains PDF locators and accepts only attributable manual evidence', async t => {
  const r = await runtime();
  t.after(r.close);
  const stamp = new Date().toISOString();
  await r.db.prepare(`INSERT INTO papers(doi,issn,title,published,publisher_url,crossref_url,status,first_seen,last_verified)
    VALUES(?,?,?,?,?,?,'included',?,?)`).bind(doi, journal, 'A literature review', publication, publisher, 'https://api.crossref.org', stamp, stamp).run();
  const quote = 'Our meta-analysis linked confidence to better reported privacy settings.';
  const text = '# Introduction\n' + 'This research reviews a series of studies. '.repeat(35) +
    '\f# Results\n' + quote + ' ' + 'Study results are documented here. '.repeat(14);
  const imported = await r.request('/document', { doi, source: publisher, coverage: 'body', text });
  assert.equal(imported.status, 200);
  assert.equal((await r.request('/document', { doi, source: publisher, coverage: 'body', text })).status, 409);
  const base = { doi, field: 'methods', level: 'fulltext', value: 'meta-analysis', quote };
  assert.equal((await r.request('/judgment', { ...base, locator: 'PDF 页 1 · Results' })).status, 422);
  assert.equal((await r.request('/judgment', { ...base, locator: 'PDF 页 2 · Results' })).status, 200);
  await r.request('/screen', { doi, status: 'included', subtype: 'Systematic Review', source: publisher,
    reason: 'Publisher confirms the study type.' });
  const paper = await r.request('/paper?doi=' + encodeURIComponent(doi)).then(res => res.json());
  assert.equal(paper.evidence_state, 'fulltext');
  assert.deepEqual(paper.codes, { types: ['systematic_review'], methods: ['meta_analysis'] });
  assert.deepEqual(paper.judgments.map(j => [j.locator, j.doi, j.reviewed]), [['PDF 页 2 · Results', doi, 1]]);
  const matches = await r.request('/library?q=reported+privacy+settings').then(res => res.json());
  assert.equal(matches.rows[0].doi, doi);
});

test('Feishu confirms one delivery when repeated jobs compete', async t => {
  let outgoing = 0;
  const http = async request => {
    await assertFeishuCard(request, 'https://scout.example/?report=2026-12-16');
    outgoing++;
    return Response.json({ code: 0, msg: 'success' });
  };
  const r = await runtime({ http, bindings: { FEISHU_ENABLED: 'true', SCOUT_WEB_URL: 'https://scout.example', ...feishuBindings } });
  t.after(r.close);
  const period = '2026-12-16';
  const now = new Date();
  await r.db.prepare(`INSERT INTO reports(period,window_start,window_end,generated,content,delivery,delivery_channel)
    VALUES(?,'2026-12-01','2026-12-15',?,'{}','pending','feishu')`).bind(period, now.toISOString()).run();
  for (let i = 0; i < 2; i++) {
    await r.db.prepare("INSERT INTO jobs(id,kind,payload,priority,due) VALUES(?,'feishu',?,5,?)")
      .bind('feishu-test:' + i, JSON.stringify({ period }), now.valueOf()).run();
  }
  await Promise.all([r.tick(), r.tick()]);
  await r.tick();
  const report = await r.request('/report?period=' + period).then(res => res.json());
  assert.equal(outgoing, 1);
  assert.equal(report.delivery, 'sent');
});

test('signed staging card is gated and links to an authenticated demo report without scheduling', async t => {
  let calls = 0;
  const http = async request => {
    const card = await assertFeishuCard(request, 'https://scout-preview.example/?report=feishu-test');
    assert.match(card.header.title.content, /推送测试/);
    calls++;
    return calls === 1 ? Response.json({ code: 19021, msg: 'signature invalid' }) :
      Response.json({ StatusCode: 0, StatusMessage: 'success' });
  };
  const input = { webUrl: 'https://scout-preview.example' };
  const disabled = await runtime({ http, bindings: feishuBindings });
  t.after(disabled.close);
  assert.equal((await disabled.request('/__feishu-test', input)).status, 404);
  assert.equal((await disabled.request('/report?period=feishu-test')).status, 404);
  const r = await runtime({ http, bindings: { ...feishuBindings, FEISHU_TEST_ENABLED: 'true',
    SCHEDULE_ENABLED: 'false', FEISHU_ENABLED: 'false', SCOUT_AI_DAILY_NEURONS: '0' } });
  t.after(r.close);
  assert.equal((await r.request('/__feishu-test', input, 'unauthorized')).status, 401);
  assert.equal((await r.request('/__feishu-test', { webUrl: 'http://scout-preview.example' })).status, 422);
  assert.equal(calls, 0);
  const rejected = await r.request('/__feishu-test', input);
  assert.equal(rejected.status, 422);
  assert.match((await rejected.json()).error, /签名校验失败/);
  const response = await r.request('/__feishu-test', input);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { sent: true, reportUrl: 'https://scout-preview.example/?report=feishu-test' });
  assert.equal(calls, 2);
  assert.equal((await r.request('/report?period=feishu-test', undefined, 'unauthorized')).status, 401);
  const demo = await r.request('/report?period=feishu-test').then(res => res.json());
  assert.equal(demo.demo, true);
  assert.deepEqual(await r.request('/reports').then(res => res.json()), []);
  assert.deepEqual((await r.request('/activity').then(res => res.json())).budget, []);
  assert.equal((await r.db.prepare('SELECT count(*) AS count FROM jobs').first()).count, 0);
});
