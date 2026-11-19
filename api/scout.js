import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const readActions = new Set(['overview','library','paper','export','reports','report','topics','journals','workspace','compare']);
const managementReads = new Set(['activity','search']);
const postActions = new Set(['lookup','backfill','screen','document','judgment','topic','topic-state','zotero','retry','feishu-reconcile']);
const cookieName = 'scout_session';
const maxBody = 310000;

function equal(a, b) {
  const digest = input => createHash('sha256').update(input).digest();
  return timingSafeEqual(digest(a), digest(b));
}

function sign(value, secret) {
  return createHmac('sha256', secret).update(value).digest('base64url');
}

function query(req, local) {
  const host = req.headers.host;
  if (!host || !/^[a-z0-9.:[\]-]+$/i.test(host)) return null;
  return new URL(req.url, (local ? 'http://' : 'https://') + host);
}

function session(req, secret) {
  const cookie = req.headers.cookie?.split(';').map(value => value.trim()).find(value => value.startsWith(cookieName + '='));
  const [expires, salt, signature] = cookie?.slice(cookieName.length + 1).split('.') ?? [];
  return /^\d{13}$/.test(expires ?? '') && Number(expires) > Date.now() && /^[a-zA-Z0-9_-]{20,25}$/.test(salt ?? '') &&
    /^[a-zA-Z0-9_-]{43}$/.test(signature ?? '') && equal(signature, sign(expires + '.' + salt, secret));
}

async function payload(req) {
  if (req.body !== undefined) {
    const value = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
    if (Buffer.byteLength(value ?? '') > maxBody) return null;
    return JSON.parse(value);
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBody) return null;
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function json(res, status, data) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(data));
}

export default async function handler(req, res) {
  res.setHeader('cache-control', 'private, no-store, max-age=0');
  res.setHeader('x-content-type-options', 'nosniff');
  const env = process.env;
  const local = env.SCOUT_LOCAL_DEV === 'true' && !env.VERCEL;
  const url = query(req, local);
  if (!url) return json(res, 400, { error: '请求地址无效' });
  const password = env.SCOUT_PASSWORD;
  const secret = env.SCOUT_SESSION_SECRET;
  const managementAvailable = (password?.length ?? 0) >= 24 && (secret?.length ?? 0) >= 32;
  const signedIn = managementAvailable && session(req, secret);
  const action = url.searchParams.get('action');
  const isPost = req.method === 'POST';
  if (isPost && (req.headers.origin !== url.origin || !/^application\/json(?:;|$)/i.test(req.headers['content-type'] ?? ''))) {
    return json(res, 403, { error: '请求来源不匹配' });
  }

  const cookie = cookieName + '=';
  const attributes = '; Path=/; HttpOnly; SameSite=Lax' + (local ? '' : '; Secure');
  if (action === 'session' && req.method === 'GET') {
    return json(res, 200, { signedIn, managementAvailable });
  }
  let body;
  if (isPost) {
    try { body = await payload(req); } catch { return json(res, 400, { error: '请求内容无法解析' }); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return json(res, 400, { error: '请求内容不符合限制' });
  }
  if (action === 'login' && isPost) {
    if (!managementAvailable) return json(res, 503, { error: '请配置 Scout 管理登录密钥' });
    if (typeof body.password !== 'string' || !equal(body.password, password)) return json(res, 401, { error: '口令不正确' });
    const value = String(Date.now() + 43200000) + '.' + randomBytes(16).toString('base64url');
    res.setHeader('set-cookie', cookie + value + '.' + sign(value, secret) + attributes + '; Max-Age=43200');
    return json(res, 200, { signedIn: true });
  }
  if (action === 'logout' && isPost) {
    res.setHeader('set-cookie', cookie + attributes + '; Max-Age=0');
    return json(res, 200, { signedIn: false });
  }
  const reading = req.method === 'GET' && readActions.has(action);
  const managing = req.method === 'GET' && managementReads.has(action) || isPost && postActions.has(action);
  const personal = req.method === 'GET' && action === 'personal' || isPost && action === 'workspace-entry';
  if (!reading && !managing && !personal) return json(res, 404, { error: '未找到请求' });
  if (!signedIn && managing) return json(res, 401, { error: '请登录 Scout 管理入口' });
  let personalOwner;
  if (personal) {
    const name = local ? 'scout_workspace' : '__Host-scout_workspace';
    const existing = req.headers.cookie?.split(';').map(value => value.trim()).find(value => value.startsWith(name + '='))?.slice(name.length + 1);
    if (isPost && !/^[A-Za-z0-9_-]{43}$/.test(existing ?? '')) return json(res, 409, { error: '请刷新工作台后再保存个人条目' });
    const key = /^[A-Za-z0-9_-]{43}$/.test(existing ?? '') ? existing : randomBytes(32).toString('base64url');
    res.setHeader('set-cookie', name + '=' + key + '; Path=/; HttpOnly; SameSite=Strict; Max-Age=34560000' + (local ? '' : '; Secure'));
    personalOwner = createHash('sha256').update(key).digest('hex');
  }

  try {
    const target = new URL('/' + action, env.SCOUT_WORKER_URL);
    const supported = target.protocol === 'https:' || local && ['localhost','127.0.0.1','[::1]'].includes(target.hostname);
    if (!supported || target.username || target.password || (env.SCOUT_API_TOKEN?.length ?? 0) < 32) {
      return json(res, 503, { error: 'Worker 地址或访问密钥配置无效' });
    }
    for (const [key, value] of url.searchParams) if (key !== 'action') target.searchParams.append(key, value);
    const response = await fetch(target, {
      method: req.method, headers: { authorization: 'Bearer ' + env.SCOUT_API_TOKEN, 'content-type': 'application/json',
        ...(personalOwner ? { 'x-scout-personal': personalOwner } : {}) },
      ...(isPost ? { body: JSON.stringify(body) } : {}), redirect: 'error', signal: AbortSignal.timeout(20000)
    });
    if (!signedIn && response.ok && (action === 'paper' || action === 'report' || action === 'topics')) {
      const data = await response.json();
      if (action === 'topics') return json(res, response.status, data.filter(row => row.status === 'candidate'));
      if (action === 'paper') delete data.zotero;
      if (action === 'report') delete data.telegram_id;
      return json(res, response.status, data);
    }
    res.statusCode = response.status;
    for (const name of ['content-type','content-disposition']) {
      const value = response.headers.get(name);
      if (value) res.setHeader(name, value);
    }
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch {
    json(res, 503, { error: 'Worker 暂不可用，请检查部署配置' });
  }
}
