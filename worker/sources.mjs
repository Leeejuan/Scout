import { classify, doiUrl, httpsUrl, normalizeDoi, plain, Problem } from './core.mjs';

const excluded = /\b(?:editorial|book[ -]review|review essay|commentary|commentaries|errat(?:a|um)|corrigendum|correction|retraction|preprint|expression of concern|letter to the editor|masthead|obituary|announcement|call for papers|front matter)\b/i;

export function screenType(label) {
  const text = plain(label).toLowerCase().replaceAll('-', ' ');
  if (excluded.test(text)) return { status: 'excluded', type: text };
  if (/^(?:original(?: research)? articles?|research articles?|articles? of original research|original research|full length (?:research )?articles?|empirical articles?|registered reports?|replication notes?)$/.test(text)) return { status: 'included', type: text };
  if (/^(?:systematic reviews?|meta[ -]?analys[ie]s|review articles?|scoping reviews?|theoretical articles?|conceptual articles?)$/.test(text)) return { status: 'included', type: text };
  return { status: 'pending', type: text || null };
}

function dates(item) {
  const parts = [item['published-online'], item.published, item.issued, item['published-print']]
    .find(value => value?.['date-parts']?.[0]?.[0])?.['date-parts'][0];
  if (!parts) return null;
  const [year, month = 1, date = 1] = parts;
  return [year, String(month).padStart(2, '0'), String(date).padStart(2, '0')].join('-');
}

export function fromCrossref(item, journal, lower, upper) {
  const doi = normalizeDoi(item.DOI);
  const title = plain(item.title?.[0]).slice(0, 1000);
  const published = dates(item);
  if (!doi || !title || !published || !item.ISSN?.includes(journal.issn)) return { omitted: 'metadata' };
  if (published < lower || published > upper) return { omitted: 'outside_rolling_window' };
  const publisher = httpsUrl(item.resource?.primary?.URL) ?? doiUrl(doi);
  const crossref = 'https://api.crossref.org/works/' + doi.split('/').map(encodeURIComponent).join('/');
  const abstract = plain(item.abstract).slice(0, 14000) || null;
  const declared = item.assertion?.find(entry => /^(?:content|article|document)[ _-]?type$/i.test(entry.name ?? '') || /^(?:article|content|document) type$/i.test(entry.label ?? ''))?.value;
  let screening = screenType(declared ?? item.subtype);
  if (item.type !== 'journal-article' || item['update-to']?.length || item['updated-by']?.some(update => /retract/i.test(update.type ?? '')) || excluded.test(title.split(':')[0]) && /^(?:book review|editorial|erratum|corrigendum|correction(?: to)?|retraction(?: of)?|expression of concern|obituary|call for papers)\b/i.test(title)) {
    screening = { status: 'excluded', type: item.type !== 'journal-article' ? item.type : 'non-research or update notice' };
  }
  const authors = item.author?.slice(0, 160).map(person => ({
    given: person.given ?? '', family: person.family ?? '', name: person.name ?? [person.given, person.family].filter(Boolean).join(' '),
    orcid: httpsUrl(person.ORCID)
  })).filter(person => person.name) ?? [];
  const citation = { volume: item.volume, issue: item.issue, pages: item.page, article: item['article-number'],
    datePrecision: [item['published-online'], item.published, item.issued, item['published-print']].find(entry => entry?.['date-parts']?.[0]?.[0])?.['date-parts'][0].length };
  const refs = (item.reference ?? []).map(entry => normalizeDoi(entry.DOI)).filter(Boolean).slice(0, 200);
  return { doi, issn: journal.issn, title, published, publisher, crossref, abstract, authors, citation, refs,
    ...classify(title, abstract), ...screening };
}

export function abstractFromIndex(index) {
  if (!index || typeof index !== 'object') return null;
  const words = [];
  for (const [word, positions] of Object.entries(index)) {
    for (const position of positions) {
      if (Number.isInteger(position) && position >= 0 && position < 5000) words[position] = word;
    }
  }
  return words.join(' ').trim().slice(0, 14000) || null;
}

