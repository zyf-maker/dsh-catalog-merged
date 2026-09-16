/**
 * DSH Market — the published page.
 *
 * One data path: the whole `data/catalog.json` artifact is loaded and filtered in
 * the browser. The settings-section market reads the same artifact and applies
 * the same module, so a row is never a plugin in one place and a shell in the
 * other. An earlier revision preferred the Worker API and fell back to the static
 * artifact, which meant two answers to every question the reader asks — the
 * page listed 11538 rows while the market listed 10333.
 *
 * The quality rules are NOT reimplemented here. `shared/quality.mjs` is the same
 * file `ingest/index.mjs` imports, published next to this page, so "is this a
 * shell?" and "in what order?" have exactly one answer.
 *
 * Install: handed to a DSH host through the market plugin's bridge
 * (`window.dshMarket.install`). Opened standalone there is no bridge, so the
 * button copies the exact command rather than pretending to install.
 */
import { annotateCatalog, compareRecommended } from '../shared/quality.mjs'

const PAGE = 60

/** Risk flags, phrased for a reader. */
const RISK = {
  'terminal surface': { zh: '终端界面', en: 'Terminal' },
  'requires credentials': { zh: '需要凭据', en: 'Credentials' },
  'install script': { zh: '含安装脚本', en: 'Install script' },
}

const state = {
  all: [],
  categories: {},
  category: '',
  query: '',
  sort: 'score',
  kind: '',
  page: 1,
  updated: '',
  counts: { unverified: 0, verified: 0, recommended: 0 },
}

const el = (id) => document.getElementById(id)

/** The whole catalog, screened once. */
async function load() {
  try {
    const res = await fetch('../data/catalog.json', { headers: { accept: 'application/json' } })
    if (!res.ok) throw new Error(`catalog HTTP ${res.status}`)
    const raw = await res.json()
    // Idempotent: rows the pipeline already annotated keep their verdict, so a
    // host-enriched row is never re-judged here.
    const { catalog, counts } = annotateCatalog(raw)
    state.updated = catalog.updated ?? ''
    state.categories = catalog.categories ?? {}
    state.counts = counts
    state.all = catalog.plugins.filter((p) => p.qualityState !== 'unverified')
    render()
  } catch (error) {
    // A failed fetch is reported as a failure, never as an empty market:
    // "no plugins" and "could not ask" must not look the same.
    el('list').innerHTML = ''
    el('cats').innerHTML = ''
    el('status').innerHTML = `目录加载失败：${escapeHtml(String(error.message ?? error))}
      <button class="retry" id="retry">重试</button>`
    el('retry').addEventListener('click', () => { void load() })
  }
}

/** Rows matching the current search, category and install-kind. */
function matched() {
  const q = state.query.toLowerCase()
  return state.all.filter((p) => {
    if (state.category !== '' && (p.category ?? 'other') !== state.category) return false
    if (state.kind !== '' && (p.targetKind ?? '') !== state.kind) return false
    if (q === '') return true
    return `${p.name} ${p.owner} ${p.description?.en ?? ''} ${p.description?.zh ?? ''} ${(p.topics ?? []).join(' ')}`
      .toLowerCase().includes(q)
  })
}

function ordered(rows) {
  if (state.sort === 'stars') return [...rows].sort((a, b) => (b.stars - a.stars) || a.name.localeCompare(b.name))
  if (state.sort === 'downloads') return [...rows].sort((a, b) => (b.downloads - a.downloads) || a.name.localeCompare(b.name))
  if (state.sort === 'newest') return [...rows].sort((a, b) => String(b.added).localeCompare(String(a.added)) || a.name.localeCompare(b.name))
  if (state.sort === 'name') return [...rows].sort((a, b) => a.name.localeCompare(b.name))
  return [...rows].sort(compareRecommended)
}

