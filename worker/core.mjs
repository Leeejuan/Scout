export const FIELDS = {
  article_type: '论文类型', ro_explicit: '作者明确写出的 RO', ro_inferred: 'Scout 归纳的 RO',
  rq_h: '研究问题／假设', theory: '理论', design: '研究设计', sample: '样本',
  context: '研究情境', definition: '概念定义', measurement: '测量', methods: '分析方法',
  findings: '主要发现', limitations: '作者报告的局限', future: '作者建议的研究方向'
};

export const TAGS = {
  theory: '传播理论', intrapersonal: '自我／内在传播', interpersonal: '人际传播', groups: '群体传播',
  mass: '大众传播', organizations: '组织传播', 'media-management': '媒体管理',
  global: '全球／跨文化传播', digital: '数字媒体', political: '战略／政治传播',
  'strategic-pr': '公共关系', 'health-risk': '健康／环境／风险传播', journalism: '新闻学',
  marketing: '市场传播、广告与品牌传播'
};

const patterns = {
  theory: /communication theor|theoretical framework|传播理论/i,
  intrapersonal: /intrapersonal|self-talk|inner speech|self-reflection|内在传播|自我对话/i,
  interpersonal: /interpersonal|dyadic|romantic|parent.child|人际/i,
  groups: /small.group|group communication|intergroup|ingroup|outgroup|群体传播/i,
  mass: /mass media|mass communication|broadcast|大众传播/i,
  organizations: /organizational communication|internal communication|corporate communication|workplace communication|组织传播/i,
  'media-management': /media management|media industr|media economics|newsroom management|媒体管理/i,
  global: /intercultural|cross.cultural|transnational|global communication|跨文化/i,
  digital: /digital media|social media|social network|platform|online communication|数字媒体|社交媒体/i,
  political: /political|election|campaign communication|strategic communication|政治传播|战略传播/i,
  'strategic-pr': /public relations|crisis communication|stakeholder|公关|公共关系/i,
  'health-risk': /health communication|environmental|climate|risk communication|vaccine|pandemic|健康传播|风险传播/i,
  journalism: /journalism|newsroom|news media|news reporting|记者|新闻/i,
  marketing: /marketing|advertising|brand|consumer engagement|市场传播|广告|品牌/i
};

export function classify(title, abstract, topics = []) {
  const text = [title, abstract, ...topics].filter(Boolean).join(' ');
  const context = [title, abstract].filter(Boolean).join(' ');
  const tags = Object.keys(patterns).filter(key => patterns[key].test(text));
  const regions = [];
  if (/\b(?:china|chinese mainland|hong kong|macau)\b|中国|香港|澳门/i.test(context)) regions.push('CN');
  if (/\bmalaysi(?:a|an)\b|马来西亚/i.test(context)) regions.push('MY');
  if (regions.includes('MY') || /southeast asia|south.east asia|asean|\b(?:singapore|indonesia|vietnam|thailand|philippines|brunei|cambodia|laos|myanmar|timor.leste)\b|东南亚/i.test(context)) regions.push('SEA');
  return { tags, regions };
}

export function normalizeDoi(value) {
  let doi = String(value ?? '').trim().replace(/^(?:https?:\/\/(?:dx\.)?doi\.org\/|doi:\s*)/i, '');
  try { doi = decodeURIComponent(doi); } catch { /* Some deposited DOIs contain literal percent signs. */ }
  doi = doi.trim().toLowerCase();
  return /^10\.\d{4,9}\/[^\s\x00-\x1f<>"?#]+$/u.test(doi) && doi.length <= 240 ? doi : null;
}

export const doiUrl = doi => 'https://doi.org/' + doi.split('/').map(encodeURIComponent).join('/');
export const day = (date = new Date()) => date.toISOString().slice(0, 10);
export const shift = (date, days) => day(new Date(Date.parse(date) + days * 86400000));
export function rollingStart(date) {
  const [year, month, number] = date.split('-').map(Number);
  const lastDay = new Date(Date.UTC(year - 3, month, 0)).getUTCDate();
  return day(new Date(Date.UTC(year - 3, month - 1, Math.min(number, lastDay))));
}

export function myDate(now) {
  const local = new Date(now.valueOf() + 8 * 3600000);
  return { date: day(local), hour: local.getUTCHours() };
}

export function periodWindow(period) {
  const [year, month, number] = period.split('-').map(Number);
  return {
    start: number === 16 ? period.slice(0, 8) + '01' : day(new Date(Date.UTC(year, month - 2, 16))),
    end: shift(period, -1)
  };
}

export function httpsUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

export function parse(value, fallback) {
  try { return JSON.parse(value); } catch { return fallback; }
}

export function plain(value) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return String(value ?? '').replace(/<[^>]+>/g, ' ').replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (match, key) => {
    if (key[0] !== '#') return named[key.toLowerCase()] ?? match;
    const code = key[1].toLowerCase() === 'x' ? parseInt(key.slice(2), 16) : Number(key.slice(1));
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
  }).replace(/\s+/g, ' ').trim();
}

