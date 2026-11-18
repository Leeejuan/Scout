const worker = new URL(process.env.SCOUT_WORKER_URL ?? '');
const token = process.env.SCOUT_API_TOKEN;
if (worker.protocol !== 'https:' || worker.username || worker.password ||
    !/^scout-worker-staging\.[a-z0-9-]+\.workers\.dev$/.test(worker.host) || (token?.length ?? 0) < 32) {
  throw new Error('请在 .env.staging.local 中设置 staging Worker 地址及 SCOUT_API_TOKEN');
}
const [webUrl] = process.argv.slice(2);
let response;
try {
  response = await fetch(new URL('/__feishu-test', worker), {
    method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify(webUrl ? { webUrl } : {}), redirect: 'error', signal: AbortSignal.timeout(22000)
  });
} catch {
  console.error('测试请求结果无法确认，请先查看飞书群。');
  process.exit(1);
}
const result = await response.json().catch(() => null);
if (!response.ok || result?.sent !== true) {
  console.error(result?.error ?? '未确认送达（HTTP ' + response.status + '），请先查看飞书群。');
  process.exitCode = 1;
} else {
  console.log('飞书已接收测试卡片。群内链接 ' + result.reportUrl);
}
