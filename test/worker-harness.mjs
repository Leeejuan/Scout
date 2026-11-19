import worker from '../worker/index.mjs';
import { tick } from '../worker/jobs.mjs';
import { completion } from '../worker/extraction.mjs';
import { service } from '../worker/core.mjs';

const ai = {
  async run(_model, input) {
    const payload = JSON.parse(input.messages[1].content);
    if (payload.fail) throw new Error('simulated Workers AI failure');
    if (Array.isArray(payload)) {
      return { response: JSON.stringify({
        state: [{ text: '两项研究都记录了受众反应。', ids: [1, 2] }],
        consensus: [{ text: '结果依赖媒介情境。', ids: [1, 2] }],
        disagreements: [{ text: '样本存在差异，可进一步比较。', ids: [1, 2] }],
        gaps: [{ text: '不同媒体环境的可比性值得检验。', ids: [1, 2] }],
        topics: [{
          title: '跨平台隐私比较', question: '不同平台的隐私保护策略如何变化？',
          contribution: '将理论放入两个平台的情境检验。', type: '实证研究',
          primary: '结构化内容分析', alternative: '半结构化访谈', data: '平台公开内容，先确认使用许可',
          time: '三个月', ethics: '需审查账号匿名化和引用政策', ids: [1, 2]
        }]
      }) };
    }
    return { choices: [{ message: { content: JSON.stringify({ claims: [
      { field: 'findings', value: 'Users adjusted their privacy settings', quote: 'Users adjusted their privacy settings.' },
      { field: 'methods', value: 'regression', quote: 'The study addresses user confidence.' },
      { field: 'limitations', value: 'small sample', quote: 'The study addresses user confidence.' }
    ] }) } }] };
  }
};
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const bindings = { ...env, AI: ai };
    if (request.headers.get('Authorization') === 'Bearer ' + env.SCOUT_API_TOKEN) {
      if (url.pathname === '/test/tick') {
        const at = url.searchParams.get('now');
        return Response.json(await tick(bindings, at ? new Date(at) : new Date()));
      }
      if (url.pathname === '/test/budget') {
        try {
          return Response.json(await completion(service(bindings), 'Return JSON only', { fail: url.searchParams.has('fail') },
            new Date(url.searchParams.get('now'))));
        } catch (error) {
          return Response.json({ error: error.message }, { status: error.status ?? 500 });
        }
      }
    }
    return worker.fetch(request, bindings);
  },
  scheduled(controller, env, ctx) {
    return worker.scheduled(controller, { ...env, AI: ai }, ctx);
  }
};
