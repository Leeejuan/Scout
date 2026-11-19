const number = value => value.toLocaleString('zh-CN');
const hrefFor = args => '/?' + new URLSearchParams({ view: 'library', ...args });

function svg(tag, attributes, text) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
  if (text != null) node.textContent = text;
  return node;
}

function barLink(chart, args, label, x, y, width, height, css) {
  const target = svg('a', { href: hrefFor(args), 'aria-label': label });
  target.append(svg('title', {}, label), svg('rect', { x, y, width, height, rx: 4, class: css }));
  chart.append(target);
}

export function calendarYears(lower, upper) {
  const first = Number(lower.slice(0, 4));
  const last = Number(upper.slice(0, 4));
  return Array.from({ length: last - first + 1 }, (_, i) => String(first + i));
}

export function annualChart(years, months) {
  const rows = years.map(year => {
    const papers = months.filter(row => row.status === 'included' && row.month.startsWith(year));
    return { year, total: papers.reduce((n, row) => n + row.count, 0),
      full: papers.filter(row => row.evidence_state === 'fulltext').reduce((n, row) => n + row.count, 0) };
  });
  const max = Math.max(1, ...rows.map(row => row.total));
  const chart = svg('svg', { viewBox: '0 0 680 174', class: 'annual-chart', role: 'group', 'aria-label': '逐年收录与完整正文数量' });
  rows.forEach((row, i) => {
    const y = 15 + i * 54;
    const width = 493 * row.total / max;
    const full = row.total ? width * row.full / row.total : 0;
    chart.append(svg('text', { x: 1, y: y + 23 }, row.year),
      svg('rect', { x: 77, y, width: 493, height: 33, rx: 6, class: 'chart-track' }),
      svg('text', { x: 586, y: y + 23 }, number(row.total) + ' 篇'));
    if (row.total > row.full) barLink(chart, { year: row.year }, row.year + ' 年 · 查看全部 ' + number(row.total) + ' 篇收录', 77 + full, y, width - full, 33, 'chart-indigo');
    if (full) barLink(chart, { year: row.year, state: 'fulltext' }, row.year + ' 年 · ' + number(row.full) + ' 篇完整正文', 77, y, full, 33, 'chart-mint');
  });
  return chart;
}

export function coverageChart(counts, args, el) {
  const rows = [
    ['已取得完整正文', counts.fulltext, { state: 'fulltext' }],
    ['有正文研究发现', counts.findings, { claim: 'findings', state: 'fulltext' }],
    ['有作者后续建议', counts.directions, { claim: 'future', state: 'fulltext' }]
  ];
  return el('ul', { class: 'coverage-chart' }, rows.map(([label, count, filter]) => {
    const total = counts.included;
    const zero = count === 0;
    const text = number(count) + ' / ' + number(total) + ' 篇';
    return el('li', {},
      el('div', { class: 'domain-label' }, zero ? el('span', {}, label) :
        el('a', { href: hrefFor({ ...args, ...filter }) }, label), el('strong', {}, text)),
      el('progress', { max: Math.max(total, 1), value: count, 'aria-label': label + '，' + text }));
  }));
}
