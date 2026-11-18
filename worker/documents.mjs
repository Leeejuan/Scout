import { day, enqueueStmt, httpsUrl, limitedText, normalizeDoi, plain, Problem } from './core.mjs';
import { screenType } from './sources.mjs';

const MAX_INPUT = 220000;
const MAX_CHARS = 2600;

export function makePassages(sections) {
  const passages = [];
  for (const section of sections) {
    let body = String(section.content ?? '').replace(/\s+/g, ' ').trim();
    const locator = String(section.locator ?? '').trim().slice(0, 160) || '正文';
    const last = passages.at(-1);
    if (!body) continue;
    if (last?.locator === locator && last.content.length + body.length + 1 <= MAX_CHARS) {
      last.content += ' ' + body;
      continue;
    }
    while (body.length) {
      const boundary = body.length > MAX_CHARS ? body.lastIndexOf(' ', MAX_CHARS) : body.length;
      const end = boundary > MAX_CHARS / 2 || body.length <= MAX_CHARS ? boundary : MAX_CHARS;
      passages.push({ locator, content: body.slice(0, end) });
      body = body.slice(end).trimStart();
    }
  }
  return passages;
}

export function localText(text) {
  if (typeof text !== 'string' || new TextEncoder().encode(text).byteLength > MAX_INPUT) {
    throw new Problem(413, '正文文本限 220 KB');
  }
  const pages = text.split('\f');
  const sections = [];
  for (let i = 0; i < pages.length; i++) {
    let locator = pages.length > 1 ? 'PDF 页 ' + (i + 1) : '正文';
    let lines = [];
    for (const line of pages[i].split(/\r?\n/)) {
      const heading = /^#{1,4}\s+(.{1,140})\s*$/.exec(line);
      if (heading) {
        sections.push({ locator, content: lines.join('\n') });
        locator = (pages.length > 1 ? 'PDF 页 ' + (i + 1) + ' · ' : '') + heading[1];
        lines = [];
      } else {
        lines.push(line);
      }
    }
    sections.push({ locator, content: lines.join('\n') });
  }
  return makePassages(sections);
}

export function parseJats(xml, doi) {
  const front = xml.slice(0, xml.indexOf('<body'));
  const doiValue = /<article-id\s+[^>]*pub-id-type=["']doi["'][^>]*>([^<]+)<\/article-id>/i.exec(front)?.[1];
  if (normalizeDoi(doiValue) !== doi) return null;
  const type = /<article\b[^>]*\barticle-type=["']([^"']+)/i.exec(front)?.[1];
  const body = /<body(?:\s[^>]*)?>([\s\S]*?)<\/body>/i.exec(xml)?.[1] ?? '';
  const sections = [];
  let locator = '正文';
  for (const match of body.matchAll(/<(title|p)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/gi)) {
    const content = plain(match[2]);
    if (match[1].toLowerCase() === 'title') locator = content;
    else if (content) sections.push({ locator, content });
  }
  return { screening: screenType(type), passages: makePassages(sections) };
}

export async function parsePublisher(html, doi, host) {
  if (typeof HTMLRewriter !== 'function') return null;
  let observed = null;
  let category = '';
  let locator = '正文';
  const sections = [];
  let paragraph = '';
  let heading = '';
  const rewriter = new HTMLRewriter()
    .on('meta[name="citation_doi"]', { element(el) { observed = el.getAttribute('content'); } })
    .on('meta[name="citation_article_type"],meta[name="dc.type"]', { element(el) {
      const label = el.getAttribute('content');
      if (screenType(label).status !== 'pending') category = label;
    } })
    .on(host === 'academic.oup.com' ? '.article-metadata .article-type, .article-categories .article-category, .article-metadata .article-category, .xml-article-type' : '.item.issue .value', {
      text(chunk) { category += chunk.text; }
    });
  if (host === 'academic.oup.com') {
    rewriter
      .on('.article-body h2, .article-body h3, .article-body h4', { text(chunk) {
        heading += chunk.text;
        if (chunk.lastInTextNode && heading.trim()) { locator = heading.trim(); heading = ''; }
      } })
      .on('.article-body .chapter-para, .article-body p', { element(el) {
        paragraph = '';
        el.onEndTag(() => {
          if (paragraph.trim()) sections.push({ locator, content: paragraph });
          paragraph = '';
        });
      }, text(chunk) { paragraph += chunk.text; } });
  }
  const output = rewriter.transform(new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } }));
  for await (const _ of output.body) { /* Consume the transformed stream. */ }
  if (normalizeDoi(observed) !== doi) return null;
  return { screening: screenType(category), passages: makePassages(sections) };
}

