/**
 * Auto-categorisation.
 *
 * Production measured 55 raw categories for 10695 plugins, and the shape was
 * unusable as a filter:
 *
 *   cordis-plugin   2340   the framework's own name — a KIND, not a subject
 *   插件             290   "plugin" in Chinese — the same non-answer
 *   uncategorized   2204   unclassified, every one of them carrying a description
 *   ui / webui / skin / theme, and dev / code / devtools / tools   synonyms split apart
 *   23 categories    86   holding 1–17 plugins each: a filter that filters nothing
 *
 * So raw categories are treated as an input, not an answer. Each plugin is placed
 * in one of a fixed taxonomy: an alias table folds the synonyms and the generic
 * words away, and anything the table cannot place is classified from the plugin's
 * own name, description and topics — which is why `uncategorized` can be emptied
 * rather than merely renamed.
 *
 * The taxonomy is deliberately small. A category exists to be clicked, and a
 * bucket holding one plugin is a worse answer than the bucket it came from.
 */

/**
 * The taxonomy, in navigation order. `id` is stored on every plugin; the labels
 * are what the UI shows.
 *
 * English labels are deliberately ONE WORD each. The longest previous label
 * (`Market & plugin management`, 26 chars) does not fit the market's 168–240px
 * navigation column, and a wrapped or ellipsised category name loses the meaning
 * the label exists to carry — measured against the 19-entry index, wrapping would
 * also make that column taller than the panel. A category name is a navigation
 * label, not a description. Chinese labels stay as they are: 6–7 characters each.
 */
export const CATEGORIES = [
  { id: 'ui', en: 'Interface', zh: '界面' },
  { id: 'theme', en: 'Themes', zh: '主题皮肤' },
  { id: 'tools', en: 'Tools', zh: '工具' },
  { id: 'dev', en: 'Development', zh: '开发' },
  { id: 'agent', en: 'Agents', zh: '智能体与编排' },
  { id: 'memory', en: 'Memory', zh: '记忆与上下文' },
  { id: 'model', en: 'Models', zh: '模型接入' },
  { id: 'vision', en: 'Vision', zh: '视觉与多模态' },
  { id: 'voice', en: 'Voice', zh: '语音与音频' },
  { id: 'data', en: 'Data', zh: '数据与知识库' },
  { id: 'session', en: 'Sessions', zh: '会话与用量' },
  { id: 'notify', en: 'Channels', zh: '渠道与通知' },
  { id: 'browser', en: 'Browser', zh: '浏览器与网页' },
  { id: 'security', en: 'Security', zh: '安全与权限' },
  { id: 'market', en: 'Marketplace', zh: '市场与插件管理' },
  { id: 'desktop', en: 'Desktop', zh: '桌面与客户端' },
  { id: 'docs', en: 'Docs', zh: '文档与技能' },
  { id: 'fun', en: 'Fun', zh: '娱乐与生活' },
  { id: 'other', en: 'Other', zh: '其他' },
]

/** Canonical ids, for validation. */
export const CATEGORY_IDS = new Set(CATEGORIES.map((c) => c.id))

/** Labels by id, in the market's `categories` dictionary shape. */
export const CATEGORY_LABELS = Object.fromEntries(
  CATEGORIES.map(({ id, en, zh }) => [id, { en, zh }]),
)

/**
 * Raw category → canonical category.
 *
 * Every value here was observed in production. Synonyms are folded (`webui`,
 * `skin`, `外观` all describe the same subject) and the framework's own vocabulary
 * (`cordis-plugin`, `插件`, `dsh-plugin`) is mapped wherever a plugin tagged that
 * way also names a subject — see `KEYWORDS`, which runs for those.
 */
