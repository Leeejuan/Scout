import { annualChart, calendarYears } from './research-charts.js';
import { comparisonUrl, issueNames, scopeArgs, workspaceViews } from './workbench.js';

const view = document.querySelector('#view');
const notice = document.querySelector('#notice');
const nav = document.querySelector('#nav');
const manageLogin = document.querySelector('#manage-login');
const logout = document.querySelector('#logout');
const stat = { included: '正式证据库', pending: '待筛查', excluded: '已排除' };
const levels = { record: '仅题录', abstract: '仅摘要', fulltext: '已核验正文' };
const regions = { CN: '中国', MY: '马来西亚', SEA: '东南亚' };
const fields = { article_type: '论文类型', ro_explicit: '作者明确写出的 RO', ro_inferred: 'Scout 归纳的 RO',
  rq_h: '研究问题／假设', theory: '理论', design: '研究设计', sample: '样本', context: '研究情境',
  definition: '概念定义', measurement: '测量', methods: '分析方法', findings: '主要发现',
  limitations: '作者报告的局限', future: '作者建议的研究方向' };
const fieldsTopic = { title: '选题标题', question: '研究问题', contribution: '可能贡献', type: '建议论文类型',
  primary: '主方法', alternative: '备选方法', data: '数据来源与获取条件', time: '时间条件', ethics: '伦理条件' };
const tags = { theory: '传播理论', intrapersonal: '自我／内在传播', interpersonal: '人际传播', groups: '群体传播',
  mass: '大众传播', organizations: '组织传播', 'media-management': '媒体管理', global: '全球／跨文化传播',
  digital: '数字媒体', political: '战略／政治传播', 'strategic-pr': '公共关系', 'health-risk': '健康／环境／风险传播',
  journalism: '新闻学', marketing: '市场传播、广告与品牌传播' };
const codeNames = { systematic_review: '系统综述', scoping_review: '范围综述', narrative_review: '叙事综述',
  research_article: '研究论文', theoretical_article: '理论／概念论文', replication: '复现研究', meta_analysis: '元分析',
  survey: '问卷调查', experiment: '实验', interview: '访谈', focus_group: '焦点小组', content_analysis: '内容分析',
  discourse_analysis: '话语分析', thematic_analysis: '主题分析', ethnography: '民族志', regression: '回归',
  structural_equation: '结构方程', case_study: '案例研究', longitudinal: '纵向研究' };
const codes = values => (values ?? []).map(value => codeNames[value] ?? value).join(' ＋ ');
const delivery = { skipped: '本期未推送', pending: '待推送', sending: '发送中', sent: '已确认送达', uncertain: '待核对', failed: '发送失败' };
const kinds = { lookup: 'DOI 检索', discover: '期刊检索', enrich: 'OpenAlex 核验', fulltext: '正文', extract: '证据分析',
  report: '生成简报', feishu: '飞书', telegram: 'Telegram（历史）', zotero: 'Zotero' };
const jobs = { queued: '待处理', running: '处理中', done: '已完成', dead: '失败', progress: '可继续', retry: '将重试', deferred: '已延后', failed: '失败' };
const topicStatuses = { candidate: 'Scout 候选', saved: '已收藏', archived: '已归档' };
const zoteroStates = { queued: '已排队', synced: '条目及笔记已核对', item_saved: '条目已核对，暂无分析笔记', retry: '等待重试', failed: '写入失败' };
let renderId = 0;

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat(Infinity)) {
    if (child != null && typeof child !== 'boolean') node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

const p = (text, cls) => el('p', { class: cls }, text);
const button = (text, cls) => el('button', { type: 'submit', class: cls }, text);
const link = (text, href, cls) => el('a', { href, class: cls }, text);
const urlOf = args => '/?' + new URLSearchParams(args);
const apiUrl = (action, args) => {
  const params = new URLSearchParams(args);
  params.set('action', action);
  return '/api/scout?' + params;
};
const detail = doi => link(doi, urlOf({ doi }));
const pill = (text, cls = '') => el('span', { class: 'pill ' + cls }, text);
const empty = (text) => el('div', { class: 'panel' }, p(text, 'subtle'));
const panel = (...content) => el('div', { class: 'panel' }, content);
const list = (...content) => el('div', { class: 'list' }, content);
const pills = (...content) => el('div', { class: 'pills' }, content);
const section = (title, ...content) => el('section', { class: 'section' }, el('h2', {}, title), content);
const kv = entries => el('dl', {}, Object.entries(entries).flatMap(([key, val]) => [el('dt', {}, key), el('dd', {}, val)]));
const authors = people => people.slice(0, 5).map(person => person.name).join('、') + (people.length > 5 ? ' 等' : '');
const description = (title, subtitle, cls) => el('div', {}, el('h1', { class: cls }, title), p(subtitle, 'subtle'));
const asList = content => el('ul', {}, content.map(item => el('li', {}, item)));
const display = value => value ?? '—';

function external(text, value) {
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && !url.username && !url.password) return el('a', { href: url.href, target: '_blank', rel: 'noreferrer noopener' }, text);
  } catch { /* Source may be absent. */ }
  return el('span', {}, text);
}