export function fromOpenAlex(work, paper) {
  if (normalizeDoi(work.doi) !== paper.doi) throw new Problem(502, 'OpenAlex DOI 不匹配');
  const abstract = abstractFromIndex(work.abstract_inverted_index);
  const alex = /^https:\/\/openalex\.org\/W\d+$/.test(work.id) ? work.id : null;
  const authors = (work.authorships ?? []).slice(0, 160).map(entry => ({
    name: entry.author?.display_name ?? '', id: httpsUrl(entry.author?.id), orcid: httpsUrl(entry.author?.orcid),
    affiliationCountries: entry.countries ?? [], rawName: entry.raw_author_name ?? ''
  })).filter(author => author.name);
  const locations = [];
  const seen = new Set();
  for (const loc of [work.best_oa_location, ...(work.locations ?? [])]) {
    if (!loc?.is_oa) continue;
    const landing = httpsUrl(loc.landing_page_url);
    const pdf = httpsUrl(loc.pdf_url);
    const key = landing + '|' + pdf;
    if ((!landing && !pdf) || seen.has(key)) continue;
    seen.add(key);
    locations.push({ landing, pdf, license: loc.license, version: loc.version, source: alex });
  }
  const pmcid = String(work.ids?.pmcid ?? '').match(/\bPMC\d+\b/i)?.[0]?.toUpperCase();
  const blocked = work.is_retracted || /^(?:editorial|erratum|retraction|paratext|letter|book-review|preprint|peer-review)$/i.test(work.type ?? '');
  const topics = (work.topics ?? []).slice(0, 5).map(topic => topic.display_name).filter(Boolean);
  const tei = httpsUrl(work.content_urls?.grobid_xml);
  return { abstract, alex, authors, tei, locations: locations.slice(0, 12), pmcid, blocked, cited: work.cited_by_count ?? null,
    refs: (work.referenced_works ?? []).filter(value => /^https:\/\/openalex\.org\/W\d+$/.test(value)).slice(0, 400),
    ...classify(paper.title, paper.abstract ?? abstract, topics) };
}

export function crossrefUrl(s, tail) {
  const url = new URL('https://api.crossref.org/' + tail);
  if (s.env.CROSSREF_MAILTO) url.searchParams.set('mailto', s.env.CROSSREF_MAILTO);
  return url;
}

export function fetchAlex(s, doi) {
  const url = new URL('https://api.openalex.org/works/' + doiUrl(doi));
  url.searchParams.set('select', 'id,doi,ids,type,abstract_inverted_index,authorships,best_oa_location,locations,referenced_works,cited_by_count,is_retracted,topics,content_urls');
  return s.json(url, 'OpenAlex', s.env.OPENALEX_API_KEY ? { headers: { Authorization: 'Bearer ' + s.env.OPENALEX_API_KEY } } : {});
}

export function discoveryPageSize(env) {
  const size = Number(env.CROSSREF_PAGE_ROWS ?? 6);
  return Number.isInteger(size) && size >= 1 && size <= 6 ? size : 6;
}

export function makeDiscoveryUrl(s, slice, search, offset = Number(slice.cursor === '*' ? 0 : slice.cursor)) {
  const url = crossrefUrl(s, 'journals/' + slice.issn + '/works');
  const prefix = search.mode === 'update' ? 'index' : 'pub';
  const filter = ['from-' + prefix + '-date:' + slice.lower_date, 'until-' + prefix + '-date:' + slice.upper_date];
  if (search.mode === 'update') filter.push('from-pub-date:' + search.rolling);
  url.searchParams.set('filter', filter.join(','));
  url.searchParams.set('rows', String(discoveryPageSize(s.env)));
  url.searchParams.set('offset', String(offset));
  url.searchParams.set('sort', search.mode === 'update' ? 'indexed' : 'published');
  url.searchParams.set('order', 'asc');
  url.searchParams.set('select', 'DOI,title,author,ISSN,abstract,published,published-online,issued,published-print,resource,type,assertion,update-to,updated-by,volume,issue,page,article-number,reference');
  return url;
}

