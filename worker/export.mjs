import { doiUrl, parse } from './core.mjs';

function bibText(value) {
  const escapes = { '\\': '\\textbackslash{}', '{': '\\{', '}': '\\}', '%': '\\%', '&': '\\&',
    '_': '\\_', '#': '\\#', '$': '\\$', '^': '\\^{}', '~': '\\~{}' };
  return String(value ?? '').replace(/\s+/g, ' ').replace(/[\\{}%&_#$^~]/g, character => escapes[character]).trim();
}

export function exportCitation(paper, format) {
  const authors = parse(paper.authors, []);
  const { volume, issue, pages, article, datePrecision } = parse(paper.citation, {});
  const date = paper.published.slice(0, datePrecision === 1 ? 4 : datePrecision === 2 ? 7 : 10);
  const url = paper.publisher_url ?? doiUrl(paper.doi);
  if (format === 'bib') {
    const key = 'scout' + paper.doi.replace(/[^a-z0-9]/gi, '_');
    const names = authors.map(author => bibText(author.family ? [author.family, author.given].filter(Boolean).join(', ') : author.name)).join(' and ');
    const fields = { title: bibText(paper.title), author: names, journal: bibText(paper.journal),
      year: date.slice(0, 4), date, volume: bibText(volume), number: bibText(issue), pages: bibText(pages),
      eid: bibText(article), doi: bibText(paper.doi), url: bibText(url), issn: bibText(paper.issn) };
    return '@article{' + key + ',\n' + Object.entries(fields).filter(([, value]) => value)
      .map(([name, value]) => '  ' + name + ' = {' + value + '}').join(',\n') + '\n}\n';
  }
  const lines = [
    ['TY', 'JOUR'], ['TI', paper.title], ...authors.map(author => ['AU', author.family ?
      [author.family, author.given].filter(Boolean).join(', ') : author.name]), ['JO', paper.journal],
    ['PY', date.replaceAll('-', '/')], ['VL', volume], ['IS', issue], ['SP', pages ?? article],
    ['DO', paper.doi], ['SN', paper.issn], ['UR', url]
  ];
  return lines.filter(([, value]) => value).map(([tag, value]) => tag + '  - ' + String(value).replace(/\s+/g, ' ')).join('\r\n') + '\r\nER  -\r\n';
}