function table(headers, rows) {
  return el('div', { class: 'table-wrap' }, el('table', {},
    el('thead', {}, el('tr', {}, headers.map(label => el('th', { scope: 'col' }, label)))),
    el('tbody', {}, rows.map(row => el('tr', {}, row.map(value => el('td', {}, value)))))));
}

function errorMessage(message, error = false) {
  notice.textContent = message;
  notice.classList.toggle('error', error);
}

async function api(action, { args, body } = {}) {
  const response = await fetch(apiUrl(action, args), body ? {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  } : {});
  const data = await response.json();
  if (!response.ok) {
    if (response.status === 401 && action !== 'login' && (body || ['activity','search'].includes(action))) showLogin();
    throw new Error(data.error ?? 'Scout 请求失败');
  }
  return data;
}

function field(label, name, attrs = {}) {
  return el('label', {}, label, el('input', { name, ...attrs }));
}

function area(label, name, value = '', rows = 4) {
  return el('label', {}, label, el('textarea', { name, rows, required: true }, value));
}

function select(label, name, choices, selected) {
  return el('label', {}, label, el('select', { name }, Object.entries(choices).map(([key, value]) =>
    el('option', { value: key, selected: selected === key }, value))));
}

function form(run, ...children) {
  return el('form', { class: 'stack', async onsubmit(event) {
    event.preventDefault();
    const node = event.currentTarget;
    const data = Object.fromEntries(new FormData(node));
    node.querySelectorAll('button').forEach(btn => { btn.disabled = true; });
    errorMessage('');
    try { await run(data, node); }
    catch (error) { errorMessage(error.message, true); }
    finally { node.querySelectorAll('button').forEach(btn => { btn.disabled = false; }); }
  } }, children);
}

function action(actionName, fixed, text, confirmation) {
  return form(async () => {
    await api(actionName, { body: fixed });
    if (confirmation) errorMessage(confirmation);
    await load({ keepNotice: true });
  }, el('div', { class: 'actions' }, button(text)));
}

function disclosure(title, ...content) {
  return el('details', { class: 'panel' }, el('summary', {}, title), content);
}

function showLogin() {
  renderId++;
  nav.hidden = manageLogin.hidden = logout.hidden = true;
  view.setAttribute('aria-busy', 'false');
  view.replaceChildren(el('div', { class: 'panel login' },
    el('h1', {}, 'Scout 管理登录'),
    form(async data => { await api('login', { body: data }); await load(); },
      field('访问口令', 'password', { type: 'password', required: true, autocomplete: 'current-password', maxlength: 256 }),
      el('div', { class: 'actions' }, button('登录', 'primary'), link('返回研究总览', '/?view=overview', 'button')))));
}

function paperCard(item) {
  const types = item.labels.filter(label => label.field === 'article_type').map(label => label.value);
  const methods = item.labels.filter(label => label.field !== 'article_type').map(label => label.value);
  return el('article', { class: 'paper' },
    el('h2', {}, link(item.title, urlOf({ doi: item.doi }))),
    p(item.journal + ' · ' + item.published + (item.authors.length ? ' · ' + authors(item.authors) : ''), 'subtle'),
    pills(pill(levels[item.evidence_state], item.evidence_state === 'record' ? 'pending' : 'active'),
      item.tags.map(tag => pill(tags[tag] ?? tag)), item.regions.map(region => pill(regions[region] ?? region))),
    kv({ '论文类型': codes(item.codes?.types) || types.join(' ＋ ') || item.subtype || '待全文核验', '研究设计／方法': codes(item.codes?.methods) || methods.join('；') || '待全文核验', DOI: item.doi }),
    item.status === 'included' && el('div', { class: 'paper-links' },
      link('论文详情', urlOf({ doi: item.doi })), link('加入逐篇对照', comparisonUrl([item.doi]))));
}

function svgNode(tag, attributes = {}, label) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
  if (label !== undefined) node.textContent = label;
  return node;
}

function trendChart(months) {
  const plot = svgNode('svg', { viewBox: '0 0 660 252', class: 'trend-chart', role: 'img',
    'aria-label': '按发表月份统计的收录论文数量，具体数值见下方数据表' });
  const max = Math.max(4, Math.ceil(Math.max(...months.map(row => row.count)) / 4) * 4);
  const top = 18;
  const bottom = 215;
  const left = 42;
  const step = 602 / months.length;
  for (let i = 0; i <= 4; i++) {
    const y = bottom - (bottom - top) * i / 4;
    plot.append(svgNode('line', { x1: left, x2: 644, y1: y, y2: y, class: 'chart-gridline' }),
      svgNode('text', { x: 32, y: y + 4, 'text-anchor': 'end' }, max * i / 4));
  }
  for (const [index, row] of months.entries()) {
    const x = left + index * step + (step - 10) / 2;
    const height = row.count / max * (bottom - top);
    const bar = svgNode('rect', { x, y: bottom - height, width: 10, height, rx: 3,
      class: row.partial ? 'trend-bar partial' : 'trend-bar' });
    bar.append(svgNode('title', {}, row.month + '：' + row.count + ' 篇' + (row.partial ? '（非完整月）' : '')));
    if (row.count) {
      const target = svgNode('a',{href:urlOf({view:'library',month:row.month}),'aria-label':row.month+' · '+row.count+' 篇，查看文献'});
      target.append(bar);
      plot.append(target);
    } else plot.append(bar);
    if (index % 6 === 0 && index < months.length - 3 || index === months.length - 1) {
      plot.append(svgNode('text', { x: x + 5, y: 237, 'text-anchor': 'middle' }, row.month.slice(2).replace('-', '/')));
    }
  }
  return plot;
}

