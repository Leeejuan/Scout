import { day, enqueueStmt, parse, Problem, rollingStart, shift } from './core.mjs';
import { crossrefUrl, discoveryPageSize, fetchAlex, fromCrossref, fromOpenAlex, makeDiscoveryUrl } from './sources.mjs';
import { acquire, documentStatements } from './documents.mjs';

function abstractJob(s, doi, text, stamp) {
  return enqueueStmt(s, 'extract-abstract:' + doi + ':' + stamp, 'extract', { doi, text }, 55);
}

export function savePaper(s, paper, stamp, refreshKey, priority = 30) {
  const { doi, issn, title, published, publisher, crossref, abstract, authors, citation, refs, tags, regions, status, type } = paper;
  const tag = JSON.stringify(tags);
  const region = JSON.stringify(regions);
  const result = [s.stmt(`DELETE FROM judgments WHERE doi=? AND level='abstract' AND ? IS NOT NULL
    AND EXISTS(SELECT 1 FROM papers WHERE doi=? AND abstract IS NOT ?)`, doi, abstract, doi, abstract),
    s.stmt(`INSERT INTO papers(doi,issn,title,published,publisher_url,crossref_url,authors,citation,
    status,subtype,screening_url,screening_reason,abstract,abstract_source,refs,tags,regions,evidence_state,
    evidence_updated,first_seen,last_verified) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(doi) DO UPDATE SET title=excluded.title,published=excluded.published,publisher_url=excluded.publisher_url,
      citation=excluded.citation,last_verified=excluded.last_verified,
      authors=CASE WHEN excluded.authors='[]' OR papers.openalex_checked IS NOT NULL THEN papers.authors ELSE excluded.authors END,
      status=CASE WHEN excluded.status='excluded' THEN 'excluded' WHEN papers.screening_reviewer IS NOT NULL THEN papers.status
        WHEN papers.status='pending' THEN excluded.status ELSE papers.status END,
      subtype=CASE WHEN excluded.status='excluded' OR papers.status='pending' AND excluded.status='included' THEN excluded.subtype ELSE papers.subtype END,
      screening_url=CASE WHEN excluded.status='excluded' OR papers.status='pending' AND excluded.status='included'
        THEN excluded.screening_url ELSE papers.screening_url END,
      screening_reason=CASE WHEN excluded.status='excluded' OR papers.status='pending' AND excluded.status='included'
        THEN excluded.screening_reason ELSE papers.screening_reason END,
      abstract=COALESCE(excluded.abstract,papers.abstract),
      abstract_source=CASE WHEN excluded.abstract IS NOT NULL THEN excluded.abstract_source ELSE papers.abstract_source END,
      evidence_state=CASE WHEN papers.evidence_state<>'fulltext' AND excluded.abstract IS NOT NULL THEN 'abstract' ELSE papers.evidence_state END,
      evidence_updated=CASE WHEN excluded.status<>'pending' AND papers.status='pending' OR
        excluded.abstract IS NOT NULL AND excluded.abstract IS NOT papers.abstract THEN excluded.evidence_updated ELSE papers.evidence_updated END`,
    doi, issn, title, published, publisher, crossref, JSON.stringify(authors), JSON.stringify(citation), status, type,
    status !== 'pending' ? crossref : null, status !== 'pending' ? 'Crossref 类型或撤稿信息' : '单篇类型待核验',
    abstract, abstract ? crossref : null, JSON.stringify(refs), tag, region, abstract ? 'abstract' : 'record', stamp, stamp, stamp)];
  if (status !== 'excluded') {
    result.push(enqueueStmt(s, 'enrich:' + doi + ':' + refreshKey, 'enrich', { doi, refreshKey, priority }, priority));
  }
  return result;
}

export async function lookup(s, doi, now) {
  const work = (await s.json(crossrefUrl(s, 'works/' + doi.split('/').map(encodeURIComponent).join('/')), 'Crossref')).message;
  const journal = (await s.all('SELECT * FROM journals')).find(entry => work.ISSN?.includes(entry.issn));
  if (!journal) throw new Problem(422, 'DOI 不在已核验期刊清单内');
  const stamp = now.toISOString();
  const paper = fromCrossref(work, journal, rollingStart(day(now)), day(now));
  if (paper.omitted || paper.doi !== doi) throw new Problem(422, 'DOI 无法纳入滚动检索范围');
  await s.batch(savePaper(s, paper, stamp, day(now)));
  return { detail: paper.status === 'excluded' ? 'Crossref 类型已排除' : 'Crossref 题录已保存' };
}

