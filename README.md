# Scout · Communication Research Assistant

Scout 是面向传播学硕士研究的私人文献库。Vercel 提供检索、证据详情、选题与简报页面。Cloudflare Worker 负责采集和任务执行，Scout 专用 D1 保存文献、证据、检索进度和简报。你可以从单篇文献详情导出 BibTeX／RIS，或选中单篇写入 Zotero 收藏夹。

## 本地验证

使用 Node.js 24 和 npm。

```sh
npm ci
npm run check
npm test
npm run db:local
npm run deploy:check
npm run test:live
SCOUT_PROFILE=true npm run test:live
```

- `npm test` 在独立的本地 workerd 和 D1 上执行，模拟 Workers AI、Zotero、飞书和文献接口。测试不需要密钥。
- `npm run test:live` 用真实 DOI `10.1093/jcmc/zmaf025` 请求 Crossref 和 OpenAlex，然后在临时 D1 验证入库、去重、检索、详情和两种导出。若出版方类型字段无法自动核验，脚本按出版方页面做模拟人工筛查。测试只使用临时 D1。
- `SCOUT_PROFILE=true` 用本地 V8 的活跃样本数估计 Worker JavaScript CPU，输出各任务的 `jsSamplingMs`、D1 行数、查询数和外部请求数。采样会漏掉短调用和原生解析开销，Cloudflare 平台的计费 CPU 仍需预览验证。
- 本地网页登录需要把 `.env.example` 复制为 `.env.local`、把 `.dev.vars.example` 复制为 `.dev.vars.staging` 并填入同一个测试 API token。运行 `npm run worker:dev` 和 `npm run web:dev`。在本地 Worker 可用带 Bearer token 的 `POST /__tick` 领取一个任务，处理结束后刷新网页。也可用 `npm run test:live -- --serve` 临时预览测试 DOI，试用口令在该脚本中。

### 2026-11-18 验证记录