async function overview() {
  const data = await api('overview');
  const included = data.months.filter(row => row.status === 'included');
  const totals = { included: 0, pending: 0, fulltext: 0 };
  const monthly = new Map();
  for (const row of data.months) {
    totals[row.status] += row.count;
    if (row.status !== 'included') continue;
    monthly.set(row.month, (monthly.get(row.month) ?? 0) + row.count);
    if (row.evidence_state === 'fulltext') totals.fulltext += row.count;
  }
  const cursor = new Date(data.lower.slice(0, 7) + '-01T00:00:00Z');
  const months = [];
  while (cursor.toISOString().slice(0, 7) <= data.upper.slice(0, 7)) {
    const month = cursor.toISOString().slice(0, 7);
    const lastDay = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
    months.push({ month, count: monthly.get(month) ?? 0, partial: month + '-01' < data.lower || lastDay > data.upper });
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  const years = calendarYears(data.lower, data.upper);
  const domainMax = Math.max(1, ...data.domains.map(row => row.count));
  return [
    el('section', { class: 'overview-hero' },
      el('div', {}, el('h1', {}, '研究总览'), p('传播学文献的收录趋势、领域分布与证据覆盖。'),
        p(years.join('、') + ' · 按发表年份收录 · 当前数据库', 'subtle'),
        el('div',{class:'actions'},link('浏览文献证据库', '/?view=library', 'button'),
          link('探索领域与议题', '/?view=map', 'button'))),
      el('img', { class: 'overview-mascot', src: '/scout-avatar.webp', alt: '', width: 180, height: 180 })),
    el('div', { class: 'metrics overview-metrics' }, [
      ['已收录文献', totals.included], ['已获取完整正文', totals.fulltext],
      ['待筛查', totals.pending], ['当前监测期刊', data.journals]
    ].map(([label, count], index) => link([el('span', {}, label), el('strong', {}, count.toLocaleString('zh-CN'))],
      [urlOf({view:'library'}),urlOf({view:'library',state:'fulltext'}),urlOf({view:'library',status:'pending'}),urlOf({view:'map'})][index],
      'metric metric-link'))),
    el('section', { class: 'panel chart-panel annual-panel', 'aria-labelledby': 'annual-title' },
      el('h2', { id: 'annual-title' }, '三年发表量与正文覆盖'),
      el('div', { class: 'chart-legend' }, el('span', { class: 'legend-mint' }, '完整正文'),
        el('span', { class: 'legend-indigo' }, '其余已收录记录')),
      annualChart(years, data.months),
      el('div', { class: 'actions annual-links' }, years.map(year => link('查看 ' + year + ' 年文献', urlOf({ view:'library', year }), 'button'))),
      p('本年统计截至 ' + data.upper + '。点击色块或年份进入对应文献。', 'subtle')),
    el('div', { class: 'overview-grid' },
      el('section', { class: 'panel chart-panel', 'aria-labelledby': 'trend-title' },
        el('h2', { id: 'trend-title' }, '发表趋势'),
        p('按发表月份统计已收录论文。薄荷色代表非完整月。数据反映 Scout 的收录范围。', 'subtle'),
        included.length ? [trendChart(months), el('details', {}, el('summary', {}, '查看月度数据'),
          table(['发表月份', '已收录论文'], months.map(row => {
            const label = row.month + (row.partial ? '（非完整月）' : '');
            return [row.count ? link(label,urlOf({view:'library',month:row.month})) : label,row.count];
          })))]
          : p('文献库收录论文后，这里会显示月度趋势。', 'chart-empty')),
      el('section', { class: 'panel chart-panel', 'aria-labelledby': 'fields-title' },
        el('h2', { id: 'fields-title' }, '研究领域分布'),
        p('同一篇论文可归入多个领域。点击领域查看文献。', 'subtle'),
        data.domains.length ? el('ul', { class: 'domain-list' }, data.domains.map(row =>
          el('li', {}, el('div', { class: 'domain-label' }, link(tags[row.tag], urlOf({ tag: row.tag })), el('strong', {}, row.count)),
            el('progress', { max: domainMax, value: row.count, 'aria-hidden': 'true' }))))
          : p('已收录论文添加领域标签后，这里会显示分布。', 'chart-empty'),
        p('范围 · ' + data.journals + ' 本监测期刊 · ' + totals.included + ' 篇已收录','subtle'))),
    el('div',{class:'work-shortcuts'},
      ...[['逐篇核对共识与分歧','synthesis'],['查找研究缺口','gaps'],['浏览学者关系','people'],['打开个人选题库','topics']]
        .map(([label,page])=>link(label,urlOf({view:page}),'shortcut')))
  ];
}

async function library(params, canManage) {
  const args = { ...scopeArgs(params), ...Object.fromEntries([...params].filter(([key]) => ['q','status','after','claim'].includes(key))) };
  const [data, journals] = await Promise.all([api('library', { args }),api('journals')]);
  const counts = Object.fromEntries(data.counts.filter(row => row.status === 'included').map(row => [row.evidence_state, row.count]));
  const pending = data.counts.filter(row => row.status === 'pending').reduce((sum, row) => sum + row.count, 0);
  const filters = el('form', { class: 'filters', method: 'get' },
    el('input',{type:'hidden',name:'view',value:'library'}),
    el('label', { class: 'query' }, '搜索文献、证据或 DOI', el('input', { type: 'search', name: 'q', value: args.q ?? '', placeholder: '关键词或 DOI' })),
    select('收录状态', 'status', stat, args.status ?? 'included'),
    select('领域', 'tag', { '': '全部领域', ...tags }, args.tag ?? ''),
    select('议题', 'topic', { '': '全部议题', ...issueNames }, args.topic ?? ''),
    select('研究情境线索', 'region', { '': '全部地区', ...regions }, args.region ?? ''),
    select('期刊', 'issn', { '': '全部期刊', ...Object.fromEntries(journals.map(j=>[j.issn,j.name])) },args.issn ?? ''),
    select('发表年份','year', { '': '全部年份', ...Object.fromEntries(calendarYears(data.lower,data.upper).map(year => [year,year])) },args.year ?? ''),
    field('发表月份','month',{type:'month',value:args.month}),
    args.claim && el('input',{type:'hidden',name:'claim',value:args.claim}),
    select('证据状态', 'state', { '': '全部状态', ...levels }, args.state ?? ''),
    button('搜索', 'primary'));
  return [
    description('文献证据库', calendarYears(data.lower,data.upper).join('、') + ' · 按发表年份收录'),
    args.claim && p(args.claim === 'future' ? '当前筛选 · 有正文出处的作者建议' : '当前筛选 · 有正文出处的研究发现', 'subtle'),
    el('div', { class: 'metrics' }, [ ...Object.entries(levels).map(([key, label]) => [label, counts[key] ?? 0]), ['待筛查', pending] ]
      .map(([label, count]) => el('div', { class: 'metric' }, el('strong', {}, count), el('span', {}, label)))),
    filters,
    el('div',{class:'actions'},link('打开逐篇对照',comparisonUrl([],scopeArgs(params)),'button')),
    data.rows.length ? list(...data.rows.map(paperCard)) : empty(
      args.status === 'pending' ? '暂无待筛查的 DOI。' : '此筛选范围内暂无文献。' + (canManage ? '可在任务与覆盖页检索 DOI 或启动回填。' : '')),
    data.next && link('下一页', urlOf({ view:'library', ...args, after: data.next }), 'button')
  ].filter(Boolean);
}

function evidence(row, includeDoi = false) {
  const pdfPage = /^PDF 页 (\d+)/.exec(row.locator)?.[1];
  let source = row.source;
  if (pdfPage && source) {
    try {
      const target = new URL(source);
      if (target.pathname.toLowerCase().endsWith('.pdf')) {
        target.hash = 'page=' + pdfPage;
        source = target.href;
      }
    } catch { /* The evidence row may have an unavailable source. */ }
  }
  return el('div', { class: 'evidence' }, p(row.value),
    el('blockquote', {}, row.quote),
    p([includeDoi ? detail(row.doi) : null, includeDoi ? ' · ' : null,
      external(row.locator + ' · ' + (row.level === 'abstract' ? '摘要' : '正文'), source),
      ' · ' + (row.origin === 'inferred' ? 'Scout 归纳' : '作者表述') + (row.reviewed ? ' · 人工已核验' : ' · 自动提取')], 'subtle'));
}

async function paperView(params, canManage) {
  const paper = await api('paper', { args: { doi: params.get('doi') } });
  const screen = canManage && disclosure('单篇筛查',
    form(async data => {
      await api('screen', { body: { ...data, doi: paper.doi } }); errorMessage('筛查结果已保存'); await load({ keepNotice: true });
    }, select('审核结果', 'status', stat, paper.status),
    field('出版社单篇类型', 'subtype', { required: true, value: paper.subtype, maxlength: 120, placeholder: '例如 Research Article' }),
    field('单篇类型依据', 'source', { type: 'url', required: true, value: paper.screening_url ?? paper.publisher_url }),
    area('审核说明', 'reason', paper.screening_reviewer ? paper.screening_reason : '', 2),
    el('div', { class: 'actions' }, button('保存筛查', 'primary'))));
  const importDoc = canManage && !paper.document && paper.status !== 'excluded' && disclosure('导入已取得的正文文本',
    p('可从本地 PDF 提取文本并保留分页符，或用 # 标记章节标题。上传前核对 DOI 与来源。', 'subtle'),
    form(async (data, node) => {
      const file = node.querySelector('input[type=file]').files[0];
      if (file && file.size > 220000) throw new Error('文件超过 220 KB');
      const text = file ? await file.text() : data.text;
      await api('document', { body: { doi: paper.doi, text, source: data.source, coverage: data.coverage } });
      errorMessage('正文已保存，证据分析已排队'); await load({ keepNotice: true });
    }, field('全文来源', 'source', { type: 'url', required: true, value: paper.publisher_url }),
    select('文本覆盖范围', 'coverage', { excerpt: '节选', body: '已核对的完整正文' }, 'excerpt'),
    field('选择本地文本文件', 'file', { type: 'file', accept: '.txt,text/plain' }),
    el('label', {}, '或粘贴正文文本', el('textarea', { name: 'text', rows: 5 })),
    el('div', { class: 'actions' }, button('导入正文', 'primary'))));
  const review = canManage && paper.status !== 'excluded' && disclosure('补充人工核验证据',
    form(async data => {
      await api('judgment', { body: { ...data, doi: paper.doi } }); errorMessage('证据已保存'); await load({ keepNotice: true });
    }, select('文章字段', 'field', fields, 'findings'),
    select('证据来源', 'level', { fulltext: '正文', abstract: '摘要' }, paper.document ? 'fulltext' : 'abstract'),
    field('页码或章节（可留空，由 Scout 匹配）', 'locator', { placeholder: '例如 PDF 页 3 · Methods' }),
    area('人工判断', 'value', '', 2), area('连贯的原文引文', 'quote', '', 3),
    el('div', { class: 'actions' }, button('保存证据', 'primary'))));
  const downloads = paper.status === 'included' && panel(
    el('div', { class: 'actions' },
      link('下载 BibTeX', apiUrl('export', { doi: paper.doi, format: 'bib' }), 'button'),
      link('下载 RIS', apiUrl('export', { doi: paper.doi, format: 'ris' }), 'button'),
      link('加入逐篇对照',comparisonUrl([paper.doi]),'button'),
      canManage && action('zotero', { doi: paper.doi }, '加入 Zotero 收藏夹', 'Zotero 同步已排队')),
    canManage && paper.zotero && p((zoteroStates[paper.zotero.status] ?? paper.zotero.status) + (paper.zotero.error ? ' · ' + paper.zotero.error : ''), 'subtle'));
  const metadata = panel(kv({
    'DOI': external(paper.doi, 'https://doi.org/' + paper.doi.split('/').map(encodeURIComponent).join('/')),
    '题录来源': [external('Crossref', paper.crossref_url), paper.openalex_id ? ' · ' : null, paper.openalex_id && external('OpenAlex', paper.openalex_id)],
    '期刊政策': external(paper.journal + ' · ' + paper.issn, paper.policy_url),
    '论文类型编码': codes(paper.codes?.types) || '待全文核验',
    '研究方法编码': codes(paper.codes?.methods) || '待全文核验',
    '单篇收录依据': [stat[paper.status], ' · ', external(paper.subtype ?? '类型待核验', paper.screening_url), paper.screening_reason ? ' · ' + paper.screening_reason : null],
    '时间': '首次发现 ' + paper.first_seen.slice(0, 10) + ' · 最近核验 ' + paper.last_verified.slice(0, 10),
    '正文': paper.document ? external((paper.document.coverage === 'body' ? '完整正文' : '部分正文') + ' · ' + paper.document.format, paper.document.source) : '待全文核验',
    '引用量': paper.cited_count == null ? '待 OpenAlex 核验' : paper.cited_count + ' · OpenAlex',
    '参考文献关系': paper.refs.length ? el('details', {}, el('summary', {}, '已记录 ' + paper.refs.length + ' 项标识符'),
      asList(paper.refs.slice(0, 80).map(ref => external(ref, ref.startsWith('https://') ? ref : 'https://doi.org/' + ref)))) : '暂无已记录的引用关系'
  }));
  const oa = paper.oa_locations.length && section('开放获取位置',
    asList(paper.oa_locations.map(location => [external('正文页面', location.landing), location.pdf && ' · ',
      location.pdf && external('PDF', location.pdf), ' · ' + (location.version ?? '版本待核验'),
      location.license ? ' · ' + location.license : null, location.source && ' · ', location.source && external('OpenAlex 来源', location.source)])));
  return [
    link('返回文献库', urlOf({ status: paper.status }), 'subtle'),
    description(paper.title, paper.journal + ' · ' + paper.published + (paper.authors.length ? ' · ' + authors(paper.authors) : ''), 'paper-title'),
    pills(pill(levels[paper.evidence_state], 'active'), paper.tags.map(tag => pill(tags[tag] ?? tag)),
      paper.regions.map(region => pill((regions[region] ?? region) + ' · 文本线索'))),
    metadata, downloads, oa, section('摘要', p(paper.abstract ?? '尚未取得摘要。'), paper.abstract_source && external('查看摘要来源', paper.abstract_source)),
    section('证据与判断', ...Object.entries(fields).map(([key, label]) => {
      const rows = paper.judgments.filter(row => row.field === key);
      return panel(el('h3', {}, label), rows.length ? rows.map(row => evidence(row)) :
        p(paper.evidence_state === 'fulltext' ? '待全文核验 · 暂无可引用的判断' : '待全文核验', 'subtle'));
    })),
    screen, importDoc, review
  ].filter(Boolean);
}

function synthesisList(entries) {
  if (!entries?.length) return p('可核验的证据不足。', 'subtle');
  return list(...entries.map(item => panel(p(item.text), pills(item.dois.map(doi => detail(doi))),
    item.compare && table(['研究', '样本', '情境', '概念定义', '测量', '研究设计'], item.compare.map(row =>
      [detail(row.doi), ...['sample','context','definition','measurement','design'].map(field => {
        const cell = row.dimensions[field];
        return cell ? [cell.value, ' · ', external(cell.locator, cell.source)] : '待核验';
      })])))));
}

async function reportView(params, canManage) {
  const selected = params.get('report');
  if (!selected) {
    const reports = await api('reports');
    return [
      description('半月简报', '每月 1 日与 16 日 · 马来西亚时间'),
      link('打开实时研究工作台',urlOf({view:'overview'}),'button'),
      reports.length ? list(...reports.map(report => panel(el('h2', {}, link(report.period + ' 期', urlOf({ report: report.period }))),
        p(report.window_start + ' 至 ' + report.window_end + ' · ' + delivery[report.delivery], 'subtle')))) :
        empty('暂无已生成的简报。')
    ];
  }
  const report = await api('report', { args: { period: selected } });
  if (report.demo) return [
    description('Scout 飞书测试简报', '用于验证「查看完整简报」的跳转'),
    panel(p(report.content.synthesisState)),
    el('div',{class:'actions'},link('查看简报列表', urlOf({ view: 'reports' }), 'button'),
      link('打开实时研究工作台',urlOf({view:'overview'}),'button'))
  ];
  const data = report.content;
  const official = Object.fromEntries(data.counts.filter(row => row.status === 'included').map(row => [row.evidence_state, row.count]));
  const pending = data.counts.filter(row => row.status === 'pending').reduce((sum, row) => sum + row.count, 0);
  const excluded = data.counts.filter(row => row.status === 'excluded').reduce((sum, row) => sum + row.count, 0);
  const reconciliation = canManage && report.delivery_channel === 'feishu' && ['uncertain','failed'].includes(report.delivery) && disclosure('核对飞书发送记录',
    form(async data => {
      await api('feishu-reconcile', { body: { period: selected, action: 'sent', checkedDelivered: data.checked === 'yes' } });
      errorMessage('已记录送达'); await load({ keepNotice: true });
    }, el('label', {}, el('input', { type: 'checkbox', name: 'checked', value: 'yes', required: true }), '已在飞书群内看到该期简报'),
    button('标记已收到')),
    form(async data => {
      await api('feishu-reconcile', { body: { period: selected, action: 'retry', checkedUndelivered: data.checked === 'yes' } });
      errorMessage('已重新排队'); await load({ keepNotice: true });
    }, el('label', {}, el('input', { type: 'checkbox', name: 'checked', value: 'yes', required: true }), '已核对飞书群，确认该期尚未送达'),
    button('重新排队')));
  return [
    link('返回简报列表', urlOf({ view: 'reports' }), 'subtle'),
    description(report.period + ' 期简报', report.window_start + ' 至 ' + report.window_end + ' · ' + delivery[report.delivery]),
    el('div',{class:'actions'},link('查看实时总览',urlOf({view:'overview'}),'button'),
      link('对照本期证据',comparisonUrl(data.sample.slice(0,4)),'button')),
    p(report.delivery_error ?? '', 'subtle'), reconciliation,
    section('检索覆盖与证据状态', p(data.coverageStart + ' 至 ' + data.coverageEnd + ' · ' + data.scope.map(row => row.name).join('、'), 'subtle'),
      kv(Object.fromEntries(Object.entries(levels).map(([key, label]) => [label, official[key] ?? 0]))),
      p('待筛查 ' + pending + ' 篇，已排除 ' + excluded + ' 篇。本期尚有 ' + data.outstanding + ' 个待完成的任务。', 'subtle'),
      table(['ISSN','索引回查窗口','分片完成','返回','遗漏／排除','错误'], data.progress.map(row =>
        [row.issn, row.lower_date + ' 至 ' + row.upper_date, row.slices_done + '/' + row.slices, row.returned, row.omitted, row.errors ?? '—'])),
      data.failures.length > 0 && asList(data.failures.map(row => (kinds[row.kind] ?? row.kind) + ' · ' + row.error))),
    section('发表趋势', p('同一期刊范围的等长发表窗口。前期 ' + data.comparison.start + ' 至 ' + data.comparison.end +
      '。按多标签计数，会受到检索和单篇筛查进度影响。', 'subtle'),
      data.trendRows.length ? table(['领域', '本期', '前期'], data.trendRows.map(row => [tags[row.tag] ?? row.tag, row.current, row.previous])) : p('暂无可比较条目。', 'subtle')),
    section('本期新增的正文发现', data.findings.length ? data.findings.map(row => evidence({ ...row, level: 'fulltext' }, true)) : p('暂无达到推送条件的新发现。', 'subtle')),
    section('研究现状', p(data.synthesisState, 'subtle'), synthesisList(data.synthesis.state)),
    section('共识', synthesisList(data.synthesis.consensus)),
    section('分歧与研究设计对照', synthesisList(data.synthesis.disagreements)),
    section('作者建议的研究方向', data.authorDirections.length ?
      data.authorDirections.map(row => evidence({ ...row, level: 'fulltext' }, true)) : p('暂无可核验的方向建议。', 'subtle')),
    section('Scout 综合的候选缺口', synthesisList(data.synthesis.gaps)),
    data.sample.length > 0 && disclosure('查看简报使用的正文证据',
      data.sample.map(doi => panel(el('h3', {}, detail(doi)),
        data.evidence[doi].map(row => [el('h3', {}, fields[row.field]), evidence({ ...row, level: 'fulltext' })])))),
    section('选题变化', data.synthesis.topics.length ? list(...data.synthesis.topics.map(topic => panel(el('h3', {}, topic.title), p(topic.question),
      pills(pill(topic.change), topic.dois.map(detail))))) : p('本期暂无选题变化。', 'subtle')),
    section('学者与文献关系', p('来自近期核验的收录条目，主题相似按共享领域标签判断。', 'subtle'),
      el('h3', {}, '共同署名'), data.relationships.coauthors.length ? asList(data.relationships.coauthors.map(row =>
        [row.authors.map(person => person.name).join('、'), ' · ', detail(row.doi)])) : p('暂无已记录的共同署名。', 'subtle'),
      el('h3', {}, '引用关系'), data.relationships.citations.length ? asList(data.relationships.citations.map(row =>
        [row.fromAuthors.join('、'), ' · ', detail(row.from), ' → ', row.toAuthors.join('、'), ' · ', detail(row.to)])) : p('样本内暂无已核对的引用关系。', 'subtle'),
      el('h3', {}, '主题相似'), data.relationships.similarity.length ? asList(data.relationships.similarity.map(row =>
        [detail(row.papers[0]), ' · ', detail(row.papers[1]), ' · ', row.shared.map(tag => tags[tag] ?? tag).join('、')])) : p('样本内暂无共享主题。', 'subtle'))
  ].filter(Boolean);
}

function topicForm(topic) {
  const content = topic?.content ?? {};
  return form(async data => {
    await api('topic', { body: { ...data, id: topic?.id, dois: data.dois.split(/[\s,，]+/).filter(Boolean) } });
    errorMessage('选题已保存'); await load({ keepNotice: true });
  }, ...Object.entries(fieldsTopic).map(([key, label]) => key === 'title'
    ? field(label, key, { required: true, value: content[key], maxlength: 650 }) : area(label, key, content[key] ?? '', 2)),
  area('已收录文献的 DOI（每行一项）', 'dois', (content.dois ?? []).join('\n'), 3),
  el('div', { class: 'actions' }, button('保存选题', 'primary')));
}

async function topicView(params, canManage) {
  const [topics, personal] = await Promise.all([api('topics'),workbench.personalTopics(params)]);
  return [
    description('个人选题库', '将论文证据、研究问题和执行条件保存在一起。'),
    ...personal,
    canManage && disclosure('新建管理选题', topicForm()),
    topics.length ? section('Scout 候选与管理选题', list(...topics.map(topic => panel(el('h2', {}, topic.title),
      pills(pill(topicStatuses[topic.status], topic.status === 'saved' ? 'active' : '')),
      kv(Object.fromEntries(Object.entries(fieldsTopic).filter(([key]) => key !== 'title').map(([key, label]) => [label, topic.content[key]]))),
      p(['文献依据 · ', topic.content.dois.map(detail).flatMap((node, i) => i ? [' · ', node] : [node])], 'subtle'),
      topic.period && p(link(topic.period + ' 期简报', urlOf({ report: topic.period })), 'subtle'),
      canManage && el('div', { class: 'actions' },
        topic.status !== 'saved' && action('topic-state', { id: topic.id, status: 'saved' }, '收藏选题', '已收藏'),
        topic.status !== 'archived' && action('topic-state', { id: topic.id, status: 'archived' }, '归档', '已归档')),
      canManage && el('details', {}, el('summary', {}, '编辑选题'), topicForm(topic))))))
      : null
  ].filter(Boolean);
}

async function activity(params) {
  const [data, journals] = await Promise.all([api('activity'), api('journals')]);
  const id = params.get('search');
  const slices = id ? await api('search', { args: { id } }) : [];
  return [
    description('任务与覆盖', data.tier === 'expanded' ? '已启用扩展期刊范围' : '当前使用两本试运行期刊'),
    panel(el('h2', {}, '按 DOI 发现论文'),
      form(async data => {
        const result = await api('lookup', { body: data });
        errorMessage('已排队 · ' + result.doi);
      }, field('DOI', 'doi', { placeholder: '10.xxxx/xxxxx', required: true, maxlength: 260 }),
      el('div', { class: 'actions' }, button('加入检索队列', 'primary')))),
    section('三年回填',
      action('backfill', { tier: data.tier }, '启动或继续回填', '回填已排队'),
      data.searches.length ? table(['搜索','日期窗口','分片','返回','排除／遗漏','有误分片'], data.searches.map(row =>
        [link(row.id, urlOf({ view: 'activity', search: row.id })), row.lower_date + ' 至 ' + row.upper_date, row.done + '/' + row.slices,
          display(row.returned), display(row.omitted), display(row.errors)])) : p('暂无检索任务。', 'subtle'),
      id && table(['期刊','起止日期','返回／预计','漏项明细','进度'], slices.map(row =>
        [row.issn, row.lower_date + ' 至 ' + row.upper_date, row.returned + '/' + display(row.total_expected),
          Object.entries(row.omissions).map(([key, count]) => ( { metadata: '缺少题录', outside_rolling_window: '超出窗口', excluded_type: '已排除类型' }[key] ?? key) + ' ' + count).join(' · '),
          row.error ?? (row.done ? '已完成' : '待继续')]))),
    section('任务状态', data.jobs.length ? table(['任务', '状态', '数量'], data.jobs.map(row =>
      [kinds[row.kind] ?? row.kind, jobs[row.status] ?? row.status, row.count])) : p('暂无任务。', 'subtle')),
    section('最近任务与 D1 用量', data.events.length ? table(['时间（UTC）', '任务', '结果', '读取行', '写入行', '请求数'],
      data.events.map(row => [row.at, row.job_id, [jobs[row.outcome] ?? row.outcome, ' · ', row.detail ?? '',
        row.outcome === 'failed' && !/^(?:feishu|telegram):/.test(row.job_id) ? action('retry', { id: row.job_id }, '重试', '任务已排队') : null],
        display(row.rows_read), display(row.rows_written), display(row.subrequests)])) : p('暂无执行记录。', 'subtle')),
    section('AI 预算（UTC）', data.budget.length ? table(['日期','已预留 Neurons','已计调用'], data.budget.map(row =>
      [row.utc_day, row.neurons, row.calls])) : p('暂无已预留的调用。', 'subtle')),
    section('同行评审期刊', table(['期刊','ISSN','范围','政策核验'],
      journals.map(journal => [journal.name, journal.issn, (journal.tier === 'pilot' ? '试运行 · ' : '扩展 · ') +
        journal.fields.map(tag => tags[tag] ?? tag).join('、'), external(journal.verified_on, journal.policy_url)])))
  ];
}

const workbench = workspaceViews({ el,p,link,panel,button,field,area,select,form,table,external,evidence,detail,
  disclosure,description,section,urlOf,api,errorMessage,load,tags,regions,levels,fields,fieldsTopic });

async function load({ keepNotice = false } = {}) {
  const id = ++renderId;
  if (!keepNotice) errorMessage('');
  view.setAttribute('aria-busy', 'true');
  try {
    const session = await api('session');
    if (id !== renderId) return;
    const params = new URLSearchParams(location.search);
    const compare = params.get('view') === 'compare';
    const requestedPage = compare ? 'compare' : params.has('doi') ? 'library' : params.has('report') ? 'reports' : params.get('view') ?? (params.size ? 'library' : 'overview');
    const page = requestedPage === 'activity' && !session.managementAvailable ? 'overview' : requestedPage;
    if (page === 'activity' && !session.signedIn) { showLogin(); return; }
    nav.hidden = false;
    logout.hidden = !session.signedIn;
    manageLogin.hidden = session.signedIn || !session.managementAvailable;
    for (const node of nav.querySelectorAll('a')) {
      node.hidden = node.dataset.page === 'activity' && !session.signedIn;
      if (node.dataset.page === page || compare && node.dataset.page === 'library') node.setAttribute('aria-current', 'page');
      else node.removeAttribute('aria-current');
    }
    const reader = !compare && params.has('doi') ? paperView : ({ overview, reports: reportView, topics: topicView, activity, ...workbench })[page] ?? library;
    const content = await reader(params, session.signedIn);
    if (id === renderId) view.replaceChildren(...content.flat(Infinity).filter(Boolean));
  } catch (error) {
    if (id === renderId) view.replaceChildren(empty(error.message));
  } finally {
    if (id === renderId) view.setAttribute('aria-busy', 'false');
  }
}

manageLogin.addEventListener('click', showLogin);
logout.addEventListener('submit', async event => {
  event.preventDefault();
  try {
    await api('logout', { body: {} });
    if (new URLSearchParams(location.search).get('view') === 'activity') location.assign('/?view=overview');
    else await load();
  }
  catch (error) { errorMessage(error.message, true); }
});
load();