/** Paint the chips, the status line and one page of cards. */
function render() {
  const rows = ordered(matched())
  const total = state.all.length
  const visible = rows.slice(0, state.page * PAGE)

  el('counts').textContent = `${total} 个插件 · ${state.updated ? new Date(state.updated).toLocaleString() : '实时'}`

  // Category counts describe the screened catalog, not the current page: a count
  // taken over the page would change as the reader scrolls.
  const counts = new Map()
  for (const p of state.all) {
    const id = p.category ?? 'other'
    counts.set(id, (counts.get(id) ?? 0) + 1)
  }
  const chips = [...counts.entries()].sort((a, b) => b[1] - a[1])
  el('cats').innerHTML = [
    chipHtml('', labelOf(''), total, state.category === ''),
    ...chips.map(([id, n]) => chipHtml(id, labelOf(id), n, state.category === id)),
  ].join('')

  el('status').innerHTML = `显示 ${visible.length} / 匹配 ${rows.length} / 共 ${total}`
    + (state.counts.unverified > 0 ? ` · 已筛选 ${state.counts.unverified} 个空壳条目` : '')

  el('list').innerHTML = visible.length === 0
    ? '<div class="empty">没有匹配的插件</div>'
    : visible.map(card).join('')

  const more = el('more')
  if (more !== null) more.remove()
  if (visible.length < rows.length) {
    const button = document.createElement('button')
    button.className = 'more'
    button.id = 'more'
    button.textContent = '加载更多'
    button.addEventListener('click', () => { state.page += 1; render() })
    el('list').after(button)
  }
}

function chipHtml(id, label, count, active) {
  return `<button class="chip" data-cat="${escapeAttr(id)}" aria-pressed="${active}">${escapeHtml(label)} <span class="chip-count">${count}</span></button>`
}

function labelOf(id) {
  if (id === '') return '全部'
  const meta = state.categories[id]
  return String(meta?.zh || meta?.en || id || '未分类')
}

/**
 * The description to show, or ''.
 *
 * A Chinese description is used only when it contains Chinese: 792 of the
 * catalog's `zh` strings are byte-identical to their English twin and 555 carry
 * no CJK at all, so preferring `zh` blindly would label English prose as the
 * Chinese version.
 */
function descriptionOf(plugin) {
  const zh = String(plugin.description?.zh ?? '').trim()
  const en = String(plugin.description?.en ?? '').trim()
  if (/[\u4e00-\u9fff]/.test(zh)) return zh
  return en !== '' ? en : zh
}

/**
 * A stable avatar for one owner, derived from the repository path rather than
 * the `owner` field: 94 rows disagree between the two and the field holds
 * npm-ish handles that would 404 or resolve to a stranger.
 */
function avatarOf(plugin) {
  const login = String(plugin.repoPath ?? '').split('/')[0] || String(plugin.owner ?? '').trim()
  const valid = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(login)
  let hue = 0
  for (let i = 0; i < login.length; i += 1) hue = (hue * 31 + login.charCodeAt(i)) % 360
  return {
    src: valid ? `https://github.com/${login}.png?size=64` : null,
    initial: (login.replace(/[^A-Za-z0-9]/g, '')[0] ?? '?').toUpperCase(),
    hue,
  }
}

/** Compact numbers, so a count never widens a card. */
const fmt = (n) => {
  const value = Number(n) || 0
  if (value >= 1000000) return `${(value / 1000000).toFixed(1)}M`
  if (value >= 1000) return `${(value / 1000).toFixed(value >= 10000 ? 0 : 1)}k`
  return String(value)
}