export class Problem extends Error {
  constructor(status, message, retryAfter = 0) {
    super(message);
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

export async function limitedText(response, maxBytes) {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const decoder = new TextDecoder();
  let size = 0;
  let text = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return text + decoder.decode();
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new Problem(413, '响应超过处理上限');
    }
    text += decoder.decode(value, { stream: true });
  }
}

export function service(env, binding = env.SCOUT_DB) {
  const usage = { read: 0, written: 0, external: 0, queries: 0 };
  function record(result) {
    usage.read += result.meta?.rows_read ?? 0;
    usage.written += result.meta?.rows_written ?? 0;
    return result;
  }
  const stmt = (sql, ...args) => binding.prepare(sql).bind(...args);
  const run = async (sql, ...args) => {
    usage.queries++;
    return record(await stmt(sql, ...args).run());
  };
  const all = async (sql, ...args) => (await run(sql, ...args)).results;
  const batch = async statements => {
    if (!statements.length) return [];
    usage.queries += statements.length;
    return (await binding.batch(statements)).map(record);
  };
  const request = async (url, options = {}) => {
    if (++usage.external > 16) throw new Problem(503, '本次任务外部请求已达上限');
    try {
      return await fetch(url, { ...options, redirect: 'manual', signal: AbortSignal.timeout(12000) });
    } catch {
      throw new Problem(503, '外部服务连接失败或超时');
    }
  };
  const json = async (url, label, options) => {
    const res = await request(url, options);
    if (!res.ok) {
      const delay = Number(res.headers.get('retry-after') ?? res.headers.get('backoff'));
      throw new Problem(res.status, label + ' HTTP ' + res.status, Number.isFinite(delay) ? delay * 1000 : 0);
    }
    return JSON.parse(await limitedText(res, 900000));
  };
  return { env, usage, stmt, run, all, batch, request, json, first: async (...args) => (await all(...args))[0] ?? null };
}

export const enqueueStmt = (s, id, kind, payload, priority, due = Date.now()) => s.stmt(
  'INSERT OR IGNORE INTO jobs(id,kind,payload,priority,due) VALUES (?,?,?,?,?)', id, kind, JSON.stringify(payload), priority, due
);

const typeCodes = {
  systematic_review: /systematic review|系统综述/i,
  scoping_review: /scoping review|范围综述/i,
  narrative_review: /narrative review|叙事综述/i,
  research_article: /research article|original article|original research|实证研究|研究论文/i,
  theoretical_article: /theoretical article|conceptual article|理论论文|概念论文/i,
  replication: /replication (?:study|note|article)|重复验证|复现研究/i
};

const methodCodes = {
  meta_analysis: /meta.analysis|meta.analytic|元分析/i,
  survey: /survey|questionnaire|问卷/i,
  experiment: /experiment|randomi[sz]ed|实验/i,
  interview: /interview|访谈/i,
  focus_group: /focus group|焦点小组/i,
  content_analysis: /content analysis|内容分析/i,
  discourse_analysis: /discourse analysis|话语分析/i,
  thematic_analysis: /thematic analysis|主题分析/i,
  ethnography: /ethnograph|民族志/i,
  regression: /regression|回归/i,
  structural_equation: /structural equation|结构方程/i,
  case_study: /case study|个案研究|案例研究/i,
  longitudinal: /longitudinal|纵向/i
};

export function researchCodes(subtype, judgments) {
  const article = [subtype, ...judgments.filter(row => row.field === 'article_type').map(row => row.value)].filter(Boolean).join(' ');
  const methods = judgments.filter(row => ['methods','design'].includes(row.field)).map(row => row.value).join(' ');
  const matches = (map, text) => Object.entries(map).filter(([, pattern]) => pattern.test(text)).map(([key]) => key);
  return { types: matches(typeCodes, article), methods: matches(methodCodes, methods) };
}
