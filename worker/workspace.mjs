import { day, normalizeDoi, parse, Problem, rollingStart, TAGS } from './core.mjs';
import { hash, relationships, topicFields } from './reports.mjs';

export const ISSUES = {
  'mediated-ai': ['artificial intelligence','ai-mediated','generative ai','chatbot','人工智能','生成式'],
  'platform-algorithms': ['algorithm','recommender','content moderation','算法','推荐系统'],
  'information-integrity': ['misinformation','disinformation','fact-check','fake news','错误信息','虚假信息'],
  'privacy': ['privacy','surveillance','self-disclosure','隐私','监控','自我披露'],
  'participation': ['political participation','political efficacy','civic engagement','政治参与','政治效能'],
  'wellbeing': ['mental health','well-being','wellbeing','心理健康','福祉'],
  'representation': ['representation','framing','cultural identity','媒介表征','文化认同'],
  'brand-trust': ['brand','advertising','consumer trust','品牌','广告','消费者信任']
};

const issueClause = key => ISSUES[key].map(() => "instr(lower(p.title||' '||coalesce(p.abstract,'')),?)>0").join(' OR ');

export function paperScope(params, now) {
  const upper = day(now);
  const lower = rollingStart(upper);
  const terms = ['p.published BETWEEN ? AND ?'];
  const args = [lower, upper];
  const tag = params.get('tag');
  const topic = params.get('topic');
  const region = params.get('region');
  const state = params.get('state');
  const month = params.get('month');
  const issn = params.get('issn');
  if (Object.hasOwn(TAGS, tag)) {
    terms.push('EXISTS(SELECT 1 FROM json_each(p.tags) WHERE value=?)');
    args.push(tag);
  }
  if (Object.hasOwn(ISSUES, topic)) {
    terms.push('(' + issueClause(topic) + ')');
    args.push(...ISSUES[topic]);
  }
  if (['CN','MY','SEA'].includes(region)) {
    terms.push('EXISTS(SELECT 1 FROM json_each(p.regions) WHERE value=?)');
    args.push(region);
  }
  if (['record','abstract','fulltext'].includes(state)) {
    terms.push('p.evidence_state=?');
    args.push(state);
  }
  if (/^\d{4}-(?:0[1-9]|1[0-2])$/.test(month ?? '')) {
    terms.push('substr(p.published,1,7)=?');
    args.push(month);
  }
  if (/^\d{4}-\d{3}[\dX]$/.test(issn ?? '')) {
    terms.push('p.issn=?');
    args.push(issn);
  }
  return { lower, upper, where: terms.join(' AND '), args };
}

const decodePaper = row => ({
  ...row, authors: parse(row.authors, []), tags: parse(row.tags, []), refs: parse(row.refs, [])
});
const paperColumns = 'p.doi,p.title,p.published,p.issn,p.evidence_state,p.publisher_url,p.authors,p.tags,p.refs,p.openalex_id,j.name AS journal';
const claimColumns = 'e.doi,e.field,e.value,e.quote,e.locator,e.source,e.level,e.origin,e.reviewed';
const fullEvidence = "e.level='fulltext' AND (e.reviewed=1 OR e.field<>'findings' OR lower(e.locator) LIKE '%result%' OR lower(e.locator) LIKE '%finding%' OR e.locator LIKE '%结果%' OR e.locator LIKE '%发现%')";
const reportableFindings = "p.evidence_state='fulltext' AND EXISTS(SELECT 1 FROM judgments e WHERE e.doi=p.doi AND e.field='findings' AND " + fullEvidence + ")";
const reportableDirections = "p.evidence_state='fulltext' AND EXISTS(SELECT 1 FROM judgments e WHERE e.doi=p.doi AND e.field='future' AND e.level='fulltext')";