export async function planSearch(s, { id, mode, lower, upper, tier }, now) {
  const journals = await s.all("SELECT issn FROM journals WHERE tier='pilot' OR ?='expanded' ORDER BY issn", tier);
  const issns = journals.map(row => row.issn);
  const slices = [];
  for (let start = lower; start <= upper;) {
    const end = [shift(start, mode === 'update' ? 30 : 89), upper].sort()[0];
    slices.push({ start, end });
    start = shift(end, 1);
  }
  await s.batch([
    s.stmt('INSERT INTO searches VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET journals=excluded.journals', id, mode, now.toISOString(), lower, upper, JSON.stringify(issns)),
    ...(mode === 'backfill' && tier === 'expanded' ? [s.stmt(`INSERT OR IGNORE INTO search_slices(
      search_id,issn,lower_date,upper_date,cursor,pages,returned,omitted,total_expected,omissions,done)
      SELECT ?,x.issn,x.lower_date,x.upper_date,x.cursor,x.pages,x.returned,x.omitted,x.total_expected,x.omissions,x.done
      FROM search_slices x JOIN searches r ON r.id=x.search_id JOIN journals j ON j.issn=x.issn
      WHERE r.mode='backfill' AND r.id LIKE 'backfill:pilot:%' AND r.lower_date=? AND r.upper_date=?
      AND j.tier='pilot' AND x.done=1 AND x.error IS NULL`, id, lower, upper)] : []),
    s.stmt(`INSERT OR IGNORE INTO search_slices(search_id,issn,lower_date,upper_date)
      SELECT ?, j.value,json_extract(d.value,'$.start'),json_extract(d.value,'$.end')
      FROM json_each(?) j CROSS JOIN json_each(?) d`, id, JSON.stringify(issns), JSON.stringify(slices)),
    s.stmt(`INSERT OR IGNORE INTO jobs(id,kind,payload,priority,due)
      SELECT 'discover:'||search_id||':'||issn||':'||lower_date,'discover',json_object(
        'id',search_id,'issn',issn,'lower',lower_date),?,? FROM search_slices WHERE search_id=? AND done=0`,
      mode === 'update' ? 20 : 70, now.valueOf(), id)
  ]);
}

export async function discover(s, { id, issn, lower }, now) {
  const row = await s.first(`SELECT x.*,j.name,j.fields,r.mode,r.started FROM search_slices x
    JOIN searches r ON r.id=x.search_id JOIN journals j ON j.issn=x.issn
    WHERE x.search_id=? AND x.issn=? AND x.lower_date=?`, id, issn, lower);
  if (!row || row.done) return { detail: '检索分片已完成' };
  const searchDay = day(new Date(row.started));
  const rolling = rollingStart(searchDay);
  let result;
  try {
    result = (await s.json(makeDiscoveryUrl(s, row, { mode: row.mode, rolling }), 'Crossref')).message;
  } catch (error) {
    await s.run('UPDATE search_slices SET error=? WHERE search_id=? AND issn=? AND lower_date=?', error.message, id, issn, lower);
    throw error;
  }
  if (!Array.isArray(result?.items)) throw new Problem(502, 'Crossref 页面缺少结果');
  const statements = [];
  const omitted = parse(row.omissions, {});
  let omittedHere = 0;
  for (const record of result.items) {
    const paper = fromCrossref(record, row, rolling, searchDay);
    const reason = paper.omitted ?? (paper.status === 'excluded' ? 'excluded_type' : null);
    if (reason) {
      omitted[reason] = (omitted[reason] ?? 0) + 1;
      omittedHere++;
    }
    if (!paper.omitted) statements.push(...savePaper(s, paper, now.toISOString(), id, row.mode === 'update' ? 25 : 73));
  }
  const offset = (Number(row.cursor) || 0) + result.items.length;
  const expected = Number.isSafeInteger(result['total-results']) ? result['total-results'] : null;
  const capped = offset >= 10000 && (expected ?? offset + 1) > offset;
  const done = capped || result.items.length < discoveryPageSize(s.env) || (expected !== null && offset >= expected);
  statements.push(s.stmt(`UPDATE search_slices SET cursor=?,pages=pages+1,returned=returned+?,omitted=omitted+?,
    omissions=?,total_expected=?,done=?,error=? WHERE search_id=? AND issn=? AND lower_date=?`,
    String(offset), result.items.length, omittedHere, JSON.stringify(omitted), expected, Number(done),
    capped ? 'Crossref offset 上限，需缩短日期分片' : null, id, issn, lower));
  await s.batch(statements);
  return { next: done ? undefined : { id, issn, lower }, detail: '返回 ' + result.items.length + ' 条，记录 ' + omittedHere + ' 项排除／遗漏' };
}

