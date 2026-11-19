import { day, normalizeDoi, parse, Problem, rollingStart, shift, TAGS } from './core.mjs';

export const pageNumber = params => Math.min(100000, Math.max(1, Number.parseInt(params.get('page'), 10) || 1));

export async function listPage(s, params, select, args = [], size = 16) {
  const page = pageNumber(params);
  const rows = await s.all(select + ' LIMIT ? OFFSET ?', ...args, size + 1, (page - 1) * size);
  return { rows: rows.slice(0, size), page, more: rows.length > size };
}

const paperColumns = 'p.doi,p.title,p.published,p.authors,p.tags,p.evidence_state,j.name AS journal';
const papersFrom = 'papers p JOIN journals j USING(issn)';
const inWindow = "p.status='included' AND p.published BETWEEN ? AND ?";

export async function research(s, params, now) {
  const upper = day(now);
  const lower = rollingStart(upper);
  const recent = shift(upper, -89);
  const tag = params.get('tag') || null;
  if (tag && !Object.hasOwn(TAGS, tag)) throw new Problem(404, '未找到该研究领域');

  const [counts, sources, directions] = await Promise.all([
    s.all(`SELECT t.value AS tag, count(DISTINCT p.doi) AS count,
      count(DISTINCT CASE WHEN p.published>=? THEN p.doi END) AS recent,
      count(DISTINCT CASE WHEN p.evidence_state='fulltext' THEN p.doi END) AS fulltext
      FROM papers p JOIN json_each(p.tags) t WHERE ${inWindow} GROUP BY t.value`, recent, lower, upper),
    s.all(`SELECT j.issn,j.name,j.fields,j.policy_url,j.tier,?='expanded' OR j.tier='pilot' AS active,
      EXISTS(SELECT 1 FROM search_slices x WHERE x.issn=j.issn AND x.done=1) AS searched FROM journals j ORDER BY j.name`,
    s.env.JOURNAL_TIER ?? 'pilot'),
    listPage(s, new URLSearchParams({ page: params.get('directionPage') ?? '1' }), `SELECT p.doi,p.title,p.published,e.value,e.quote,e.locator,e.source,e.reviewed
      FROM papers p JOIN judgments e USING(doi) WHERE ${inWindow} AND p.published>=?
      AND p.evidence_state='fulltext' AND e.level='fulltext' AND e.origin='author' AND e.field='future'
      AND (? IS NULL OR EXISTS(SELECT 1 FROM json_each(p.tags) WHERE value=?))
      ORDER BY p.published DESC,p.doi,e.reviewed DESC,e.locator,e.value,e.quote`, [lower, upper, recent, tag, tag], 6)
  ]);
  const byTag = new Map(counts.map(row => [row.tag, row]));
  const domains = Object.keys(TAGS).map(key => ({
    tag: key, count: byTag.get(key)?.count ?? 0, recent: byTag.get(key)?.recent ?? 0,
    fulltext: byTag.get(key)?.fulltext ?? 0,
    sources: sources.filter(row => parse(row.fields, []).includes(key)).map(({ fields, ...row }) => row)
  }));
  if (!tag) return { lower, upper, recent, domains, directions };

  const [months, papers, dimensions] = await Promise.all([
    s.all(`SELECT substr(p.published,1,7) AS month,count(*) AS count FROM papers p WHERE ${inWindow}
      AND EXISTS(SELECT 1 FROM json_each(p.tags) WHERE value=?) GROUP BY month ORDER BY month`, lower, upper, tag),
    listPage(s, params, `SELECT ${paperColumns} FROM ${papersFrom}
      WHERE ${inWindow} AND EXISTS(SELECT 1 FROM json_each(p.tags) WHERE value=?)
      ORDER BY p.published DESC,p.doi`, [lower, upper, tag]),
    s.all(`SELECT e.field,e.value,count(DISTINCT p.doi) AS count
      FROM papers p JOIN judgments e USING(doi)
      WHERE ${inWindow} AND p.evidence_state='fulltext' AND e.level='fulltext'
      AND e.field IN ('theory','design','methods') AND EXISTS(SELECT 1 FROM json_each(p.tags) WHERE value=?)
      GROUP BY e.field,e.value ORDER BY count DESC,e.field,e.value LIMIT 18`, lower, upper, tag)
  ]);
  return { lower, upper, recent, domains, directions, months, papers, dimensions };
}

export async function authorProfile(s, params, now) {
  const key = (params.get('author') || '').trim().slice(0, 180);
  const name = (params.get('name') || '').trim().slice(0, 180);
  const identified = /^https:\/\/(?:orcid\.org\/[\dX-]+|openalex\.org\/A\d+)$/i.test(key);
  if ((!identified && key) || !key && !name) throw new Problem(400, '需要有效的作者标识或姓名');
  const upper = day(now);
  const lower = rollingStart(upper);
  const match = `EXISTS(SELECT 1 FROM json_each(p.authors) a WHERE
    (?=1 AND (json_extract(a.value,'$.id')=? OR json_extract(a.value,'$.orcid')=?))
    OR (?=0 AND lower(json_extract(a.value,'$.name'))=lower(?)))`;
  const args = [lower, upper, Number(identified), key, key, Number(identified), name];
  const filter = `${inWindow} AND ${match}`;
  const [papers, summary] = await Promise.all([
    listPage(s, params, `SELECT ${paperColumns} FROM ${papersFrom} WHERE ${filter} ORDER BY p.published DESC,p.doi`, args),
    s.first(`SELECT count(*) AS count FROM papers p WHERE ${filter}`, ...args)
  ]);
  const people = papers.rows.flatMap(row => parse(row.authors, []));
  const display = people.find(person => person.id === key || person.orcid === key)?.name ?? (name || key);
  return { display, identified, count: summary.count, ...papers };
}

export async function paperRelations(s, params) {
  const doi = normalizeDoi(params.get('doi'));
  if (!doi) throw new Problem(400, '需要有效的 DOI');
  const paper = await s.first("SELECT doi,openalex_id,refs FROM papers WHERE doi=?", doi);
  if (!paper) throw new Problem(404, '未找到 DOI');
  const [outgoing, incoming] = await Promise.all([
    listPage(s, params, `SELECT ${paperColumns} FROM ${papersFrom}
      WHERE p.status='included' AND EXISTS(SELECT 1 FROM json_each(?) r WHERE r.value=p.doi OR r.value=p.openalex_id)
      ORDER BY p.published DESC,p.doi`, [paper.refs], 12),
    listPage(s, params, `SELECT ${paperColumns} FROM ${papersFrom}
      WHERE p.status='included' AND EXISTS(SELECT 1 FROM json_each(p.refs) r WHERE r.value=? OR r.value=?)
      ORDER BY p.published DESC,p.doi`, [doi, paper.openalex_id], 12)
  ]);
  return { outgoing, incoming };
}