export async function workspace(s, params, now) {
  const section = params.get('section');
  if (!['map','evidence','gaps','people'].includes(section)) throw new Problem(400, '工作台页面无效');
  const { lower, upper, where, args } = paperScope(params, now);
  const scope = "p.status='included' AND " + where;
  const [counts, journals] = await Promise.all([
    s.first(`SELECT count(*) AS included,count(DISTINCT p.issn) AS represented,
      count(CASE WHEN p.evidence_state='abstract' THEN 1 END) AS abstracts,
      count(CASE WHEN p.evidence_state='record' THEN 1 END) AS records,
      count(CASE WHEN p.evidence_state='fulltext' THEN 1 END) AS fulltext,
      count(CASE WHEN ${reportableFindings} THEN 1 END) AS findings,
      count(CASE WHEN ${reportableDirections} THEN 1 END) AS directions
      FROM papers p WHERE ${scope}`, ...args),
    s.all("SELECT issn,name FROM journals WHERE tier='pilot' OR ?='expanded' ORDER BY name",
      s.env.JOURNAL_TIER ?? 'pilot')
  ]);
  const base = { lower, upper, counts, journals };
  if (section === 'map') {
    const topics = Object.keys(ISSUES);
    const [domains, hits] = await Promise.all([
      s.all(`SELECT t.value AS key,count(*) AS count,sum(p.evidence_state='fulltext') AS fulltext
        FROM papers p JOIN json_each(p.tags) t WHERE ${scope} GROUP BY key`, ...args),
      s.first(`SELECT ${topics.map((key, i) => `count(CASE WHEN (${issueClause(key)}) THEN 1 END) AS topic${i}`).join(',')}
        FROM papers p WHERE ${scope}`, ...topics.flatMap(key => ISSUES[key]), ...args)
    ]);
    return { ...base, domains: domains.filter(row => Object.hasOwn(TAGS, row.key)),
      topics: topics.map((key, i) => ({ key, count: hits['topic' + i] })) };
  }
  if (section === 'people') {
    const limit = 24;
    const rows = await s.all(`SELECT ${paperColumns} FROM papers p JOIN journals j USING(issn)
      WHERE ${scope} ORDER BY p.published DESC,p.doi LIMIT ?`, ...args, limit);
    const papers = rows.map(decodePaper);
    return { ...base, limit, papers: papers.map(({ refs, openalex_id, ...row }) => row),
      relationships: relationships(papers) };
  }
  const limit = 12;
  const priority = section === 'gaps' ? reportableDirections : reportableFindings;
  const papers = await s.all(`SELECT p.doi,p.title,p.published,p.evidence_state,j.name AS journal
    FROM papers p JOIN journals j USING(issn) WHERE ${scope} ORDER BY
    (${priority}) DESC,p.evidence_state='fulltext' DESC,p.published DESC,p.doi LIMIT ?`, ...args, limit);
  const claims = await s.all(`SELECT * FROM (
    SELECT ${claimColumns},row_number() OVER (PARTITION BY e.doi,e.field ORDER BY e.reviewed DESC,e.locator,e.value) AS rank
    FROM judgments e JOIN papers p USING(doi)
    WHERE p.evidence_state='fulltext' AND e.doi IN(SELECT value FROM json_each(?))
    AND e.field IN ('findings','future','limitations') AND ${fullEvidence}
    ) WHERE rank<=2 ORDER BY doi,field,rank`, JSON.stringify(papers.map(p => p.doi)));
  return { ...base, limit, papers, claims };
}

export function selectedDois(raw, limit = 4) {
  const values = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(/[\s,，]+/) : [];
  const normalized = [...new Set(values.map(normalizeDoi).filter(Boolean))];
  if (normalized.length > limit || values.some(value => String(value).trim() && !normalizeDoi(value))) {
    throw new Problem(400, '请填写有效 DOI，最多 ' + limit + ' 篇');
  }
  return normalized;
}