export function parseTei(xml, doi) {
  const header = /<teiHeader\b[^>]*>([\s\S]*?)<\/teiHeader>/i.exec(xml)?.[1] ?? '';
  const reportedDoi = /<idno\b[^>]*type=["']DOI["'][^>]*>([^<]+)<\/idno>/i.exec(header)?.[1];
  if (normalizeDoi(reportedDoi) !== doi) return null;
  const body = /<body(?:\s[^>]*)?>([\s\S]*?)<\/body>/i.exec(xml)?.[1] ?? '';
  let locator = '正文';
  const sections = [];
  for (const match of body.matchAll(/<(head|p)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/gi)) {
    const text = plain(match[2]);
    if (match[1].toLowerCase() === 'head') locator = text;
    else if (text) sections.push({ locator, content: text });
  }
  return makePassages(sections);
}

async function alexTei(s, paper, url, now) {
  const maximum = Number(s.env.OPENALEX_FULLTEXT_MAX_DAILY ?? 0);
  if (!s.env.OPENALEX_API_KEY || !/^https:\/\/content\.openalex\.org\/works\/W\d+\.grobid-xml$/.test(url ?? '') ||
      !Number.isInteger(maximum) || maximum < 1) return null;
  const budget = await s.first(`INSERT INTO oa_budget(utc_day,downloads) VALUES (?,1)
    ON CONFLICT(utc_day) DO UPDATE SET downloads=downloads+1 WHERE downloads<? RETURNING downloads`, day(now), Math.min(maximum, 30));
  if (!budget) return null;
  const response = await s.request(url, { headers: { Authorization: 'Bearer ' + s.env.OPENALEX_API_KEY } });
  if (!response.ok) return null;
  const passages = parseTei(await limitedText(response, 550000), paper.doi);
  return passages?.length ? { source: url, screening: { status: 'pending' }, format: 'tei', passages, open: true } : null;
}

export async function acquire(s, paper, options, now) {
  let reason = '无可自动处理的开放正文位置';
  if (options.pmcid) {
    const url = 'https://www.ebi.ac.uk/europepmc/webservices/rest/' + options.pmcid + '/fullTextXML';
    const response = await s.request(url);
    if (response.ok) {
      const result = parseJats(await limitedText(response, 500000), paper.doi);
      if (result) return { ...result, source: url, format: 'jats', open: true };
      reason = 'JATS DOI 或正文无法核验';
    } else if (response.status === 429 || response.status >= 500) {
      throw new Problem(response.status, 'Europe PMC HTTP ' + response.status);
    }
  }
  const url = httpsUrl(paper.publisher_url);
  let htmlResult;
  if (url && new URL(url).hostname === options.host && ['academic.oup.com', 'ejournal.ukm.my'].includes(options.host) &&
      (options.open || paper.status === 'pending')) {
    try {
      const response = await s.request(url);
      if (response.ok && /text\/html/i.test(response.headers.get('content-type') ?? '')) {
        const result = await parsePublisher(await limitedText(response, 650000), paper.doi, options.host);
        if (result) htmlResult = { ...result, source: url, format: 'html', open: options.open };
        else reason = '出版社 HTML 未能核对 DOI';
      } else {
        await response.body?.cancel();
        reason = '出版社 HTML 未取得（HTTP ' + response.status + '）';
      }
    } catch (error) {
      if (!(error instanceof Problem)) throw error;
      reason = error.message;
    }
  }
  if (htmlResult?.screening.status === 'excluded' || htmlResult?.open && htmlResult.passages.length >= 3) return htmlResult;
  if (options.open) {
    try {
      const result = await alexTei(s, paper, options.tei, now);
      if (result) return { ...result, screening: htmlResult?.screening ?? result.screening, screeningSource: htmlResult?.source };
    } catch (error) {
      if (!(error instanceof Problem)) throw error;
      reason = error.message;
    }
  }
  return htmlResult ?? { status: 'unavailable', reason };
}

export function documentStatements(s, doi, source, format, coverage, passages, stamp) {
  if (!passages.length || passages.length > 144) throw new Problem(400, '正文需包含 1–144 段可定位文本');
  return [
    s.stmt(`INSERT INTO documents VALUES (?,?,?,?,?) ON CONFLICT(doi) DO UPDATE SET
      source=excluded.source,format=excluded.format,coverage=excluded.coverage,imported=excluded.imported`, doi, source, format, coverage, stamp),
    s.stmt('DELETE FROM passages WHERE doi=?', doi),
    s.stmt("DELETE FROM judgments WHERE doi=? AND level='fulltext'", doi),
    s.stmt(`INSERT INTO passages(doi,ordinal,locator,content)
      SELECT ?,CAST(key AS INTEGER),json_extract(value,'$.locator'),json_extract(value,'$.content') FROM json_each(?)`,
      doi, JSON.stringify(passages.map(({ content, locator }) => ({ content, locator })))),
    s.stmt(`UPDATE papers SET evidence_state=CASE WHEN ?='body' THEN 'fulltext'
      WHEN abstract IS NOT NULL THEN 'abstract' ELSE 'record' END,evidence_updated=? WHERE doi=?`, coverage, stamp, doi),
    enqueueStmt(s, 'extract-body:' + doi + ':' + stamp, 'extract', { doi, revision: stamp, ordinal: 0 }, 60)
  ];
}