export async function enrich(s, { doi, refreshKey, priority }, now) {
  const paper = await s.first(`SELECT p.*,j.publisher_host FROM papers p JOIN journals j USING(issn) WHERE doi=?`, doi);
  if (!paper || paper.status === 'excluded') return { detail: '条目不存在或已排除' };
  let work;
  let openAlexMissing = false;
  try {
    work = fromOpenAlex(await fetchAlex(s, doi), paper);
  } catch (error) {
    // Crossref content remains usable even when OpenAlex has not indexed this DOI.
    if (error.status !== 404) throw error;
    openAlexMissing = true;
  }
  const at = now.toISOString();
  const abstract = paper.abstract ?? work?.abstract ?? null;
  const source = paper.abstract_source ?? (abstract ? work?.alex : null);
  const existing = parse(paper.authors, []);
  const authors = existing.length ? existing.map(author => {
    const match = work?.authors.find(candidate => candidate.orcid && candidate.orcid === author.orcid ||
      candidate.rawName.toLowerCase() === author.name.toLowerCase() || candidate.name.toLowerCase() === author.name.toLowerCase());
    return match ? { ...match, ...author, orcid: author.orcid ?? match.orcid } : author;
  }) : work?.authors ?? [];
  const ref = [...new Set([...parse(paper.refs, []), ...work?.refs ?? []])].slice(0, 500);
  const isBlocked = Number(Boolean(work?.blocked));
  const statements = [s.stmt(`UPDATE papers SET openalex_checked=?,openalex_id=COALESCE(?,openalex_id),
    oa_locations=COALESCE(?,oa_locations),authors=?,refs=?,cited_count=COALESCE(?,cited_count),
    abstract=COALESCE(abstract,?),abstract_source=COALESCE(abstract_source,?),tags=COALESCE(?,tags),regions=COALESCE(?,regions),
    evidence_state=CASE WHEN evidence_state='record' AND ? IS NOT NULL THEN 'abstract' ELSE evidence_state END,
    status=CASE WHEN ? THEN 'excluded' ELSE status END,screening_url=CASE WHEN ? THEN ? ELSE screening_url END,
    screening_reason=CASE WHEN ? THEN 'OpenAlex 条目类型或撤稿标记' ELSE screening_reason END,
    evidence_updated=CASE WHEN abstract IS NULL AND ? IS NOT NULL THEN ? ELSE evidence_updated END,last_verified=?
    WHERE doi=?`, at, work?.alex ?? null, work ? JSON.stringify(work.locations) : null, JSON.stringify(authors), JSON.stringify(ref),
    work?.cited ?? null, abstract, source, work ? JSON.stringify(work.tags) : null, work ? JSON.stringify(work.regions) : null,
    abstract, isBlocked, isBlocked, work?.alex ?? null, isBlocked, abstract, at, at, doi)];
  if (abstract && source && !isBlocked && (abstract !== paper.abstract || !await s.first(
    "SELECT id FROM jobs WHERE kind='extract' AND json_extract(payload,'$.doi')=? AND json_extract(payload,'$.text')=? AND status<>'dead' LIMIT 1",
    doi, abstract))) {
    statements.push(abstractJob(s, doi, abstract, at));
  }
  const open = work?.locations.some(loc => ['publishedVersion', 'acceptedVersion'].includes(loc.version)) ?? false;
  if (!isBlocked && (paper.status === 'pending' || (open || work?.pmcid) && paper.evidence_state !== 'fulltext')) {
    statements.push(enqueueStmt(s, 'fulltext:' + doi + ':' + refreshKey, 'fulltext', {
      doi, refreshKey, pmcid: work?.pmcid, tei: work?.tei, open, host: paper.publisher_host
    }, priority + 1));
  }
  await s.batch(statements);
  return { detail: openAlexMissing ? 'OpenAlex 未收录，保留 Crossref 题录' : 'OpenAlex 核验完成' };
}

export async function fulltext(s, options, now) {
  const paper = await s.first('SELECT * FROM papers WHERE doi=?', options.doi);
  if (!paper || paper.status === 'excluded' || paper.evidence_state === 'fulltext' && paper.status !== 'pending') {
    return { detail: '无需重新取得正文' };
  }
  const result = await acquire(s, paper, options, now);
  if (!result.screening) return { detail: result.reason };
  const stamp = now.toISOString();
  const statements = [];
  if (result.screening.status !== 'pending') {
    statements.push(s.stmt(`UPDATE papers SET status=?,subtype=?,screening_url=?,screening_reason=?,
      evidence_updated=?,last_verified=? WHERE doi=? AND (status='pending' OR ?='excluded' AND screening_reviewer IS NULL)`,
      result.screening.status, result.screening.type, result.screeningSource ?? result.source, '出版社／JATS 单篇类型', stamp, stamp, paper.doi, result.screening.status));
  }
  const doc = await s.first('SELECT doi FROM documents WHERE doi=?', paper.doi);
  if (!doc && result.open && result.passages.length >= 3 && result.screening.status !== 'excluded') {
    const size = result.passages.reduce((sum, block) => sum + block.content.length, 0);
    const coverage = size >= 2500 && new Set(result.passages.map(block => block.locator)).size >= 3 ? 'body' : 'excerpt';
    if (result.passages.length <= 144) statements.push(...documentStatements(s, paper.doi, result.source, result.format, coverage, result.passages, stamp));
  }
  await s.batch(statements);
  return { detail: doc ? '保留已导入正文' : result.format + ' 类型已检查，获取 ' + result.passages.length + ' 段' };
}
