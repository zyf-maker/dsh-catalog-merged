/**
 * DSH Market — market UI.
 *
 * Data plane: `/api/v1` when the Worker is deployed, otherwise the static
 * `data/*.json` artifacts the ingest run publishes. Both answer the same
 * questions, so the UI never depends on a server being up.
 *
 * Install: handed to the DSH host through the market plugin's bridge
 * (`window.dshMarket.install`). When the page is opened standalone there is no
 * bridge, so the button copies the exact command instead of pretending to
 * install.
 */

const API = new URL('../api/v1', location.href).href
const STATIC = new URL('../data/', location.href).href

const state = {
  plugins: [],
  categories: {},
  category: '',
  query: '',
  sort: 'score',
  kind: '',
  page: 1,
  limit: 50,
  total: 0,
  server: true,
  updated: '',
}

const el = (id) => document.getElementById(id)

/** Fetch JSON with a static fallback, so the UI works with or without the API. */
async function getJson(path, fallbackPath) {
  try {
    const res = await fetch(path, { headers: { accept: 'application/json' } })
    if (res.ok) return await res.json()
  } catch { /* fall through to the static artifact */ }
  if (fallbackPath === undefined) throw new Error(`no data at ${path}`)
  state.server = false
  const res = await fetch(fallbackPath, { headers: { accept: 'application/json' } })
  if (!res.ok) throw new Error(`no data at ${fallbackPath}`)
  return await res.json()
}

/** Load one page of the catalog. */
async function load() {
  const params = new URLSearchParams({ page: String(state.page), limit: String(state.limit), sort: state.sort })
  if (state.query !== '') params.set('q', state.query)
  if (state.category !== '') params.set('category', state.category)
  if (state.kind !== '') params.set('kind', state.kind)

  if (state.server) {
    try {
      const data = await getJson(`${API}/plugins?${params}`)
      state.plugins = data.plugins ?? []
      state.total = data.total ?? state.plugins.length
      render()
      return
    } catch { state.server = false }
  }
  // Static mode: one artifact holds the whole catalog, so filter in the client.
  const data = await getJson(`${STATIC}catalog.json`, '../data/catalog.json')
  state.updated = data.updated ?? ''
  state.categories = data.categories ?? {}
  let rows = data.plugins ?? []
  if (state.query !== '') {
    const q = state.query.toLowerCase()
    rows = rows.filter((p) => `${p.name} ${p.owner} ${p.description?.en ?? ''} ${p.description?.zh ?? ''}`.toLowerCase().includes(q))
  }
  if (state.category !== '') rows = rows.filter((p) => p.category === state.category)
  if (state.kind !== '') rows = rows.filter((p) => p.targetKind === state.kind)
  if (state.sort === 'stars') rows = [...rows].sort((a, b) => b.stars - a.stars)
  else if (state.sort === 'downloads') rows = [...rows].sort((a, b) => b.downloads - a.downloads)
  else if (state.sort === 'name') rows = [...rows].sort((a, b) => a.name.localeCompare(b.name))
  state.total = rows.length
  state.plugins = rows.slice((state.page - 1) * state.limit, state.page * state.limit)
  render()
}

/** Paint the current page and the sidebar. */
function render() {
  const list = el('list')
  if (state.plugins.length === 0) {
    list.innerHTML = '<div class="empty">没有匹配的插件</div>'
  } else {
    list.innerHTML = state.plugins.map(card).join('')
  }
  el('counts').textContent = `${state.total} 个插件 · ${state.server ? 'API' : '静态'} · ${
    state.updated ? new Date(state.updated).toLocaleString() : '实时'}`

  const cats = Object.keys(state.categories).length > 0
    ? Object.entries(state.categories).map(([id]) => [id, state.plugins.filter((p) => p.category === id).length])
    : topCategories(state.plugins)
  el('cats').innerHTML = [`<button data-cat="" aria-pressed="${state.category === ''}">全部 <span>${state.total}</span></button>`]
    .concat(cats.map(([id, n]) => `<button data-cat="${escapeAttr(id)}" aria-pressed="${state.category === id}">${escapeHtml(id || '未分类')} <span>${n}</span></button>`))
    .join('')
}

/** Categories present on the current page, for static mode. */
function topCategories(rows) {
  const counts = new Map()
  for (const p of rows) counts.set(p.category || '未分类', (counts.get(p.category || '未分类') ?? 0) + 1)
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)
}

/** One result card. Position uses the page offset so page 2 keeps counting. */
function card(p, index) {
  const position = (state.page - 1) * state.limit + index + 1
  const description = p.description?.zh || p.description?.en || ''
  const kind = p.targetKind ?? p.target_kind ?? ''
  const install = p.install ?? p.install_target ?? ''
  return `<article class="card">
    <div class="rank">${position}</div>
    <div>
      <h4><a href="${escapeAttr(p.url)}" target="_blank" rel="noreferrer">${escapeHtml(p.name)}</a>
        <span class="num">${escapeHtml(p.owner ?? '')}</span></h4>
      <div class="desc">${escapeHtml(description)}</div>
      <div class="meta">
        <span class="tag kind-${escapeAttr(kind)}">${escapeHtml(kind)}</span>
        ${p.category ? `<span class="tag">${escapeHtml(p.category)}</span>` : ''}
        <span class="num">★ <b>${fmt(p.stars)}</b></span>
        <span class="num">↓ <b>${fmt(p.downloads)}</b></span>
        <span class="num">score <b>${fmt(p.score)}</b></span>
      </div>
    </div>
    <button class="install" data-install="${escapeAttr(install)}" data-name="${escapeAttr(p.name)}">安装</button>
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

const fmt = (n) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n ?? 0))
const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const escapeAttr = escapeHtml

// ------------------------------------------------------------------ wiring
let timer
el('q').addEventListener('input', (event) => {
  clearTimeout(timer)
  timer = setTimeout(() => { state.query = event.target.value.trim(); state.page = 1; void load() }, 220)
})
el('sort').addEventListener('change', (event) => { state.sort = event.target.value; state.page = 1; void load() })
el('kind').addEventListener('change', (event) => { state.kind = event.target.value; state.page = 1; void load() })
el('cats').addEventListener('click', (event) => {
  const button = event.target.closest('button[data-cat]')
  if (button === null) return
  state.category = button.dataset.cat
  state.page = 1
  void load()
})
el('list').addEventListener('click', (event) => {
  const button = event.target.closest('button[data-install]')
  if (button !== null) void install(button)
})

void load()
