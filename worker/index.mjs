import { normalizeDoi, Problem, service } from './core.mjs';
import { reply, route } from './api.mjs';
import { tick } from './jobs.mjs';

function authorized(request, secret) {
  if (typeof secret !== 'string' || secret.length < 32) return false;
  const actual = new TextEncoder().encode(request.headers.get('authorization') ?? '');
  const expected = new TextEncoder().encode('Bearer ' + secret);
  return actual.length === expected.length && crypto.subtle.timingSafeEqual(actual, expected);
}

export default {
  async fetch(request, env) {
    if (!authorized(request, env.SCOUT_API_TOKEN)) return reply({ error: '未授权' }, 401);
    try {
      const url = new URL(request.url);
      const { pathname: path, searchParams } = url;
      if (path === '/__tick' && request.method === 'POST' && env.WORKER_TICK_ENABLED === 'true') {
        const scope = searchParams.get('scope');
        const doi = normalizeDoi(searchParams.get('doi'));
        if ((scope && !['collect', 'discover', 'analyze'].includes(scope)) || (scope === 'analyze' && !doi)) {
          throw new Problem(400, '请选择有效的手动任务范围；正文分析需要 DOI');
        }
        return reply(await tick(env, new Date(), { scope, doi }));
      }
      const s = service(env);
      const result = await route(s, request);
      if (env.WORKER_TICK_ENABLED === 'true') console.log(JSON.stringify({ event: 'scout_api', path, ...s.usage }));
      return result;
    } catch (error) {
      if (error instanceof Problem) return reply({ error: error.message }, error.status < 500 ? error.status : 503);
      console.error('Scout API error', String(error?.message ?? '').slice(0, 500));
      return reply({ error: 'Scout 服务暂不可用' }, 500);
    }
  },
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(tick(env, new Date(controller.scheduledTime)));
  }
};