export const ALIASES = {
  // interface
  ui: 'ui', webui: 'ui', 'web ui': 'ui', interface: 'ui', interaction: 'ui',
  'input & navigation': 'ui', '侧边卡片': 'ui', panel: 'ui', 'chat-width': 'ui',
  // themes
  theme: 'theme', themes: 'theme', skin: 'theme', skins: 'theme', 外观: 'theme',
  'make-it-yours': 'theme', appearance: 'theme',
  // tools
  tools: 'tools', tool: 'tools', utility: 'tools', utilities: 'tools', 工具: 'tools',
  'files & runtime': 'tools', files: 'tools', file: 'tools', office: 'tools',
  // development
  dev: 'dev', devtools: 'dev', 'developer tools': 'dev', code: 'dev', coding: 'dev',
  'code quality': 'dev', git: 'dev', 'git-and-code-review': 'dev', 'auto-blame': 'dev',
  'boost-coding-workflow': 'dev', 'skill-pack': 'dev', latex: 'dev', ide: 'dev',
  'coding-agents': 'dev', test: 'dev', testing: 'dev', verify: 'dev',
  // agents
  agent: 'agent', agents: 'agent', orchestration: 'agent', workflow: 'agent',
  'workflow & automation': 'agent', 'run-a-team-of-agents': 'agent', subagent: 'agent',
  'multi-agent': 'agent', automation: 'agent', plan: 'agent', goal: 'agent',
  'domain-specific': 'agent', eco: 'agent',
  // memory
  memory: 'memory', context: 'memory', knowledge: 'memory', rag: 'memory',
  '记忆': 'memory', 'knowledge-base': 'memory', search: 'memory',
  'search-the-web': 'browser',
  // models
  model: 'model', models: 'model', llm: 'model', acp: 'model', provider: 'model',
  'model-adapters': 'model', inference: 'model', 'api': 'model',
  // vision
  vision: 'vision', multimodal: 'vision', image: 'vision', images: 'vision',
  ocr: 'vision', 视觉: 'vision', screenshot: 'vision',
  // voice
  voice: 'voice', audio: 'voice', asr: 'voice', tts: 'voice', speech: 'voice',
  // data
  data: 'data', database: 'data', sql: 'data', telemetry: 'data', analytics: 'data',
  log: 'data', logs: 'data', 'browse-files-and-data': 'data', export: 'data',
  // sessions
  session: 'session', sessions: 'session', usage: 'session', 'usage-cost-and-account-tracking': 'session',
  cost: 'session', stats: 'session', telemetry_session: 'session', history: 'session',
  // channels
  notify: 'notify', notification: 'notify', notifications: 'notify', channel: 'notify',
  chat: 'notify', feishu: 'notify', telegram: 'notify', wechat: 'notify', qq: 'notify',
  '消息': 'notify', remote: 'notify', bridge: 'notify',
  // browser
  browser: 'browser', web: 'browser', scrape: 'browser', crawl: 'browser',
  fetch: 'browser', 'browser-automation': 'browser', http: 'browser',
  // security
  security: 'security', sandbox: 'security', permission: 'security', auth: 'security',
  guard: 'security', 安全: 'security', secrets: 'security', wsl: 'security',
  // market
  market: 'market', marketplace: 'market', registry: 'market', plugin: 'market',
  'plugin-management': 'market', 'find-and-manage-plugins': 'market', inventory: 'market',
  'plugin-manager': 'market', store: 'market',
  // desktop
  desktop: 'desktop', client: 'desktop', clients: 'desktop', tauri: 'desktop',
  electron: 'desktop', cli: 'desktop', tui: 'desktop', 'cli-tui': 'desktop',
  mobile: 'desktop', android: 'desktop', ios: 'desktop', launcher: 'desktop',
  // docs
  docs: 'docs', doc: 'docs', documentation: 'docs', skill: 'docs', skills: 'docs',
  技能: 'docs', guide: 'docs', handbook: 'docs', translation: 'docs', locale: 'docs',
  i18n: 'docs', prompt: 'docs',
  // fun
  fun: 'fun', skin_fun: 'fun', pet: 'fun', game: 'fun', games: 'fun', ads: 'fun',
  娱乐: 'fun', lifestyle: 'fun', writing: 'fun', creative: 'fun', 'content': 'fun',
  'content-creation': 'fun', draw: 'fun', music: 'fun',
}

/**
 * Categories that say nothing about the subject. A plugin carrying one of these
 * is classified from its text instead, which is what empties the 2340 + 290 + 2204
 * generic bucket the raw catalogs produce.
 *
 * `market` is listed because a raw "market" tag on a UI panel says nothing about
 * the panel — the keyword table decides from the plugin's own words instead.
 */