/** One card. */
function card(plugin) {
  const avatar = avatarOf(plugin)
  const description = descriptionOf(plugin)
  const flags = (plugin.riskFlags ?? []).filter((flag) => RISK[flag] !== undefined)
  // Zero values are not rendered: a third of the catalog has neither stars nor
  // downloads, and two dead zeros read as "worthless" when the truth is "no data".
  const hasStars = plugin.stars > 0
  const hasDownloads = plugin.downloads > 0
  const silent = !hasStars && !hasDownloads
  const sourceCount = Array.isArray(plugin.sources) ? plugin.sources.length : 0
  const installable = plugin.installable === true
  const badge = plugin.qualityState === 'recommended' ? '推荐' : plugin.qualityState === 'verified' ? '已验证' : ''
  return `<article class="card">
    <div class="head">
      <span class="avatar" style="--hue:${avatar.hue}">${
        avatar.src !== null
          ? `<img src="${escapeAttr(avatar.src)}" alt="" width="28" height="28" loading="lazy" decoding="async" onerror="this.replaceWith(document.createTextNode('${escapeAttr(avatar.initial)}'))">`
          : escapeHtml(avatar.initial)
      }</span>
      <div class="headtext">
        <a class="name" href="${escapeAttr(plugin.url)}" target="_blank" rel="noreferrer" title="${escapeAttr(plugin.name)}">${escapeHtml(plugin.name)}</a>
        <span class="owner" title="${escapeAttr(plugin.owner ?? '')}">${escapeHtml(plugin.owner ?? '')}</span>
      </div>
      <button class="install" data-install="${escapeAttr(plugin.install)}" data-name="${escapeAttr(plugin.name)}"
        ${installable ? '' : 'disabled'} title="${escapeAttr(installable ? plugin.install : '未能验证安装方式')}">${
        installable ? '安装' : '不可安装'}</button>
    </div>
    ${description !== '' ? `<p class="desc">${escapeHtml(description)}</p>` : ''}
    <div class="meta">
      <span class="tag kind-${escapeAttr(plugin.targetKind ?? 'unknown')}">${escapeHtml(plugin.targetKind ?? 'unknown')}</span>
      ${badge !== '' ? `<span class="tag good">${badge}</span>` : ''}
      ${silent && sourceCount > 0 ? `<span class="num">${sourceCount} 处收录</span>` : ''}
      ${hasStars ? `<span class="num">★ ${fmt(plugin.stars)}</span>` : ''}
      ${hasDownloads ? `<span class="num">↓ ${fmt(plugin.downloads)}</span>` : ''}
      ${flags.map((flag) => `<span class="tag warn" title="${escapeAttr(flag)}">${escapeHtml(RISK[flag].zh)}</span>`).join('')}
    </div>
  </article>`
}

/**
 * Install through the host bridge. A standalone page has no bridge, so it hands
 * the user the exact command rather than showing a dead button.
 */
async function install(button) {
  const target = button.dataset.install
  const name = button.dataset.name
  button.disabled = true
  const original = button.textContent
  try {
    if (typeof window.dshMarket?.install === 'function') {
      button.textContent = '安装中…'
      const result = await window.dshMarket.install(target)
      button.textContent = result?.ok === false ? '失败' : '已安装'
      if (result?.repair?.notes?.length) showDetail({ name, install: target, repair: result.repair })
    } else {
      await navigator.clipboard?.writeText(target)
      button.textContent = '命令已复制'
    }
  } catch (error) {
    button.textContent = '失败'
    console.error(error)
  }
  setTimeout(() => { button.disabled = false; button.textContent = original }, 2200)
}

/** Show one plugin's detail, including any repair the install needed. */
function showDetail(plugin) {
  el('detailBody').innerHTML = `<h3>${escapeHtml(plugin.name ?? '')}</h3>
    <p class="desc">${escapeHtml(plugin.description?.zh || plugin.description?.en || '')}</p>
    <p><code>${escapeHtml(plugin.install ?? '')}</code></p>
    ${plugin.repair ? `<h4>兼容修复</h4><ul>${plugin.repair.notes.map((n) => `<li>${escapeHtml(n)}</li>`).join('')}</ul>
      <pre>${escapeHtml(JSON.stringify(plugin.repair.overlay, null, 2))}</pre>` : ''}
    <p><button onclick="document.getElementById('detail').close()">关闭</button></p>`
  el('detail').showModal()
}

const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const escapeAttr = escapeHtml

// ------------------------------------------------------------------ wiring
let timer
el('q').addEventListener('input', (event) => {
  clearTimeout(timer)
  // Re-filter after a pause, then start over: appending to a list filtered
  // differently would mix two result sets.
  timer = setTimeout(() => { state.query = event.target.value.trim(); state.page = 1; render() }, 220)
})
el('sort').addEventListener('change', (event) => { state.sort = event.target.value; state.page = 1; render() })
el('kind').addEventListener('change', (event) => { state.kind = event.target.value; state.page = 1; render() })
el('cats').addEventListener('click', (event) => {
  const button = event.target.closest('button[data-cat]')
  if (button === null) return
  state.category = button.dataset.cat
  state.page = 1
  render()
})
el('list').addEventListener('click', (event) => {
  const button = event.target.closest('button[data-install]')
  if (button !== null) void install(button)
})
// `/` focuses the search box, the one shortcut worth owning here.
document.addEventListener('keydown', (event) => {
  if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey) return
  const active = document.activeElement
  const typing = active !== null && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable === true)
  if (typing) return
  event.preventDefault()
  el('q').focus()
})

void load()
