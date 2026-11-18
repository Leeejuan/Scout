import { FIELDS, limitedText, normalizeDoi, parse, Problem } from './core.mjs';

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function config(env) {
  const type = env.ZOTERO_LIBRARY_TYPE ?? 'users';
  const id = env.ZOTERO_LIBRARY_ID;
  const collection = env.ZOTERO_COLLECTION_KEY;
  if (!env.ZOTERO_API_KEY || !['users','groups'].includes(type) || !/^\d+$/.test(id ?? '') || !/^[A-Z0-9]{8}$/.test(collection ?? '')) {
    throw new Problem(422, 'Zotero API 密钥、库 ID 或收藏夹配置缺失');
  }
  return { path: 'https://api.zotero.org/' + type + '/' + id, collection,
    headers: { 'Zotero-API-Version': '3', 'Zotero-API-Key': env.ZOTERO_API_KEY } };
}

async function call(s, settings, path, method = 'GET', body, version) {
  const headers = { ...settings.headers };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (version != null) headers['If-Unmodified-Since-Version'] = version;
  const res = await s.request(settings.path + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const delay = Number(res.headers.get('Retry-After') ?? res.headers.get('Backoff')) * 1000;
  if (!res.ok) throw new Problem(res.status, 'Zotero HTTP ' + res.status, delay);
  const modified = res.headers.get('Last-Modified-Version');
  if (!/^\d+$/.test(modified ?? '')) throw new Problem(502, 'Zotero 未提供库版本，无法核对写入');
  return { version: modified, data: res.status === 204 ? null : JSON.parse(await limitedText(res, 1500000)),
    hasNext: /rel="next"/.test(res.headers.get('link') ?? ''), delay };
}

function keyOfCreated(result) {
  const key = result.data?.successful?.['0']?.key ?? result.data?.success?.['0'] ?? result.data?.unchanged?.['0'];
  if (!/^[A-Z0-9]{8}$/.test(key ?? '')) throw new Problem(502, 'Zotero 未确认对象写入');
  return key;
}

function article(paper, collection) {
  const citation = parse(paper.citation, {});
  const creators = parse(paper.authors, []).map(author => author.family
    ? { creatorType: 'author', firstName: author.given ?? '', lastName: author.family }
    : { creatorType: 'author', name: author.name });
  return { itemType: 'journalArticle', title: paper.title, DOI: paper.doi, publicationTitle: paper.journal,
    date: paper.published.slice(0, citation.datePrecision === 1 ? 4 : citation.datePrecision === 2 ? 7 : 10),
    url: paper.publisher_url, ISSN: paper.issn, volume: citation.volume ?? '', issue: citation.issue ?? '',
    pages: citation.pages ?? citation.article ?? '', creators, collections: [collection], tags: [], relations: {} };
}

async function register(s, doi, status, item, note, now) {
  await s.run(`UPDATE zotero_sync SET status=?,item_key=COALESCE(?,item_key),note_key=COALESCE(?,note_key),
    updated=?,error=NULL WHERE doi=?`, status, item, note, now.toISOString(), doi);
}

export async function zotero(s, { doi, offset = 0, snapshot = null }, now) {
  const settings = config(s.env);
  const paper = await s.first(`SELECT p.*,j.name AS journal FROM papers p JOIN journals j USING(issn)
    WHERE p.doi=? AND p.status='included'`, doi);
  if (!paper) throw new Problem(422, '仅已收录条目可写入 Zotero');
  const previous = await s.first('SELECT item_key FROM zotero_sync WHERE doi=?', doi);
  let found;
  let version;
  let delay = 0;
  if (previous?.item_key) {
    try {
      const response = await call(s, settings, '/items/' + previous.item_key);
      if (normalizeDoi(response.data?.data?.DOI) === doi) {
        found = response.data;
        version = response.version;
        delay = response.delay;
      }
    } catch (error) {
      if (error.status !== 404) throw error;
    }
  }
  if (!found) {
    const response = await call(s, settings, '/items/top?limit=25&include=data&sort=dateAdded&direction=asc&start=' + offset);
    version = response.version;
    delay = response.delay;
    if (snapshot !== null && version !== snapshot) {
      return { next: { doi }, retry: now.valueOf() + delay, detail: 'Zotero 库并发更新，重新核对 DOI' };
    }
    found = response.data.find(item => normalizeDoi(item.data?.DOI) === doi);
    if (!found && response.hasNext) {
      return { next: { doi, offset: offset + 25, snapshot: version }, retry: now.valueOf() + delay, detail: '继续核对 Zotero DOI' };
    }
  }
  if (delay > 0) throw new Problem(429, 'Zotero 要求等待后重试', delay);
  let itemKey = found?.key;
  if (!itemKey) {
    await call(s, settings, '/collections/' + settings.collection);
    itemKey = keyOfCreated(await call(s, settings, '/items', 'POST', [article(paper, settings.collection)], version));
  } else if (!found.data.collections?.includes(settings.collection)) {
    await call(s, settings, '/items/' + itemKey, 'PATCH',
      { collections: [...(found.data.collections ?? []), settings.collection] }, String(found.version ?? found.data.version));
  }
  await register(s, doi, 'item_saved', itemKey, null, now);
  const judgments = await s.all(`SELECT field,value,level,locator,quote,source FROM judgments WHERE doi=?
    ORDER BY reviewed DESC,level DESC,field LIMIT 22`, doi);
  if (!judgments.length) return { detail: 'Zotero 条目已就绪，待取得分析' };
  const tag = 'Scout DOI ' + doi;
  const children = await call(s, settings, '/items/' + itemKey + '/children?limit=1&tag=' + encodeURIComponent(tag));
  let noteKey = children.data.find(child => child.data.itemType === 'note' &&
    child.data.tags?.some(value => value.tag === tag))?.key;
  if (!noteKey) {
    if (children.delay > 0) throw new Problem(429, 'Zotero 要求等待后重试', children.delay);
    const note = '<h2>Scout 文献分析</h2><p>DOI ' + escapeHtml(doi) + '</p><ul>' + judgments.map(row => {
      const level = row.level === 'fulltext' ? '正文证据' : '摘要证据';
      return '<li><strong>' + escapeHtml(FIELDS[row.field]) + '</strong> ' + escapeHtml(row.value) +
        '<br>' + level + ' · ' + escapeHtml(row.locator) + ' · ' + escapeHtml(row.source) +
        '<br><em>' + escapeHtml(row.quote) + '</em></li>';
    }).join('') + '</ul>';
    noteKey = keyOfCreated(await call(s, settings, '/items', 'POST',
      [{ itemType: 'note', parentItem: itemKey, note, tags: [{ tag }], collections: [], relations: {} }], children.version));
  }
  await register(s, doi, 'synced', itemKey, noteKey, now);
  return { detail: 'Zotero DOI、收藏夹与 Scout 子笔记已核对' };
}
