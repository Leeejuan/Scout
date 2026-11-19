import { calendarYears, coverageChart } from './research-charts.js';
export const issueNames = {
  'mediated-ai': '生成式 AI 与媒介互动', 'platform-algorithms': '平台算法与推荐',
  'information-integrity': '误导信息与事实核查', privacy: '数字隐私与披露',
  participation: '政治效能与参与', wellbeing: '媒介使用与心理健康',
  representation: '媒介表征与文化认同', 'brand-trust': '广告、品牌与信任'
};
export const filterKeys = ['tag','topic','region','state','year','month','issn'];
export const scopeArgs = params => Object.fromEntries(filterKeys.flatMap(key => params.get(key) ? [[key, params.get(key)]] : []));
export const comparisonUrl = (dois, args = {}) => '/?' + new URLSearchParams([
  ['view','compare'], ...Object.entries(args), ...dois.map(doi => ['doi',doi])
]);

export function workspaceViews(ui) {
  const { el, p, link, panel, button, field, area, select, form, table, external, evidence, detail,
    disclosure, description, section, urlOf, api, errorMessage, load, tags, regions, levels, fields, fieldsTopic } = ui;
  const classifications = { observation: '待验证判断', consensus: '共识', disagreement: '分歧', gap: '候选缺口' };
  const number = value => (value ?? 0).toLocaleString('zh-CN');
  const libraryLink = args => urlOf({ view: 'library', ...args });

  function filters(page, args, journals, extra) {
    return el('form', { class: 'filters work-filters', method: 'get' },
      el('input', { type: 'hidden', name: 'view', value: page }),
      select('领域','tag', { '': '全部领域', ...tags },args.tag ?? ''),
      select('议题','topic', { '': '全部议题', ...issueNames },args.topic ?? ''),
      select('地区线索','region', { '': '全部地区', ...regions },args.region ?? ''),
      select('证据状态','state', { '': '全部状态', ...levels },args.state ?? ''),
      select('期刊','issn', { '': '全部期刊', ...Object.fromEntries(journals.map(j => [j.issn, j.name])) }, args.issn ?? ''),
      field('发表年份','year', { type:'number', min:'1900', max:'2100', value:args.year }),
      field('发表月份','month', { type:'month', value:args.month }), extra,
      el('div', { class: 'actions' }, button('应用筛选', 'primary'), link('清除',urlOf({ view:page }), 'button')));
  }

  function context(data) {
    const { counts, journals, lower, upper } = data;
    return el('div', { class: 'range-note' },
      el('p', {}, el('strong', {}, number(counts.included) + ' 篇'), ' · ' + counts.represented + ' 本有命中期刊 · ' + lower + ' 至 ' + upper),
      p('完整正文 ' + counts.fulltext + ' 篇 · 正文发现 ' + counts.findings + ' 篇 · 摘要 ' + counts.abstracts + ' 篇 · 题录 ' + counts.records + ' 篇','subtle'),
      el('details', {}, el('summary', {}, '查看 ' + journals.length + ' 本监测期刊'), p(journals.map(j => j.name).join('、'), 'subtle')));
  }

  function bars(labels, rows, filter, args) {
    const byKey = new Map(rows.map(row => [row.key, row]));
    const values = Object.entries(labels).map(([key,label]) => ({key,label,...byKey.get(key)}))
      .sort((a,b) => (b.count ?? 0) - (a.count ?? 0));
    const max = Math.max(1,...values.map(x => x.count ?? 0));
    return el('ul', { class: 'domain-list work-bars' }, values.map(row => {
      const count = row.count ?? 0;
      const href = libraryLink({ ...args, [filter]: row.key });
      return el('li', {}, el('div', { class: 'domain-label' },
        link(row.label,href), el('strong', {}, number(count))),
        el('progress', { max, value: count, 'aria-label': row.label + ' · ' + count + ' 篇' }),
        row.fulltext != null && p(row.fulltext + ' 篇完整正文','subtle'));
    }));
  }

  async function map(params) {
    const args = scopeArgs(params);
    const data = await api('workspace', { args: { section:'map', ...args } });
    const years = calendarYears(data.lower, data.upper);
    const byYear = new Map((data.domainYears ?? []).map(row => [row.key + ':' + row.year,row.count]));
    const peak = Math.max(1, ...byYear.values());
    const heatmap = table(['研究领域', ...years], Object.entries(tags).map(([key,label]) => [
      link(label,urlOf({ view:'map', ...args, tag:key })),
      ...years.map(year => {
        const count = byYear.get(key + ':' + year) ?? 0;
        const intensity = Math.ceil(4 * count / peak);
        return el('a', { href: libraryLink({ ...args, tag:key, year }), class:'heat-cell heat-' + intensity,
          'aria-label': label + ' · ' + year + ' · ' + number(count) + ' 篇' }, number(count));
      })
    ]));
    return [description('领域与议题地图','按论文标签和题录关键词浏览证据。'),
      filters('map',args,data.journals), context(data),
      !data.counts.included && panel(p('此范围暂无已收录论文。可放宽筛选条件查看其他证据。','subtle')),
      section('领域 × 发表年份',panel(p('颜色越深代表当前范围内的收录数量越高。每个格子可打开对应文献。','subtle'),heatmap)),
      el('div', { class:'work-grid' },
        section('传播学领域', panel(bars(tags,data.domains,'tag',args))),
        section('横跨领域的议题', panel(p('议题按题名和摘要关键词匹配，可同时命中多个议题。','subtle'), bars(issueNames,data.topics,'topic',args))))];
  }

  const topicUrl = dois => '/?' + new URLSearchParams([['view','topics'],...dois.map(doi => ['basis',doi])]);
  const itemLink = item => link(item.title,urlOf({ doi:item.doi }));
  const titleOf = (papers, doi) => papers.find(item => item.doi===doi)?.title ?? doi;
  const choose = (paper, selected = false) => el('label', { class:'paper-choice' },
    el('input', { type:'checkbox', name:'paper', value:paper.doi, checked:selected }),
    el('span', {}, itemLink(paper), el('small', {}, levels[paper.evidence_state] + ' · ' + paper.journal)));

  function picker(papers, initial, args) {
    return form(async (data, node) => {
      const dois = [...new Set([...new FormData(node).getAll('paper'), ...String(data.doi ?? '').trim().split(/[\s,，]+/).filter(Boolean)])];
      if (dois.length < 2 || dois.length > 4) throw new Error('请选择或填写 2–4 篇论文。');
      location.assign(comparisonUrl(dois,args));
    }, papers.length ? el('div', { class:'choice-list' }, papers.map(paper => choose(paper,initial.includes(paper.doi)))) : null,
    field('其他 DOI（以空格分隔）','doi', { value:initial.filter(id => !papers.some(p => p.doi===id)).join(' '), maxlength:960 }),
    el('div', {class:'actions'},button('打开逐篇对照','primary')));
  }

  function personalJudgment(dois, entry) {
    return form(async data => {
      await api('workspace-entry', { body: { kind:'judgment', id:entry?.id, dois, ...data } });
      errorMessage('研究判断已保存');
      await load({keepNotice:true});
    }, select('判断类型','classification',classifications,entry?.content.classification ?? 'observation'),
    area('你的判断与依据','text',entry?.content.text ?? ''), p('这一判断保存在当前浏览器的个人工作台。','subtle'),
    el('div',{class:'actions'},button('保存研究判断','primary')));
  }

  function savedJudgment(entry) {
    const row = entry.content;
    return el('article', {class:'panel saved-entry'},
      el('h3',{},classifications[row.classification] ?? '研究判断'), p(row.text),
      el('p',{class:'ref-links'},row.dois.flatMap(doi=>[detail(doi),' '])),
      el('div',{class:'actions'},link('回到证据对照',comparisonUrl(row.dois),'button'),link('从这些文献建立选题',topicUrl(row.dois),'button')),
      el('details',{},el('summary',{},'编辑判断'),personalJudgment(row.dois,entry)));
  }

  async function synthesis(params) {
    const args = scopeArgs(params);
    const [data, personal] = await Promise.all([
      api('workspace',{args:{section:'evidence',...args}}),api('personal')
    ]);
    const findings = data.claims.filter(row=>row.field==='findings');
    const saved = personal.filter(row=>row.kind==='judgment' && ['consensus','disagreement'].includes(row.content.classification));
    return [description('共识与分歧','以原文证据为起点，逐篇核对结论的适用条件。'),
      filters('synthesis',args,data.journals),context(data),
      section('当前范围的证据覆盖',panel(coverageChart(data.counts,args,el))),
      panel(el('h2',{},data.counts.findings<2 ? '证据不足' : '可进入比较'),
        p(data.counts.findings<2 ? '当前范围内至少需要两篇有正文发现的论文，才能保存为共识或分歧。' :
          '先对照概念、测量、样本、场景和设计。共享标签只用于寻找候选。','subtle')),
      section('逐篇对照',panel(p('选取 2–4 篇。候选列表最多显示 ' + data.limit + ' 篇，优先列出有正文发现的论文。','subtle'),
        picker(data.papers,[],args))),
      section('有出处的正文发现',findings.length ? findings.map(row=>panel(el('h3',{},link(titleOf(data.papers,row.doi),urlOf({doi:row.doi}))),evidence(row,true))) :
        panel(p('此范围尚无可比较的正文发现。','subtle'))),
      section('我的共识与分歧',saved.length ? saved.map(savedJudgment) : panel(p('在对照页保存判断后，可在这里回看。','subtle')))];
  }

  async function compare(params) {
    const args = scopeArgs(params);
    const ids = params.getAll('doi');
    const query = new URLSearchParams(ids.map(doi=>['doi',doi]));
    const [data, scope, personal] = await Promise.all([
      api('compare',{ args:query }), api('workspace',{args:{section:'evidence',...args}}), api('personal')
    ]);
    const dois = data.papers.map(item => item.doi);
    const count = data.papers.filter(paper=>paper.has_findings).length;
    const options = [...data.papers,...scope.papers.filter(row=>!dois.includes(row.doi))];
    const dimensions = ['ro_explicit','rq_h','design','sample','context','definition','measurement','methods','findings','limitations','future'];
    const showCell = (doi, key) => {
      const claims = data.claims.filter(row=>row.doi===doi && row.field===key);
      return claims.length ? claims.map(row=>evidence(row)) : p('待全文核验','subtle');
    };
    const notes = personal.filter(entry=>entry.kind==='judgment' && entry.content.dois.some(doi=>dois.includes(doi)));
    return [description('文献证据对照','并排查看论文的原文发现、样本和研究设计。'),
      context(scope),
      disclosure('选择或更换对照论文',picker(options,dois,args)),
      !dois.length && panel(p('先从文献库或上方列表选取论文。','subtle'),link('浏览文献证据库',libraryLink(args),'button')),
      dois.length>0 && panel(el('h2',{},dois.length + ' 篇对照 · ' + count + ' 篇有正文发现'),
        count<2 && p('证据不足，可先保存为待验证判断。','subtle'),
        el('div',{class:'comparison'},table(['比较维度',...data.papers.map(paper=>el('div',{},itemLink(paper),
          p(levels[paper.evidence_state] + ' · ' + paper.published,'subtle'),
          external('打开来源',paper.document_source ?? paper.publisher_url)))],
        [['摘要',...data.papers.map(paper=>paper.abstract ? [p(paper.abstract),external('摘要来源',paper.abstract_source)] : p('尚无摘要','subtle'))],
          ...dimensions.map(key=>[fields[key],...dois.map(doi=>showCell(doi,key))])]))),
      dois.length>0 && el('div',{class:'actions'},link('用这组证据建立选题',topicUrl(dois),'button')),
      dois.length>0 && section('保存我的研究判断',panel(personalJudgment(dois))),
      notes.length>0 && section('相关个人判断',notes.map(savedJudgment))
    ].filter(Boolean);
  }

  async function gaps(params) {
    const args=scopeArgs(params);
    const [data,personal] = await Promise.all([api('workspace',{args:{section:'gaps',...args}}),api('personal')]);
    const directions=data.claims.filter(row=>row.field==='future');
    const { counts }=data;
    return [description('研究缺口','查找作者提出的后续方向，并记录你要验证的问题。'),
      filters('gaps',args,data.journals),context(data),
      section('证据库覆盖',panel(p('以下数字用于安排阅读与核验，范围限于当前筛选的已收录论文。','subtle'),
        coverageChart(counts,args,el))),
      section('作者提出的未来研究方向', p(counts.directions + ' 篇有出处的论文 · 展示最多 ' + data.limit + ' 篇','subtle'),
        directions.length ? directions.map(row=>panel(
        el('h3',{},link(titleOf(data.papers,row.doi),urlOf({doi:row.doi}))),evidence(row,true),
        el('div',{class:'actions'},link('保存为个人选题',topicUrl([row.doi]),'button'),link('核对关联证据',comparisonUrl([row.doi],args),'button'))))
        :panel(p('证据不足。此范围暂无带正文出处的作者建议。','subtle'))),
      section('我的候选缺口',personal.some(row=>row.kind==='judgment'&&row.content.classification==='gap')
        ? personal.filter(row=>row.kind==='judgment'&&row.content.classification==='gap').map(savedJudgment)
        : panel(p('在对照页把研究判断保存为「候选缺口」，可在这里查看。','subtle'),link('打开证据对照',comparisonUrl([],args),'button')))];
  }

  function coauthorGraph(papers) {
    const people = new Map();
    const contributors = papers.map(paper=>({ ...paper, ids: paper.authors.slice(0,8).map((author,index)=>{
      const id=author.orcid ?? author.id ?? paper.doi+'#'+index;
      if (!people.has(id)) people.set(id,{name:author.name,id,known:!!(author.orcid??author.id),works:[]});
      people.get(id).works.push(paper.doi);
      return id;
    }) })).filter(paper=>paper.ids.length);
    if (!people.size) return panel(p('证据不足。此样本暂无作者元数据。','subtle'));
    const ordered=[...people.values()].sort((a,b)=>b.works.length-a.works.length||a.name.localeCompare(b.name));
    const graph=el('div',{class:'author-graph'});
    const selector=select('聚焦学者','scholar',Object.fromEntries(ordered.map(person=>
      [person.id,person.name + ' · ' + person.works.length + ' 篇' + (person.known ? '' : ' · 单篇身份')])),ordered[0].id);
    const input=selector.querySelector('select');
    function focus(id) {
      const person=people.get(id);
      const links=new Map();
      for (const paper of contributors.filter(row=>row.ids.includes(id))) {
        for (const other of new Set(paper.ids.filter(key=>key!==id))) {
          if (!links.has(other)) links.set(other,[]);
          links.get(other).push(paper.doi);
        }
      }
      const neighbors=[...links].sort((a,b)=>b[1].length-a[1].length);
      graph.replaceChildren(el('div',{class:'author-focus'},el('strong',{},person.name),
        p(person.works.length+' 篇 · '+neighbors.length+' 位合作者','subtle'),
        person.known&&external('查看作者标识',person.id)),
        neighbors.length ? el('div',{class:'author-neighbors'},neighbors.slice(0,12).map(([other,works])=>
          el('div',{class:'author-node'},
            el('button',{type:'button',onclick:()=>{input.value=other;focus(other);input.focus();}},people.get(other).name),
            el('small',{},works.length+' 篇共同署名'),
            el('div',{class:'ref-links'},works.map(doi=>detail(doi)))))) :
          p('该作者在当前样本中暂无共同署名关系。','subtle'),
        el('div',{class:'author-works'},el('h3',{},'当前样本中的论文'),person.works.map(doi=>p(link(titleOf(papers,doi),urlOf({doi}))))));
    }
    input.addEventListener('change',()=>focus(input.value));
    focus(ordered[0].id);
    return panel(selector,graph);
  }

  async function people(params) {
    const args=scopeArgs(params);
    const data=await api('workspace',{args:{section:'people',...args}});
    const { citations, similarity }=data.relationships;
    const work = doi => link(titleOf(data.papers,doi),urlOf({doi}));
    return [description('学者关系','在同一文献样本中查看共同署名、引用与共享领域标签。'),
      filters('people',args,data.journals),context(data),
      p('关系图使用 ' + data.papers.length + ' 篇论文，按发表日期取最近 ' + data.limit +
        ' 篇。每篇展示前 8 位作者，有 ORCID 或 OpenAlex 标识的作者跨论文合并。','subtle'),
      section('共同署名',coauthorGraph(data.papers)),
      section('已记录的引用关系',panel(citations.length ? table(['引用论文','被引用论文'],citations.map(row=>[work(row.from),work(row.to)]))
        :p('此样本暂无可核对的样本内引用关系。','subtle'))),
      section('主题相似线索',panel(p('按共享的领域标签列出样本内论文对。','subtle'),
        similarity.length ? table(['论文','相关论文','共享标签'],similarity.map(row=>[...row.papers.map(work),row.shared.map(key=>tags[key]).join('、')]))
          :p('此样本暂无共享领域标签的论文对。','subtle')))];
  }

  function myTopicForm(entry, basis) {
    const current = entry?.content ?? {};
    return form(async data=>{
      await api('workspace-entry',{body:{...data,id:entry?.id,kind:'topic'}});
      errorMessage('个人选题已保存');
      await load({keepNotice:true});
    }, field(fieldsTopic.title,'title',{value:current.title??'',maxlength:650,required:true}),
    field('文献依据 DOI（以空格分隔）','dois',{value:(current.dois??basis).join(' '),required:true,maxlength:3900}),
    el('div',{class:'split'},Object.entries(fieldsTopic).filter(([key])=>key!=='title')
      .map(([key,label])=>area(label,key,current[key]??'',2))),
    el('div',{class:'actions'},button('保存个人选题','primary')));
  }

  async function personalTopics(params) {
    const basis=params.getAll('basis').slice(0,16);
    const entries=await api('personal');
    const topics=entries.filter(entry=>entry.kind==='topic');
    const judgments=entries.filter(entry=>entry.kind==='judgment');
    return [p('个人记录通过当前浏览器识别。','subtle'),
      el('details',{class:'panel',open:basis.length>0||topics.length===0},el('summary',{},'新建个人选题'),myTopicForm(null,basis)),
      section('已保存的选题',topics.length ? topics.map(entry=>el('article',{class:'panel'},
        el('h3',{},entry.content.title),p(entry.content.question),
        table(['选题要素','内容'],Object.entries(fieldsTopic).filter(([key])=>!['title','question'].includes(key))
          .map(([key,label])=>[label,entry.content[key]])),
        el('p',{class:'ref-links'},entry.content.dois.map(doi=>detail(doi))),
        el('div',{class:'actions'},link('对照相关证据',comparisonUrl(entry.content.dois.slice(0,4)),'button')),
        el('details',{},el('summary',{},'编辑选题'),myTopicForm(entry,[])))) :
        panel(p('暂无已保存的选题。','subtle'))),
      section('我的研究判断',judgments.length ? judgments.map(savedJudgment) : panel(p('暂无研究判断。','subtle')))];
  }
  return { map, synthesis, compare, gaps, people, personalTopics };
}
