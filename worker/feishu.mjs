import { httpsUrl, limitedText, myDate, parse, Problem } from './core.mjs';

export const FEISHU_TEST_PERIOD = 'feishu-test';

function settings(env, testWebUrl) {
  const webhook = httpsUrl(env.FEISHU_WEBHOOK_URL?.trim());
  const secret = env.FEISHU_SIGNING_SECRET?.trim();
  if (!webhook || !secret) throw new Problem(422, '请在 Worker Secrets 中配置 FEISHU_WEBHOOK_URL 和 FEISHU_SIGNING_SECRET');
  const url = new URL(webhook);
  if (url.host !== 'open.feishu.cn' || !/^\/open-apis\/bot\/v2\/hook\/[A-Za-z0-9_-]+$/.test(url.pathname) || url.search || url.hash) {
    throw new Problem(422, 'FEISHU_WEBHOOK_URL 需为飞书自定义机器人的 HTTPS Webhook 地址');
  }
  const web = httpsUrl(testWebUrl ?? env.SCOUT_WEB_URL);
  if (!web) throw new Problem(422, '请提供 Scout 网页的 HTTPS 地址，或设置 SCOUT_WEB_URL');
  return { webhook, secret, web };
}

async function sign(secret, timestamp) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(timestamp + '\n' + secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const bytes = new Uint8Array(await crypto.subtle.sign('HMAC', key, new Uint8Array(0)));
  return btoa(String.fromCharCode(...bytes));
}

const plainText = content => ({ tag: 'plain_text', content });
const line = (value, limit) => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, limit) : '';

function digestCard(web, period, content, test) {
  const link = new URL('/', web);
  link.searchParams.set('report', period);
  const workspace = new URL('/?view=overview', web);
  const findings = (content.findings ?? []).slice(0, 3).map(row =>
    [line(row.title, 160), line(row.value, 170), row.doi && 'DOI ' + line(row.doi, 240)].filter(Boolean).join('\n'));
  const topics = (content.synthesis?.topics ?? []).slice(0, 2).map(row =>
    [line(row.change, 30), line(row.title, 145)].filter(Boolean).join(' · '));
  const highlights = test ? ['这是一条手动发送的 Scout 测试卡片。点击下方按钮打开测试简报。'] :
    [...findings, ...topics].filter(Boolean);
  return {
    schema: '2.0',
    header: {
      title: plainText(test ? 'Scout 飞书推送测试' : 'Scout 传播研究简报 · ' + period),
      template: test ? 'blue' : 'green'
    },
    body: {
      elements: [
        ...highlights.map(content => ({ tag: 'div', text: plainText(content) })),
        { tag: 'button', type: 'primary', text: plainText('查看完整简报'),
          behaviors: [{ type: 'open_url', default_url: link.href }] },
        ...(!test ? [{ tag: 'button', text: plainText('打开研究工作台'),
          behaviors: [{ tag: 'open_url', default_url: workspace.href }] }] : [])
      ]
    }
  };
}

async function transmit(s, config, card) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const payload = { timestamp, sign: await sign(config.secret, timestamp), msg_type: 'interactive', card };
  try {
    const response = await s.request(config.webhook, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload) });
    if (response.status === 429) {
      await response.body?.cancel();
      return { delivery: 'pending', error: '飞书限速，稍后可重试', retryAfter: 60000 };
    }
    const result = parse(await limitedText(response, 12000), null);
    const code = Number.isInteger(result?.code) ? result.code : result?.StatusCode;
    if (response.ok && code === 0) return { delivery: 'sent' };
    if (response.ok && code === 11232) return { delivery: 'pending', error: '飞书限速，稍后可重试', retryAfter: 60000 };
    if (response.status >= 400 && response.status < 500 || response.ok && Number.isInteger(code) && code !== 0) {
      const detail = code === 19021 ? '签名校验失败，请核对 FEISHU_SIGNING_SECRET' :
        Number.isInteger(code) && code !== 0 ? '错误码 ' + code : 'HTTP ' + response.status;
      return { delivery: 'failed', error: '飞书拒绝发送（' + detail + '）' };
    }
  } catch {
    // The request may have reached Feishu. Treat transport and parsing failures as ambiguous.
  }
  return { delivery: 'uncertain', error: '飞书发送结果无法确认，请先在群内核对' };
}

export function testReport(now) {
  const date = myDate(now).date;
  return {
    period: FEISHU_TEST_PERIOD, demo: true, window_start: date, window_end: date, delivery: 'skipped',
    content: {
      scope: [], counts: [], coverageStart: date, coverageEnd: date, comparison: { start: date, end: date },
      progress: [], failures: [], outstanding: 0, trendRows: [], findings: [], authorDirections: [], sample: [],
      synthesis: { state: [], consensus: [], disagreements: [], gaps: [], topics: [] },
      synthesisState: '这是用于验证飞书卡片链接的 Scout 测试简报。',
      relationships: { coauthors: [], citations: [], similarity: [] }
    }
  };
}

export async function sendFeishuTest(s, webUrl) {
  const config = settings(s.env, webUrl);
  const card = digestCard(config.web, FEISHU_TEST_PERIOD, {}, true);
  const result = await transmit(s, config, card);
  if (result.delivery !== 'sent') {
    throw new Problem(result.delivery === 'pending' ? 429 : result.delivery === 'uncertain' ? 503 : 422, result.error);
  }
  return { sent: true, reportUrl: card.body.elements.at(-1).behaviors[0].default_url };
}

export async function sendFeishuReport(s, { period }, now) {
  const stamp = now.toISOString();
  if (s.env.FEISHU_ENABLED !== 'true') {
    await s.run(`UPDATE reports SET delivery='skipped',delivery_updated=?,delivery_error='飞书推送已关闭'
      WHERE period=? AND delivery_channel='feishu' AND delivery='pending'`, stamp, period);
    return { detail: '飞书推送未启用' };
  }
  const config = settings(s.env);
  const report = await s.first(`UPDATE reports SET delivery='sending',delivery_updated=?,delivery_error=NULL
    WHERE period=? AND delivery_channel='feishu' AND delivery='pending' RETURNING content`, stamp, period);
  if (!report) return { detail: '本期无待推送简报' };
  const result = await transmit(s, config, digestCard(config.web, period, parse(report.content, {}), false));
  await s.run(`UPDATE reports SET delivery=?,delivery_updated=?,delivery_error=?
    WHERE period=? AND delivery_channel='feishu' AND delivery='sending'`, result.delivery, stamp, result.error ?? null, period);
  return { retry: result.retryAfter ? now.valueOf() + result.retryAfter : null, detail: result.error ?? '飞书已确认' };
}
