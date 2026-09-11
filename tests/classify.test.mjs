/**
 * Classification tests.
 *
 * Each case below is a real entry from the production catalog that an earlier
 * rule got wrong, or a shape the pipeline depends on. The rules were tuned by
 * looking at what 10695 plugins actually say, so the tests pin the decisions that
 * tuning produced — otherwise the next edit re-breaks them silently.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CATEGORIES, CATEGORY_IDS, classify, categoryCounts, GENERIC_CATEGORIES } from '../ingest/classify.mjs'

const of = (name, description = '', rawCategory = 'cordis-plugin', topics = []) =>
  classify({ rawCategory, name, description: { zh: description, en: '' }, topics })

test('the taxonomy is a closed set with bilingual labels', () => {
  assert.ok(CATEGORIES.length >= 12 && CATEGORIES.length <= 30, 'small enough to be clickable')
  for (const entry of CATEGORIES) {
    assert.ok(CATEGORY_IDS.has(entry.id))
    assert.equal(typeof entry.en, 'string')
    assert.equal(typeof entry.zh, 'string')
    assert.notEqual(entry.en, '', `${entry.id} needs an English label`)
    assert.notEqual(entry.zh, '', `${entry.id} needs a Chinese label`)
  }
  assert.equal(new Set(CATEGORIES.map((c) => c.id)).size, CATEGORIES.length, 'ids are unique')
})

test('a generic raw category never decides on its own', () => {
  for (const generic of ['cordis-plugin', '插件', 'uncategorized', 'plugin']) {
    assert.ok(GENERIC_CATEGORIES.has(generic), `${generic} must be treated as a non-answer`)
  }
  // With a describing name it is classified from the text …
  assert.equal(of('dsh-agent-teams', 'AgentTeams 多智能体团队').category, 'agent')
  // … and with nothing to go on it falls back honestly instead of guessing.
  const blank = of('', '', 'cordis-plugin')
  assert.equal(blank.category, 'other')
  assert.equal(blank.source, 'unmatched')
})

test('a desktop pet is not a messaging channel', () => {
  // The regression: "QQ 宠物" matched the QQ channel rule, so a toy was filed as
  // a bridge. `fun` now precedes `notify`, and the platform patterns require a
  // channel word.
  assert.equal(of('whale-girl', '桌面宠物（QQ 宠物形态）：右下角悬浮、可拖拽/投喂/玩耍').category, 'fun')
  // …while a real channel still lands in notify.
  assert.equal(of('qqbot', 'QQ 远程渠道').category, 'notify')
  assert.equal(of('dsh-feishu', '飞书远程渠道，流式卡片').category, 'notify')
})

test('a linter named "guard" is not a security boundary', () => {
  // `writing-guard` matched a bare /guard/ pattern and was filed as security.
  assert.notEqual(of('dsh-plugin-writing-guard', '论文写作守卫：本地正则检测修改过程残留').category, 'security')
  // Real guards still are.
  assert.equal(of('dsh-self-control-guard', '自控守卫：拦截 host-kill 尝试').category, 'security')
  assert.equal(of('egress-guard', '出站流量守卫与白名单').category, 'security')
  assert.equal(of('dsh-read-confine', '读取范围限制沙箱').category, 'security')
})

test('a plugin manager is a market concern, not a generic panel', () => {
  // `market` precedes `ui`, or ui's generic words (面板/组件) claim it first. The
  // description is the production one: "让插件加载树一目了然" is what places it,
  // which is why a market panel needs the plugin-specific wording to match.
  assert.equal(of('dsh-plugin-center', '在设置页里一站式查看、发现和管理 DeepSeek Harness 插件，让插件加载树一目了然').category, 'market')
  assert.equal(of('dsh-plugin-manager', '插件管理面板：已安装插件一键启用/停用').category, 'market')
  assert.equal(of('dsh-plugin-anti-ads', 'DSH Web 广告拦截器').category, 'ui', 'ad blocking is an interface concern')
})

test('the most specific subject wins over a generic one', () => {
  assert.equal(of('dsh-persist', '持久记忆：对话独有笔记、语义检索与自动召回').category, 'memory')
  assert.equal(of('dsh-genui', '助手回复内渲染交互式 UI 组件：布局、图表、表单').category, 'ui')
  assert.equal(of('dsh-skins', '官方 ThemeService 第三方皮肤').category, 'theme')
  assert.equal(of('dsh-cost-meter', '会话与当日 API 费用统计、余额').category, 'session')
  assert.equal(of('dsh-commandcode-provider', '非官方 Command Code 模型接入插件').category, 'model')
  assert.equal(of('dsh-vision-bridge', '把图片交给视觉模型自动描述').category, 'vision')
  assert.equal(of('weknora', '把文档变成可检索的知识库').category, 'memory')
})

test('aliases fold the raw synonyms into the taxonomy', () => {
  assert.equal(classify({ rawCategory: 'webui', name: 'x', description: {} }).category, 'ui')
  assert.equal(classify({ rawCategory: 'skin', name: 'x', description: {} }).category, 'theme')
  assert.equal(classify({ rawCategory: 'devtools', name: 'x', description: {} }).category, 'dev')
  assert.equal(classify({ rawCategory: 'skills', name: 'x', description: {} }).category, 'docs')
  assert.equal(classify({ rawCategory: 'channel', name: 'x', description: {} }).category, 'notify')
  assert.equal(classify({ rawCategory: 'sandbox', name: 'x', description: {} }).category, 'security')
  assert.equal(classify({ rawCategory: '遥测', name: 'x', description: {} }).category, 'other', 'an unknown alias still resolves somewhere')
})

test('classification reads topics too, not only the description', () => {
  assert.equal(classify({ rawCategory: 'cordis-plugin', name: 'x', description: {}, topics: ['vision', 'ocr'] }).category, 'vision')
})

test('the result always names its source, so auto-classification is measurable', () => {
  const allowed = new Set(['alias', 'alias-fallback', 'keyword', 'keyword-over-generic', 'raw', 'unmatched'])
  for (const result of [
    classify({ rawCategory: 'ui', name: 'x', description: {} }),
    of('dsh-persist', '记忆'),
    of('', ''),
  ]) {
    assert.ok(allowed.has(result.source), `unexpected source ${result.source}`)
    assert.ok(CATEGORY_IDS.has(result.category), `unexpected category ${result.category}`)
  }
})

test('category counts are complete and ordered by the taxonomy', () => {
  const plugins = [
    { category: 'memory' }, { category: 'memory' }, { category: 'ui' },
    { category: 'not-a-category' }, { category: undefined },
  ]
  const counts = categoryCounts(plugins)
  assert.equal(counts.length, CATEGORIES.length, 'every taxonomy bucket is reported, even at zero')
  assert.deepEqual(counts.map((c) => c.id), CATEGORIES.map((c) => c.id), 'taxonomy order, not frequency')
  const byId = Object.fromEntries(counts.map((c) => [c.id, c.count]))
  assert.equal(byId.memory, 2)
  assert.equal(byId.ui, 1)
  assert.equal(byId.other, 2, 'an unknown or missing category lands in other')
  assert.equal(byId.voice, 0)
  assert.equal(counts.reduce((sum, c) => sum + c.count, 0), plugins.length, 'counts cover every plugin')
})