export const GENERIC_CATEGORIES = new Set([
  'cordis-plugin', 'cordis', '插件', 'plugin', 'plugins', 'dsh-plugin', 'dsh',
  'uncategorized', 'unsorted', 'unclassified', 'other', 'others', 'misc',
  'general', 'collection', '合集', '项目', 'project', 'agi', 'identity',
  'find-and-manage-plugins', 'market',
])

/**
 * Keyword rules, first match wins, most specific first.
 *
 * Order carries the meaning, and two orderings were wrong until real data said so:
 *
 *   - `fun` must precede `notify`, or a **desktop pet** described as "QQ 宠物"
 *     matches the QQ channel rule and a toy is filed as a messaging bridge;
 *   - `notify`'s platform patterns must require a bot/channel word, so the same
 *     string cannot be read as a channel on its own.
 *
 * Patterns are matched against `name + description + topics`, so one table serves
 * the catalog's Chinese and English halves alike.
 */
const KEYWORDS = [
  { id: 'vision', patterns: [/视觉/, /识图/, /看图/, /ocr/i, /vision/i, /multimodal/i, /截图/, /screenshot/i, /图像/, /image (understanding|generation|gen)/i, /图像生成/, /看图说话/, /vlm\b/i] },
  { id: 'voice', patterns: [/\basr\b/i, /\btts\b/i, /语音/, /speech/i, /voice/i, /audio/i, /音频/, /录音/, /朗读/, /voiceover/i] },
  // Before `notify` and before `desktop`: a pet is not a channel and not a window.
  { id: 'fun', patterns: [/宠物/, /桌宠/, /桌面宠物/, /\bpet\b/i, /游戏/, /\bgame/i, /娱乐/, /趣味/, /小说/, /表情/, /emoji/i, /音乐/, /\bmusic/i, /壁纸/, /wallpaper/i, /皮肤商店/, /动画/, /彩蛋/, /摸鱼/] },
  { id: 'memory', patterns: [/记忆/, /memory/i, /recall/i, /上下文/, /context (window|database|panel|insight|management)/i, /\brag\b/i, /知识库/, /knowledge ?base/i, /蒸馏/, /distill/i, /persist/i, /embedding/i, /会话记忆/] },
  // Platform names require a channel word: bare "QQ" is a pet, "QQ 机器人" is a bridge.
  { id: 'notify', patterns: [/通知/, /notif/i, /提醒/, /飞书/, /feishu/i, /\blark\b/i, /telegram/i, /微信/, /wecom/i, /企业微信/, /钉钉/, /dingtalk/i, /qq\s*(bot|机器人|渠道|群)/i, /qqbot/i, /discord/i, /slack/i, /机器人/, /渠道/, /channel\b/i, /推送/] },
  // `guard` alone is too broad — a "writing guard" is a linter, not a security
  // boundary — so the pattern requires a security word beside it.
  { id: 'security', patterns: [/安全/, /security/i, /权限/, /permission/i, /sandbox/i, /沙箱/, /审批/, /approval/i, /安全守卫/, /自控守卫/, /权限守卫/, /\beguard\b/i, /\bguardrail/i, /审计/, /audit/i, /密钥/, /secret/i, /凭据/, /合规/, /白名单/, /逃逸/, /confine/i, /\bvetting\b/i, /\begress\b/i] },
  { id: 'model', patterns: [/模型/, /model (provider|adapter|router|selection|list)/i, /provider/i, /接入/, /推理强度/, /context window/i, /\bllm\b/i, /tokenizer/i, /适配器/, /路由(器)?注册/] },
  { id: 'session', patterns: [/会话/, /session/i, /用量/, /usage/i, /余额/, /balance/i, /费用/, /cost/i, /消耗/, /配额/, /quota/i, /统计/, /回滚/, /rewind/i, /分支(会话)?/, /历史记录/] },
  { id: 'data', patterns: [/数据库/, /database/i, /\bsql\b/i, /postgres/i, /sqlite/i, /数据分析/, /analytics/i, /telemetry/i, /遥测/, /日志/, /\blog(ging|s)\b/i, /excel/i, /电子表格/, /导出/, /爬取|归档/] },
  { id: 'browser', patterns: [/浏览器/, /browser/i, /chrome/i, /网页搜索/, /web ?(search|scrape|crawl)/i, /抓取/, /爬虫/, /playwright/i, /puppeteer/i, /网页/, /外链/] },
  { id: 'theme', patterns: [/主题/, /\btheme/i, /皮肤/, /\bskin/i, /字体/, /\bfont/i, /配色/, /palette/i, /\bcss\b/i, /外观/, /appearance/i, /样式/, /背景(图|色|自定义|切换)?/, /图库/, /壁纸/] },
  { id: 'desktop', patterns: [/桌面(端|版|客户端|应用)/, /desktop/i, /\btauri\b/i, /electron/i, /客户端/, /\btui\b/i, /\bcli\b/i, /终端/, /terminal/i, /启动器/, /launcher/i, /android/i, /\bios\b/i, /移动端/, /macos/i, /windows/i, /\bwebview/i] },
  { id: 'dev', patterns: [/代码/, /\bcode\b/i, /\bgit\b/i, /review/i, /审查/, /重构/, /refactor/i, /测试/, /test(ing|s)?\b/i, /lint/i, /类型检查/, /typescript/i, /调试/, /debug/i, /编译/, /\bbuild\b/i, /vscode/i, /\bide\b/i, /latex/i, /依赖/, /符号/, /symbol/i, /架构图/, /diagram/i, /codegraph/i, /monorepo/i, /代码质量/, /格式化/, /forges?\b/i, /插件开发/, /开发工具/] },
  { id: 'agent', patterns: [/智能体/, /\bagents?\b/i, /编排/, /orchestrat/i, /工作流/, /workflow/i, /多代理/, /子代理/, /subagent/i, /自主/, /autonomous/i, /规划/, /planning/i, /团队协作/, /swarm/i, /\bloop\b/i, /\bgoal\b/i, /深度研究/, /research/i, /skill 驱动/, /提示词工程/, /任务路由/, /a2a/i, /分布式/, /算力/, /组网/, /协作网络/, /代理(互联|网络)/] },
  // Before `ui`: "插件管理面板" is a market concern, and `ui`'s generic words
  // (面板/组件/卡片) would otherwise claim it first.
  { id: 'market', patterns: [/插件市场/, /marketplace/i, /市场/, /\bstore\b/i, /目录/, /catalog/i, /registry/i, /插件管理/, /plugin ?manager/i, /安装器/, /installer/i, /插件生态/, /插件中心/, /plugin cent(er|re)/i, /插件加载树/, /插件集合/, /plugin collection/i, /插件发现/] },
  { id: 'ui', patterns: [/界面/, /\bui\b/i, /面板/, /panel/i, /侧边栏/, /sidebar/i, /布局/, /layout/i, /卡片/, /card/i, /组件/, /component/i, /输入框/, /进度条/, /状态栏/, /状态行/, /导航/, /navbar/i, /分屏/, /拖拽/, /渲染/, /可视化/, /visuali[sz]/i, /仪表/, /dashboard/i, /画布/, /canvas/i, /弹窗/, /对话框/, /悬浮/, /宽度/, /选中/, /多选/, /广告/, /一键重启/, /交互/] },
  { id: 'docs', patterns: [/文档/, /\bdocs?\b/i, /技能/, /\bskill/i, /教程/, /指南/, /\bguide/i, /手册/, /handbook/i, /翻译/, /\bi18n\b/i, /语言包/, /locale/i, /提示词/, /prompt/i, /规范/, /\bstandard/i, /学习/, /learning/i, /知识分享/, /中文/, /预设编辑/] },
  { id: 'tools', patterns: [/工具/, /\btools?\b/i, /office/i, /文件/, /\bfile/i, /上传/, /upload/i, /下载/, /download/i, /剪贴板/, /clipboard/i, /快捷键/, /shortcut/i, /解释器/, /interpreter/i, /http ?client/i, /webhook/i, /\bmcp\b/i, /对象存储/, /\boss\b/i, /\bpdf/i, /\bssh\b/i, /诊断/, /diagnos/i, /提取/, /解析/, /本地解析/] },
]

