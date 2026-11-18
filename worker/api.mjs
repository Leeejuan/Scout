import { day, enqueueStmt, FIELDS, httpsUrl, limitedText, normalizeDoi, parse, Problem, researchCodes, rollingStart, TAGS } from './core.mjs';
import { planSearch } from './collection.mjs';
import { documentStatements, localText } from './documents.mjs';
import { exportCitation } from './export.mjs';
import { hash, topicFields, topicSignature } from './reports.mjs';
import { screenType } from './sources.mjs';

const headers = { 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' };
export const reply = (data, status = 200) => Response.json(data, { status, headers });
const withJson = (row, fields) => {
  const output = { ...row };
  for (const [field, initial] of Object.entries(fields)) output[field] = parse(row[field], initial);
  return output;
};

async function paperDetails(s, doi) {
  const paper = await s.first(`SELECT p.*,j.name AS journal,j.policy_url,j.fields AS journal_fields,j.verified_on AS journal_verified
    FROM papers p JOIN journals j USING(issn) WHERE doi=?`, doi);
  if (!paper) throw new Problem(404, '未找到 DOI');
  const judgments = await s.all(`SELECT doi,field,value,quote,locator,source,level,origin,reviewed FROM judgments
    WHERE doi=? ORDER BY reviewed DESC,CASE level WHEN 'fulltext' THEN 0 ELSE 1 END,field,locator LIMIT 240`, doi);
  const document = await s.first('SELECT * FROM documents WHERE doi=?', doi);
  const zotero = await s.first('SELECT * FROM zotero_sync WHERE doi=?', doi);
  return { ...withJson(paper, { authors: [], citation: {}, oa_locations: [], refs: [], tags: [], regions: [], journal_fields: [] }),
    judgments, document, zotero, codes: researchCodes(paper.subtype, judgments) };
}

function requireDoi(value) {
  const doi = normalizeDoi(value);
  if (!doi) throw new Problem(400, '需要有效的 DOI');
  return doi;
}

async function library(s, params, now) {
  const limit = 18;
  const status = ['included','pending','excluded'].includes(params.get('status')) ? params.get('status') : 'included';
  const query = (params.get('q') ?? '').trim().slice(0, 180);
  const tag = params.get('tag');
  const region = params.get('region');
  const state = params.get('state');
  const after = params.get('after') ?? '';
  const cursor = [after.slice(0, 10), after.slice(11)];
  const date = day(now);
  const filters = ['p.status=?', 'p.published BETWEEN ? AND ?'];
  const args = [status, rollingStart(date), date];
  if (query) {
    filters.push(`(p.doi=? OR instr(lower(p.title),lower(?))>0 OR instr(lower(coalesce(p.abstract,'')),lower(?))>0 OR instr(lower(p.authors),lower(?))>0
      OR EXISTS(SELECT 1 FROM judgments e WHERE e.doi=p.doi AND (instr(lower(e.value),lower(?))>0 OR instr(lower(e.quote),lower(?))>0)))`);
    args.push(normalizeDoi(query) ?? query, query, query, query, query, query);
  }
  if (tag && Object.hasOwn(TAGS, tag)) {
    filters.push('EXISTS(SELECT 1 FROM json_each(p.tags) WHERE value=?)');
    args.push(tag);
  }
  if (['CN','MY','SEA'].includes(region)) {
    filters.push('EXISTS(SELECT 1 FROM json_each(p.regions) WHERE value=?)');
    args.push(region);
  }
  if (['record','abstract','fulltext'].includes(state)) {
    filters.push('p.evidence_state=?');
    args.push(state);
  }
  if (/^\d{4}-\d\d-\d\d$/.test(cursor[0]) && normalizeDoi(cursor[1])) {
    filters.push('(p.published<? OR p.published=? AND p.doi>?)');
    args.push(cursor[0], cursor[0], cursor[1]);
  }
  const papers = await s.all(`SELECT p.doi,p.title,p.published,p.authors,p.status,p.subtype,p.evidence_state,p.tags,p.regions,j.name AS journal,
    (SELECT json_group_array(json_object('value',v.value,'field',v.field,'level',v.level)) FROM
      (SELECT field,value,level FROM judgments WHERE doi=p.doi AND field IN ('article_type','design','methods')
        ORDER BY reviewed DESC,field,level DESC LIMIT 5) v) AS labels
    FROM papers p JOIN journals j USING(issn) WHERE ${filters.join(' AND ')}
    ORDER BY p.published DESC,p.doi LIMIT ?`, ...args, limit + 1);
  const more = papers.length > limit;
  const rows = papers.slice(0, limit).map(row => {
    const unpacked = withJson(row, { authors: [], tags: [], regions: [], labels: [] });
    return { ...unpacked, codes: researchCodes(row.subtype, unpacked.labels) };
  });
  const counts = await s.all(`SELECT status,evidence_state,count(*) AS count FROM papers
    WHERE published BETWEEN ? AND ? GROUP BY status,evidence_state`, rollingStart(date), date);
  return { rows, counts, lower: rollingStart(date), upper: date, next: more ? rows.at(-1).published + '|' + rows.at(-1).doi : null };
}

async function screen(s, data, now) {
  const doi = requireDoi(data.doi);
  const url = httpsUrl(data.source);
  const subtype = String(data.subtype ?? '').trim().slice(0, 120);
  const reason = String(data.reason ?? '').trim().slice(0, 600);
  if (!['included','excluded','pending'].includes(data.status) || !url || !subtype || !reason) {
    throw new Problem(400, '筛查需填写单篇类型、依据网址和说明');
  }
  if (data.status === 'included' && screenType(subtype).status === 'excluded') throw new Problem(400, '该文章类型不符合证据库收录标准');
  const changed = await s.first(`UPDATE papers SET status=?,subtype=?,screening_url=?,screening_reason=?,screening_reviewer='owner',
    last_verified=?,evidence_updated=? WHERE doi=? RETURNING doi`, data.status, subtype, url, reason,
    now.toISOString(), now.toISOString(), doi);
  if (!changed) throw new Problem(404, '未找到 DOI');
  return { doi };
}

async function saveReview(s, data, now) {
  const doi = requireDoi(data.doi);
  const { field, value, quote } = data;
  if (!Object.hasOwn(FIELDS, field) || typeof value !== 'string' || !value.trim() || value.length > 650 ||
      typeof quote !== 'string' || quote.trim().length < 8 || quote.length > 700) throw new Problem(400, '字段、判断和引文不完整');
  const level = data.level;
  const requestedLocator = typeof data.locator === 'string' ? data.locator.trim() : '';
  const paper = await s.first('SELECT abstract,abstract_source FROM papers WHERE doi=?', doi);
  if (!paper) throw new Problem(404, '未找到 DOI');
  const evidence = level === 'abstract'
    ? paper?.abstract?.includes(quote) && { locator: '摘要', source: paper.abstract_source }
    : level === 'fulltext' && await s.first(`SELECT p.locator,d.source FROM passages p JOIN documents d USING(doi)
      WHERE doi=? AND instr(p.content,?)>0 AND (?='' OR p.locator=?) ORDER BY ordinal LIMIT 1`, doi, quote, requestedLocator, requestedLocator);
  if (!evidence || !evidence.source || level === 'abstract' && ['limitations','future','ro_inferred','article_type'].includes(field)) {
    throw new Problem(422, '引文需与该 DOI 已保存的原文及位置对应');
  }
  const origin = field === 'ro_inferred' ? 'inferred' : 'author';
  await s.batch([
    s.stmt(`INSERT INTO judgments VALUES (?,?,?,?,?,?,?,?,1) ON CONFLICT(doi,field,locator,quote,value) DO UPDATE SET
      reviewed=1,source=excluded.source,level=excluded.level,origin=excluded.origin`,
      doi, field, value.trim(), quote, evidence.locator, evidence.source, level, origin),
    s.stmt('UPDATE papers SET evidence_updated=? WHERE doi=?', now.toISOString(), doi)
  ]);
  return { doi, locator: evidence.locator };
}

async function importText(s, data, now) {
  const doi = requireDoi(data.doi);
  const source = httpsUrl(data.source);
  const coverage = data.coverage;
  if (!source || !['body','excerpt'].includes(coverage)) throw new Problem(400, '需提供正文来源及覆盖范围');
  const paper = await s.first('SELECT status FROM papers WHERE doi=?', doi);
  if (!paper || paper.status === 'excluded') throw new Problem(422, '该 DOI 尚未发现或已排除');
  const passages = localText(data.text);
  if (coverage === 'body' && passages.reduce((sum, block) => sum + block.content.length, 0) < 1500) {
    throw new Problem(422, '正文过短，可按节选导入');
  }
  if (await s.first('SELECT doi FROM documents WHERE doi=?', doi)) throw new Problem(409, '此 DOI 已有正文记录');
  const stamp = now.toISOString() + '/' + crypto.randomUUID();
  const statements = documentStatements(s, doi, source, 'local-text', coverage, passages, stamp);
  // A second concurrent import must fail atomically, preserving the first source and its reviewed claims.
  statements[0] = s.stmt('INSERT INTO documents VALUES (?,?,?,?,?)', doi, source, 'local-text', coverage, stamp);
  statements[4] = s.stmt(`UPDATE papers SET evidence_state=CASE WHEN ?='body' THEN 'fulltext'
    WHEN abstract IS NOT NULL THEN 'abstract' ELSE 'record' END,evidence_updated=? WHERE doi=?`, coverage, now.toISOString(), doi);
  await s.batch(statements);
  return { doi, passages: passages.length };
}

async function saveTopic(s, data, now) {
  const stamp = now.toISOString();
  const fields = topicFields(data);
  const dois = [...new Set(Array.isArray(data.dois) ? data.dois.slice(0, 16).map(normalizeDoi).filter(Boolean) : [])];
  if (!fields || !dois.length) throw new Problem(400, '每张选题卡需填写全部字段及至少一个 DOI');
  const available = await s.all(`SELECT doi FROM papers WHERE status='included' AND doi IN (SELECT value FROM json_each(?))`, JSON.stringify(dois));
  if (available.length !== dois.length) throw new Problem(422, '选题依据须来自已收录文献');
  const signature = await topicSignature(fields);
  const id = typeof data.id === 'string' ? data.id : (await hash('personal:' + signature)).slice(0, 24);
  await s.run(`INSERT INTO topics(id,title,content,signature,created,updated,status) VALUES(?,?,?,?,?,?,'saved')
    ON CONFLICT(id) DO UPDATE SET title=excluded.title,content=excluded.content,signature=excluded.signature,
    updated=excluded.updated,status='saved'
    ON CONFLICT(signature) DO UPDATE SET title=excluded.title,content=excluded.content,updated=excluded.updated,status='saved'`,
    id, fields.title, JSON.stringify({ ...fields, dois }), signature, stamp, stamp);
  return { saved: true };
}

export async function route(s, request, now = new Date()) {
  const url = new URL(request.url);
  const path = url.pathname;
  const params = url.searchParams;
  if (request.method === 'GET') {
    if (path === '/library') return reply(await library(s, params, now));
    if (path === '/paper') return reply(await paperDetails(s, requireDoi(params.get('doi'))));
    if (path === '/export') {
      const format = params.get('format') === 'bib' ? 'bib' : 'ris';
      const paper = await paperDetails(s, requireDoi(params.get('doi')));
      if (paper.status !== 'included') throw new Problem(422, '仅已收录条目可导出');
      return new Response(exportCitation({ ...paper, authors: JSON.stringify(paper.authors), citation: JSON.stringify(paper.citation) }, format),
        { headers: { ...headers, 'content-type': format === 'bib' ? 'application/x-bibtex; charset=utf-8' : 'application/x-research-info-systems; charset=utf-8',
          'content-disposition': 'attachment; filename="scout.' + format + '"' } });
    }
    if (path === '/reports') return reply(await s.all(`SELECT period,window_start,window_end,generated,delivery,digest FROM reports ORDER BY period DESC LIMIT 48`));
    if (path === '/report') {
      const report = await s.first('SELECT * FROM reports WHERE period=?', params.get('period'));
      if (!report) throw new Problem(404, '该期简报尚未生成');
      return reply(withJson(report, { content: {} }));
    }
    if (path === '/topics') return reply((await s.all('SELECT * FROM topics ORDER BY updated DESC LIMIT 100')).map(row => withJson(row, { content: {} })));
    if (path === '/journals') return reply((await s.all('SELECT * FROM journals ORDER BY tier DESC,name')).map(row => withJson(row, { fields: [] })));
    if (path === '/activity') {
      const [jobs, events, searches, budget] = await Promise.all([
        s.all('SELECT status,kind,count(*) AS count FROM jobs GROUP BY status,kind'),
        s.all('SELECT * FROM job_events ORDER BY id DESC LIMIT 30'),
        s.all(`SELECT r.*,count(x.issn) AS slices,sum(x.done) AS done,sum(x.returned) AS returned,sum(x.omitted) AS omitted,
          sum(CASE WHEN x.error IS NOT NULL THEN 1 ELSE 0 END) AS errors
          FROM searches r LEFT JOIN search_slices x ON x.search_id=r.id GROUP BY r.id ORDER BY r.started DESC LIMIT 12`),
        s.all('SELECT * FROM ai_budget ORDER BY utc_day DESC LIMIT 7')
      ]);
      return reply({ searches, jobs, events, budget, tier: s.env.JOURNAL_TIER === 'expanded' ? 'expanded' : 'pilot' });
    }
    if (path === '/search') {
      return reply((await s.all('SELECT issn,lower_date,upper_date,pages,returned,omitted,total_expected,omissions,done,error FROM search_slices WHERE search_id=? ORDER BY issn,lower_date LIMIT 200',
        params.get('id'))).map(row => withJson(row, { omissions: {} })));
    }
    throw new Problem(404, '未找到接口');
  }
  if (request.method !== 'POST') throw new Problem(405, '请求方法不支持');
  const data = parse(await limitedText(new Response(request.body), 310000), null);
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Problem(400, '需要有效 JSON 请求');
  if (path === '/lookup') {
    const doi = requireDoi(data.doi);
    const id = 'lookup:' + doi;
    await s.run(`INSERT INTO jobs(id,kind,payload,priority,due) VALUES(?,'lookup',?,4,?)
      ON CONFLICT(id) DO UPDATE SET status='queued',due=excluded.due,error=NULL,attempts=0
      WHERE jobs.status IN ('done','dead')`, id, JSON.stringify({ doi }), now.valueOf());
    return reply({ doi, queued: true }, 202);
  }
  if (path === '/backfill') {
    const tier = data.tier === 'expanded' && s.env.JOURNAL_TIER === 'expanded' ? 'expanded' : 'pilot';
    const running = await s.first(`SELECT r.id FROM searches r JOIN search_slices x ON x.search_id=r.id
      JOIN jobs q ON q.id='discover:'||x.search_id||':'||x.issn||':'||x.lower_date
      WHERE r.mode='backfill' AND q.status IN ('queued','running') AND json_array_length(r.journals)=
      (SELECT count(*) FROM journals WHERE tier='pilot' OR ?='expanded') LIMIT 1`, tier);
    const date = day(now);
    const id = running?.id ?? 'backfill:' + tier + ':' + date;
    if (!running) await planSearch(s, { id, mode: 'backfill', tier, lower: rollingStart(date), upper: date }, now);
    return reply({ id, queued: true }, 202);
  }
  if (path === '/screen') return reply(await screen(s, data, now));
  if (path === '/document') return reply(await importText(s, data, now));
  if (path === '/judgment') return reply(await saveReview(s, data, now));
  if (path === '/topic') return reply(await saveTopic(s, data, now));
  if (path === '/topic-state') {
    if (!['saved','archived','candidate'].includes(data.status)) throw new Problem(400, '选题状态无效');
    const found = await s.first('UPDATE topics SET status=?,updated=? WHERE id=? RETURNING id', data.status, now.toISOString(), data.id);
    if (!found) throw new Problem(404, '未找到选题');
    return reply(found);
  }
  if (path === '/zotero') {
    const doi = requireDoi(data.doi);
    if (!s.env.ZOTERO_API_KEY || !s.env.ZOTERO_COLLECTION_KEY || !s.env.ZOTERO_LIBRARY_ID) {
      throw new Problem(422, '服务器尚未配置 Zotero');
    }
    if (!await s.first("SELECT doi FROM papers WHERE doi=? AND status='included'", doi)) throw new Problem(422, '仅已收录条目可写入 Zotero');
    const payload = JSON.stringify({ doi });
    await s.batch([
      s.stmt(`INSERT INTO jobs(id,kind,payload,priority,due) VALUES(?,'zotero',?,6,?)
        ON CONFLICT(id) DO UPDATE SET status='queued',payload=excluded.payload,due=excluded.due,error=NULL,attempts=0
        WHERE jobs.status IN ('done','dead')`, 'zotero:' + doi, payload, now.valueOf()),
      s.stmt(`INSERT INTO zotero_sync(doi,status,updated) VALUES (?,'queued',?)
        ON CONFLICT(doi) DO UPDATE SET status='queued',updated=excluded.updated,error=NULL
        WHERE zotero_sync.status IN ('synced','item_saved','failed') AND
        EXISTS(SELECT 1 FROM jobs WHERE id=? AND status='queued')`, doi, now.toISOString(), 'zotero:' + doi)
    ]);
    return reply({ doi, queued: true }, 202);
  }
  if (path === '/retry') {
    if (typeof data.id !== 'string') throw new Problem(400, '需要任务 ID');
    const reset = await s.first(`UPDATE jobs SET status='queued',attempts=0,due=?,error=NULL
      WHERE id=? AND status='dead' AND kind<>'telegram' RETURNING id`, now.valueOf(), data.id);
    if (!reset) throw new Problem(409, '该任务不可直接重试');
    return reply(reset);
  }
  if (path === '/telegram-reconcile') {
    const period = typeof data.period === 'string' ? data.period : '';
    const stamp = now.toISOString();
    if (data.action === 'sent' && /^\d+$/.test(String(data.messageId))) {
      const row = await s.first(`UPDATE reports SET delivery='sent',telegram_id=?,delivery_error=NULL,delivery_updated=?
        WHERE period=? AND delivery IN ('uncertain','failed') RETURNING period`, String(data.messageId), stamp, period);
      if (!row) throw new Problem(409, '本期无需核对');
      return reply(row);
    }
    if (data.action === 'retry' && data.checkedUndelivered === true && s.env.TELEGRAM_ENABLED === 'true') {
      const [change] = await s.batch([
        s.stmt(`UPDATE reports SET delivery='pending',delivery_error=NULL,delivery_updated=?
          WHERE period=? AND delivery IN ('uncertain','failed') RETURNING period`, stamp, period),
        s.stmt(`UPDATE jobs SET status='queued',attempts=0,due=?,error=NULL WHERE id=? AND status<>'running'
          AND EXISTS(SELECT 1 FROM reports WHERE period=? AND delivery='pending' AND delivery_updated=?)`,
          now.valueOf(), 'telegram:' + period, period, stamp)
      ]);
      if (!change.results.length) throw new Problem(409, '本期无法重新发送');
      return reply({ period, queued: true });
    }
    throw new Problem(400, '需要记录消息 ID，或确认聊天中未收到再重试');
  }
  throw new Problem(404, '未找到接口');
}
