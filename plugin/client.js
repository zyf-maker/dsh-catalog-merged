/**
 * DSH Market — client half.
 *
 * Renders the market inside Settings, reusing the same markup and CSS as the
 * standalone web page so there is one UI, not two. The host half serves the
 * data and performs installs; this half only paints and forwards intent.
 */
export const name = 'dsh-market-own-client'

export const inject = ['@deepseek-ai/dsh-client-ui-settings']

/** Register the settings section. */
export function apply(ctx) {
  ctx.settings?.section?.({
    id: 'dsh-market-own',
    title: { en: 'My Market', zh: '我的市场' },
    order: 40,
    render: (container) => {
      container.innerHTML = SHELL
      const list = container.querySelector('[data-list]')
      const search = container.querySelector('[data-search]')
      const sort = container.querySelector('[data-sort]')
      const status = container.querySelector('[data-status]')

      /** Pull one page from the host half and paint it. */
      async function refresh() {
        status.textContent = '加载中…'
        const params = new URLSearchParams({ q: search.value.trim(), sort: sort.value, limit: '60' })
        try {
          const res = await fetch(`/dsh-market/api/catalog?${params}`)
          const data = await res.json()
          if (data.error !== undefined) {
            // A failed fetch is reported as a failure, never as an empty market.
            status.textContent = `目录不可达：${data.message ?? data.error}`
            list.innerHTML = ''
            return
          }
          status.textContent = `${data.count} 个插件 · 更新于 ${new Date(data.updated).toLocaleString()}`
          list.innerHTML = data.plugins.map(renderCard).join('')
        } catch (error) {
          status.textContent = `加载失败：${String(error.message)}`
        }
      }

      /** One card; the install button forwards to the host half. */
      function renderCard(plugin, index) {
        const description = plugin.description?.zh || plugin.description?.en || ''
        return `<article class="dshm-card">
          <div class="dshm-rank">${index + 1}</div>
          <div>
            <div class="dshm-name">${escapeHtml(plugin.name)} <span class="dshm-owner">${escapeHtml(plugin.owner)}</span></div>
            <div class="dshm-desc">${escapeHtml(description)}</div>
            <div class="dshm-meta">
              <span class="dshm-tag">${escapeHtml(plugin.targetKind)}</span>
              <span>★ ${plugin.stars}</span><span>↓ ${plugin.downloads}</span><span>score ${plugin.score}</span>
            </div>
          </div>
          <button class="dshm-install" data-target="${escapeAttr(plugin.install)}">安装</button>
        </article>`
      }

      list.addEventListener('click', async (event) => {
        const button = event.target.closest('button[data-target]')
        if (button === null) return
        button.disabled = true
        button.textContent = '安装中…'
        try {
          const res = await fetch('/dsh-market/api/install', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ target: button.dataset.target }),
          })
          const result = await res.json()
          button.textContent = result.ok ? '已安装' : '失败'
          if (Array.isArray(result.repair?.notes) && result.repair.notes.length > 0) {
            status.textContent = `已自动修复：${result.repair.notes.join('；')}`
          }
        } catch {
          button.textContent = '失败'
        }
        setTimeout(() => { button.disabled = false; button.textContent = '安装' }, 2200)
      })

      let timer
      search.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(refresh, 220) })
      sort.addEventListener('change', refresh)
      void refresh()
    },
  })
}

/** The section's markup. Deliberately plain: the host theme styles it. */
const SHELL = `
<div class="dshm">
  <div class="dshm-bar">
    <input data-search type="search" placeholder="搜索插件…">
    <select data-sort>
      <option value="score">综合分数</option>
      <option value="stars">Star 数</option>
      <option value="downloads">下载次数</option>
    </select>
  </div>
  <div class="dshm-status" data-status></div>
  <div class="dshm-list" data-list></div>
</div>`

const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const escapeAttr = escapeHtml