/**
 * What the built-in rules say about a bare piece of text, or null.
 *
 * Exported for category discovery: a token that the curated rules already match is
 * not a missing category — it is a word the taxonomy handles — so discovery uses
 * this to reject its own noise.
 *
 * @param text - a token or phrase.
 * @returns `{ category, source }` or null.
 */
export function builtinMatch(text) {
  const haystack = String(text ?? '').toLowerCase()
  const alias = ALIASES[haystack]
  if (alias !== undefined && !GENERIC_CATEGORIES.has(haystack)) return { category: alias, source: 'alias' }
  for (const rule of KEYWORDS) {
    for (const pattern of rule.patterns) {
      if (pattern.test(haystack)) return { category: rule.id, source: alias === undefined ? 'keyword' : 'keyword-over-generic' }
    }
  }
  if (alias !== undefined) return { category: alias, source: 'alias-fallback' }
  return null
}

/** Whether the curated rules already place this text. */
export function matchesBuiltin(text) {
  return builtinMatch(text) !== null
}

/**
 * Classify one plugin.
 *
 * Order of authority:
 *   1. the raw category, when it names a subject the taxonomy knows and is not a
 *      generic word;
 *   2. the plugin's own text, curated rules first, most specific first;
 *   3. **discovered** rules, which is what makes the taxonomy extensible without a
 *      code change — they run after curation because they exist precisely for what
 *      curation missed;
 *   4. the raw category even when generic, if no rule matched at all;
 *   5. `other`.
 *
 * @param input - `rawCategory`, `name`, `description` (`{en, zh}`), `topics`, and
 *   `discovered` rules (`{id, patterns}`) from `ingest/categories.mjs`.
 * @returns `{ category, source }`; `source` records which step decided it, so the
 *   pipeline can report how much of the catalog was auto-classified.
 */