- 8 项自动测试通过，覆盖独立 D1 迁移、队列续跑、摘要缺项、正文定位与类型编码、Zotero 重复提交、AI 并发预算、登录保护、Telegram 确认及发送结果不明。
- 在线通过 Crossref 期刊页和 DOI 查找，以及 OpenAlex DOI 补全。用同一 DOI 在临时 D1 验证单条去重、详情接口、BibTeX 和 RIS。该样本的出版社 HTML 请求受到限制，证据状态保留为“仅摘要”。 [样本文献](https://doi.org/10.1093/jcmc/zmaf025)
- 生产和测试 Worker 均通过 Wrangler 打包试运行，三个迁移在本地 D1 执行通过。本地浏览器预览无法访问，详情与导出通过接口测试。

| 本地样本 | JavaScript CPU 采样估计 | D1 读／写行 | D1 语句／外部请求 |
| --- | ---: | ---: | ---: |
| 首次 DOI 采集 | 5.4 ms | 26／17 | 10／1 |
| OpenAlex 补全 | 3.3 ms | 18／19 | 11／1 |
| 正文不可访问分支 | 0.6 ms | 12／8 | 7／1 |
| 同一 DOI 再次采集 | 0.8 ms | 31／12 | 10／1 |
| 检索页（6 条，测试数据） | — | 79／58 | 24／1 |
| 生成简报（2 篇含核验发现，测试数据） | — | 78／22 | 25／1 |

远程预览仍需测量长正文解析和扩展期刊简报等高负载路径的 Cloudflare CPU，并核对账户实际用量。

## 部署顺序

### 1. 先核对 Compass 和 Cloudflare 账户

2026-11-18 核验的官方免费额度为 Workers AI 每账户每日 **10,000 Neurons**，00:00 UTC 重置。默认给 Compass 留 **1,000**，账户缓冲 **3,000**，Scout 最高 **6,000**。在实际部署当天，查看 Cloudflare **Workers AI → Usage** 的当日和近几日数据、Compass 的峰值及其他项目占用。设定 Scout 限额时使用 `max(0, min(6000, 当日官方额度 − 其他项目预算 − 3000))`，其他项目预算包括 Compass 至少 1,000。Scout 只知道自己的 D1 台账，账户余额需在账户仪表板核对。 [Workers AI 定价与用量](https://developers.cloudflare.com/workers-ai/platform/pricing/)

固定模型为 `@cf/meta/llama-3.1-8b-instruct-fp8-fast`。官方费率为每百万输入 token 4,119 Neurons、每百万输出 token 34,868 Neurons。Scout 将指令和输入 JSON 合计限制在 11,488 UTF-8 字节，预留 512 字节给消息封装，并限制最多 1,300 个输出 token。以 12,000 输入 token 及 1,300 输出 token 保守估算约 94.76 Neurons，调用前原子预留 300。每 UTC 日最多 20 次，失败和重试均计入。额度不足的任务顺延，检索和题录入库可继续。 [模型费率](https://developers.cloudflare.com/workers-ai/platform/pricing/)

Workers Free 每次定时运行的 CPU 上限为 10 ms，外部子请求上限为 50，D1 单次调用也受查询上限约束。每账户最多 5 条 Cron。确认 Compass 和其他 Worker 已用的条数，为 Scout 留一条。D1 免费账户每日额度为 500 万行读、10 万行写，账户总存储 5 GB。 [Worker 限额](https://developers.cloudflare.com/workers/platform/limits/) · [D1 限额](https://developers.cloudflare.com/d1/platform/limits/) · [D1 用量](https://developers.cloudflare.com/d1/platform/pricing/)

### 2. 先部署独立测试环境

```sh
npx wrangler login
npx wrangler d1 create scout-evidence-staging
# 将返回的 ID 填入 wrangler.jsonc 的 env.staging.d1_databases
npx wrangler d1 migrations apply SCOUT_DB --env staging --remote
npx wrangler deploy --env staging
npx wrangler secret put SCOUT_API_TOKEN --env staging
npx wrangler secret put OPENALEX_API_KEY --env staging
```

测试环境无 Cron，AI 额度为 0，飞书自动推送关闭。测量用的部署可临时设置测试 Worker 的 `WORKER_TICK_ENABLED=true`，用测试 API token 触发 `POST /__tick`。以真实大小的更新页、长正文、简报和 Zotero 列表分别跑样本，查看 **Workers → Observability** 的 CPU、日志指标和 D1 的 Row Metrics。任务页展示 D1 返回的阶段行数及请求计数，日志 `scout_tick` 含额外的维护语句和总耗时。CPU 接近 10 ms 或超限时，先降低 `CROSSREF_PAGE_ROWS`（1–6）或停用相应正文来源，再启用生产。 [Cloudflare Metrics](https://developers.cloudflare.com/workers/observability/metrics-and-analytics/)

Zotero 用专用测试库（或空白收藏夹及测试 API key），同一 DOI 连续写入两次并检查库内条目和子笔记数量。飞书使用下方的独立测试入口验证送达和按钮跳转。为验证真实的 AI 调用，把测试额度临时设为 300–600，借用额度前查账户余量。真实定时触发需生产启用后通过 Cron Events 核验。

#### 手动发送一张飞书测试卡片

1. 在飞书群的机器人设置中复制完整 Webhook 地址和已启用签名校验的密钥。在 **Cloudflare → Workers & Pages → scout-worker-staging → Settings → Variables and Secrets** 新增两个 **Secret**，分别命名为 `FEISHU_WEBHOOK_URL`、`FEISHU_SIGNING_SECRET`。也可在项目目录运行以下命令，按提示分别粘贴。

```sh
npx wrangler secret put FEISHU_WEBHOOK_URL --env staging
npx wrangler secret put FEISHU_SIGNING_SECRET --env staging
```

2. 确认 `.env.staging.local` 包含已部署的 `SCOUT_WORKER_URL` 和匹配的 `SCOUT_API_TOKEN`。在项目目录执行一次下方命令，把示例网址换成已连接 staging 的 Vercel Preview HTTPS 地址。也可先在 staging Worker 设置 `SCOUT_WEB_URL`，然后省略网址参数。

```sh
npm run feishu:test -- https://你的-preview.vercel.app
```

成功时终端确认飞书已接收。打开群内的「Scout 飞书推送测试」卡片，点「查看完整简报」，登录 Scout 后应看到测试简报。测试入口只在 staging 开启，需要 Worker token。测试无需生成报告，也无需开启自动推送、Cron 或 AI。若返回发送结果无法确认，先检查群内消息再决定是否重试。 [飞书自定义机器人指南](https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot)

### 3. 建立生产 D1 与 Worker

```sh
npx wrangler d1 create scout-evidence
# 将返回的 ID 填入 wrangler.jsonc 的生产 d1_databases
npx wrangler d1 migrations apply SCOUT_DB --remote
npx wrangler deploy --env=""
npx wrangler secret put SCOUT_API_TOKEN
npx wrangler secret put OPENALEX_API_KEY
npx wrangler secret put ZOTERO_API_KEY
npx wrangler secret put ZOTERO_LIBRARY_ID
npx wrangler secret put ZOTERO_COLLECTION_KEY
npx wrangler secret put FEISHU_WEBHOOK_URL
npx wrangler secret put FEISHU_SIGNING_SECRET
npx wrangler secret put SCOUT_WEB_URL
# 可选，为 Crossref 提供联系人邮箱
npx wrangler secret put CROSSREF_MAILTO
```

`SCOUT_DB` 绑定 Scout 专用 D1，`AI` 绑定 Workers AI。数据库 ID 示例值需要分别替换。账号 ID 如需固定，通过 Wrangler 账号选择或 `CLOUDFLARE_ACCOUNT_ID` 配置。

| Worker 配置 | 用途 |
| --- | --- |
| `SCOUT_API_TOKEN` | 至少 32 字符，和 Vercel 一致，预览和生产使用不同值 |
| `OPENALEX_API_KEY` | 免费 key，生产建议配置。DOI 单条元数据查询目前免费 |
| `CROSSREF_MAILTO` | 可选，Crossref polite pool 联系邮箱 |
| `CROSSREF_PAGE_ROWS` | 每个检索任务最多处理的 Crossref 条目数，默认 6，可降为 1–5 |
| `OPENALEX_FULLTEXT_MAX_DAILY` | 可选，默认 0。最多 30 次带 key 的 OA TEI 下载，按当前每次 $0.01 计，使用 OpenAlex 免费账户时要核对同一账号其他用量 |
| `ZOTERO_API_KEY`、`ZOTERO_LIBRARY_ID`、`ZOTERO_COLLECTION_KEY` | 指定可读写的用户库或群组库与 8 字符收藏夹 key |
| `ZOTERO_LIBRARY_TYPE` | 默认 `users`，群组用 `groups` |
| `FEISHU_WEBHOOK_URL`、`FEISHU_SIGNING_SECRET` | 飞书群自定义机器人的 Webhook 和签名校验密钥，均使用 Worker Secrets |
| `SCOUT_WEB_URL` | Vercel 的 HTTPS 地址，供简报链接使用 |
| `SCOUT_AI_DAILY_NEURONS` | 经账户用量核验后的上限，代码强制最高 6,000 |
| `JOURNAL_TIER` | 默认试运行，填 `expanded` 启用扩展期刊 |
| `SCHEDULE_ENABLED`、`FEISHU_ENABLED` | 自动检索和简报推送开关，均默认为 `false` |
| `FEISHU_TEST_ENABLED` | 仅 staging 开启，允许使用 Worker token 手动发送测试卡片 |
| `WORKER_TICK_ENABLED` | 生产保持 `false`，仅测试环境开放手工领取接口 |

### 4. 连接 Vercel Hobby

在 Vercel 导入 GitHub 的 Scout 仓库，项目根目录保持仓库根，使用仓库中的 `vercel.json` 和 Node.js 24。以下四个变量放在 Vercel 服务端环境。Preview 环境指向测试 Worker，Production 环境指向生产 Worker。

| Vercel 变量 | 值 |
| --- | --- |
| `SCOUT_WORKER_URL` | 对应 Worker 的 HTTPS 基础地址 |
| `SCOUT_API_TOKEN` | 同环境的 Cloudflare Secret |
| `SCOUT_PASSWORD` | 自行生成的至少 24 字符高熵访问口令 |
| `SCOUT_SESSION_SECRET` | 自行生成的至少 32 字符随机签名密钥 |

登录、Cookie 和 Worker token 由服务端校验。公开网页只含界面，数据、报告和导出均需要登录。链接可在登录后回到原简报。飞书卡片中的简报摘要对目标群成员可见，完整简报继续需要登录。

### 5. 试运行和启用

1. 在“任务与覆盖”用一个 DOI 试验，完成单篇筛查后打开详情和导出。初始清单两本期刊，确认流程后启动回填。
2. 将 `SCHEDULE_ENABLED` 改为 `true`，部署后核验下一次 1 日或 16 日的运行。唯一 Cron 为 `*/10 * * * *`，每次最多领取一个任务。马来西亚时间 08:00 起安排该期更新，正常在更新核验完成后生成，11:00 起允许按当时的数据生成并注明尚未完成的任务。
3. 飞书卡片验收通过后，在生产开启 `FEISHU_ENABLED`。只有具备新增正文发现或选题变化的简报才推送。发送超时、服务端错误或中断后先在群内核对，再从简报页确认已收到或确认未收到后重试。切换渠道时保留历史 Telegram 发送记录，历史待发送队列停止。
4. 试运行稳定后，将 `JOURNAL_TIER` 设为 `expanded`，部署并启动扩展回填。期刊政策和期刊研究领域可在网页中核对。

## 证据和覆盖边界

- 扫描范围为版本化期刊清单，滚动三年，全球检索且无国家排除过滤。初始清单包含马来西亚及亚太期刊。领域和地域标签来自可见文本及 OpenAlex 主题线索，地域标签不以作者机构国家代替研究情境。多个标签可共存，关键词匹配可能漏标。
- Crossref 的 `journal-article` 和 OpenAlex 的通用 `article` 只用于候选发现。明确的研究类单篇类型或人工筛查后才入正式库。社论、书评、预印本、撤稿等进入排除状态。各期刊分类粒度不同，扩大范围后仍需处理待筛查队列。
- 搜索按期刊与日期分片，持久化 offset、范围和错误。Crossref 游标短于本项目 10 分钟领取间隔，因此用有界 offset，并用 7 天重叠索引窗口及 DOI 去重处理索引变动和延迟。已知遗漏、未完成分片与外部失败保留在任务与简报，偏移分页本身可能受索引变动影响。
- 来源优先使用可访问的开放出版方 HTML、Europe PMC JATS 和可配置的 OpenAlex TEI。链接可用也可能遇到访问拦截、权限或格式问题。此时可用 `pdftotext -layout article.pdf article.txt` 本地转换已获准使用的文献，再从详情页导入。完整正文与节选分别标记。AI 只写入可回查的逐字引文，摘要缺失的内容保持待核验。人工判断要求可定位原文。PDF 页码是转换文件的页序，章节位置来自文本源。
- 趋势按清单内可比较的发表窗口计算。共识、分歧、候选缺口基于有限的正文样本，报告展示依据 DOI，并明确保留分歧对照中的未知字段。选题建议中的数据渠道和伦理条件须自行核对。
- Zotero 同步逐条触发，按全库 DOI 核对，写入使用 API 版本前置条件。已有条目只追加收藏夹。已有阅读笔记与标签保持原样。第一次有可用分析时新增一条 Scout 子笔记，后续同步核对该子笔记。PDF、全文和未选条目不复制到 Zotero。 [Zotero Web API 写入](https://www.zotero.org/support/dev/web_api/v3/write_requests)
