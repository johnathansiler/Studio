import { useState, type ReactNode } from 'react'
import './pluginPages.css'

export type PluginPage = { id: string; label: string; node: ReactNode }

/** One quiet row of pages. The active page fills the plugin. The rest stay mounted and hidden. */
export function PluginPages({ label, pages, initial }: { label: string; pages: PluginPage[]; initial?: string }) {
  const first = pages[0]?.id ?? 'page'
  const [page, setPage] = useState(initial && pages.some((item) => item.id === initial) ? initial : first)
  const active = pages.some((item) => item.id === page) ? page : first
  const menu = pages.length > 4
  return (
    <div className="plugin-pages" data-plugin-pages="">
      {menu ? (
        <label className="plugin-page-menu">
          <span>Page</span>
          <select aria-label={label} value={active} onChange={(event) => setPage(event.target.value)}>
            {pages.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
          </select>
        </label>
      ) : (
        <div className="plugin-page-tabs" role="tablist" aria-label={label}>
          {pages.map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              data-plugin-tab={item.id}
              aria-selected={item.id === active}
              className={item.id === active ? 'on' : ''}
              onClick={() => setPage(item.id)}
            >{item.label}</button>
          ))}
        </div>
      )}
      {pages.map((item) => (
        <div key={item.id} className="plugin-page" role="tabpanel" data-plugin-page={item.id} hidden={item.id !== active}>
          {item.node}
        </div>
      ))}
    </div>
  )
}

export function chunkParams<T>(items: T[], size: number): T[][] {
  const groups: T[][] = []
  const count = Math.max(1, size)
  for (let index = 0; index < items.length; index += count) groups.push(items.slice(index, index + count))
  return groups
}