export function classify({ rawCategory, name = '', description = {}, topics = [], discovered = [] }) {
  const raw = String(rawCategory ?? '').trim().toLowerCase()
  const alias = ALIASES[raw]
  if (alias !== undefined && !GENERIC_CATEGORIES.has(raw)) return { category: alias, source: 'alias' }

  // A generic raw category, or one the table does not know: read the plugin.
  const haystack = [
    name,
    description.en ?? '',
    description.zh ?? '',
    ...(Array.isArray(topics) ? topics : []),
  ].join(' \u0000 ').toLowerCase()

  for (const rule of KEYWORDS) {
    for (const pattern of rule.patterns) {
      if (pattern.test(haystack)) return { category: rule.id, source: alias === undefined ? 'keyword' : 'keyword-over-generic' }
    }
  }

  for (const rule of discovered) {
    for (const pattern of rule.patterns) {
      if (pattern.test(haystack)) return { category: rule.id, source: 'discovered' }
    }
  }

  if (alias !== undefined) return { category: alias, source: 'alias-fallback' }
  if (CATEGORY_IDS.has(raw) && raw !== 'other') return { category: raw, source: 'raw' }
  return { category: 'other', source: 'unmatched' }
}

/**
 * Count plugins per category, in taxonomy order with `other` last.
 *
 * @param plugins - records carrying a canonical `category`.
 * @param extra - discovered categories (`{id, en, zh}`) to include as buckets.
 * @returns `[{ id, en, zh, count }]` including empty buckets, because a filter that
 *   hides its own zeroes looks like a bug when a category disappears.
 */
export function categoryCounts(plugins, extra = []) {
  const known = new Set(CATEGORIES.map((c) => c.id))
  const middle = CATEGORIES.filter((c) => c.id !== 'other')
  const last = CATEGORIES.filter((c) => c.id === 'other')
  // Discovered buckets sit before `other`, and a discovered id that collides with
  // a taxonomy id is ignored rather than duplicated.
  const extraBuckets = extra.filter((c) => c !== null && typeof c.id === 'string' && !known.has(c.id))
  const buckets = [...middle, ...extraBuckets, ...last]

  const counts = new Map(buckets.map((c) => [c.id, 0]))
  for (const plugin of plugins) {
    const id = counts.has(plugin.category) ? plugin.category : 'other'
    counts.set(id, (counts.get(id) ?? 0) + 1)
  }
  return buckets.map((c) => ({ id: c.id, en: c.en, zh: c.zh, count: counts.get(c.id) ?? 0 }))
}