export async function comparison(s, params) {
  const dois = selectedDois(params.getAll('doi'));
  if (!dois.length) return { papers: [], claims: [] };
  const json = JSON.stringify(dois);
  const [papers, claims] = await Promise.all([
    s.all(`SELECT ${paperColumns},p.abstract,p.abstract_source,d.source AS document_source,${reportableFindings} AS has_findings
      FROM papers p JOIN journals j USING(issn) LEFT JOIN documents d USING(doi)
      WHERE p.status='included' AND p.doi IN(SELECT value FROM json_each(?))`, json),
    s.all(`SELECT * FROM (
      SELECT ${claimColumns},row_number() OVER (PARTITION BY e.doi,e.field
        ORDER BY e.reviewed DESC,e.level='fulltext' DESC,e.locator,e.value) AS rank
      FROM judgments e JOIN papers p USING(doi) WHERE p.status='included'
      AND e.doi IN(SELECT value FROM json_each(?))
      ) WHERE rank<=3 ORDER BY doi,field,rank`, json)
  ]);
  if (papers.length !== dois.length) throw new Problem(422, '只能对照已正式收录的论文');
  return { papers: dois.map(doi => {
    const { refs, openalex_id, ...row } = decodePaper(papers.find(p => p.doi === doi));
    return row;
  }), claims };
}

const classifications = new Set(['observation','consensus','disagreement','gap']);
export async function personalEntries(s, owner) {
  return (await s.all('SELECT id,kind,content,created,updated FROM workspace_entries WHERE owner=? ORDER BY updated DESC,id LIMIT 120',
    owner)).map(row => ({ ...row, content: parse(row.content, {}) }));
}

export async function savePersonalEntry(s, owner, data, now) {
  const kind = data.kind;
  const dois = selectedDois(data.dois, kind === 'topic' ? 16 : 4);
  if (!dois.length) throw new Problem(400, '至少关联一篇正式收录论文');
  const json = JSON.stringify(dois);
  const papers = await s.all(`SELECT p.doi,p.title,${reportableFindings} AS has_findings FROM papers p
    WHERE p.status='included' AND p.doi IN(SELECT value FROM json_each(?))`, json);
  if (papers.length !== dois.length) throw new Problem(422, '保存依据须来自正式证据库');

  let content;
  if (kind === 'topic') {
    const fields = topicFields(data);
    if (!fields) throw new Problem(400, '请填写完整的选题卡');
    content = fields;
  } else if (kind === 'judgment') {
    const text = typeof data.text === 'string' ? data.text.trim() : '';
    const classification = data.classification;
    if (!classifications.has(classification) || !text || text.length > 2400) throw new Problem(400, '请填写研究判断及类型（最多 2,400 字符）');
    if (['consensus','disagreement'].includes(classification) && papers.filter(row => row.has_findings).length < 2) {
      throw new Problem(422, '共识或分歧至少需要两篇有正文发现的论文。现有材料可保存为待验证判断。');
    }
    const finding = await s.all(`SELECT * FROM (
      SELECT ${claimColumns},row_number() OVER(PARTITION BY e.doi ORDER BY e.reviewed DESC,e.locator,e.value) AS rank
      FROM judgments e JOIN papers p USING(doi) WHERE p.evidence_state='fulltext'
      AND e.field='findings' AND ${fullEvidence} AND e.doi IN(SELECT value FROM json_each(?))
      ) WHERE rank=1`, json);
    content = { text, classification, evidence: finding };
  } else throw new Problem(400, '个人条目类型无效');
  content.dois = dois;
  const stamp = now.toISOString();
  if (typeof data.id === 'string') {
    const changed = await s.first('UPDATE workspace_entries SET content=?,updated=? WHERE owner=? AND id=? AND kind=? RETURNING id',
      JSON.stringify(content), stamp, owner, data.id, kind);
    if (!changed) throw new Problem(404, '未找到个人条目');
    return changed;
  }
  const id = (await hash(JSON.stringify([kind, content.title ?? content.text, [...dois].sort()]))).slice(0, 32);
  const row = await s.first(`INSERT INTO workspace_entries(owner,id,kind,content,created,updated)
    SELECT ?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM workspace_entries WHERE owner=? AND id=?) OR
    (SELECT count(*) FROM workspace_entries WHERE owner=?)<120
    ON CONFLICT(owner,id) DO UPDATE SET content=excluded.content,updated=excluded.updated RETURNING id`,
    owner, id, kind, JSON.stringify(content), stamp, stamp, owner, id, owner);
  if (!row) throw new Problem(409, '个人工作台已达 120 条，请编辑已有条目');
  return row;
}
