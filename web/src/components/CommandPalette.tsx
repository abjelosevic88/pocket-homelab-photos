// ⌘K / "/" — search the library, jump to an album or a person, run a command.
import React, { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import { immich } from '../lib/api'
import { useApp } from '../lib/app-context'
import { faceThumb, plural, thumb } from '../lib/photos'
import type { Person } from '../lib/types'
import { Icon } from './icons'

export interface PaletteCommand { id: string; label: string; icon: string; hint?: string; keywords?: string; run: () => void }

let peopleCache: Person[] | null = null

export function CommandPalette({ onClose, commands }: { onClose: () => void; commands: PaletteCommand[] }) {
  const { albums, connection } = useApp()
  const navigate = useNavigate()
  const [q, setQ] = useState('')
  const [hi, setHi] = useState(0)
  const [people, setPeople] = useState<Person[]>(peopleCache || [])
  const list = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!connection?.connected || peopleCache) return
    immich.get<{ people: Person[] }>('/people?size=200&withHidden=false').then(r => { peopleCache = r.people.filter(p => p.name); setPeople(peopleCache) }).catch(() => {})
  }, [connection])

  type Row = { key: string; group: string; icon: React.ReactNode; label: React.ReactNode; sub?: React.ReactNode; hint?: string; run: () => void }
  const rows = useMemo<Row[]>(() => {
    const out: Row[] = []
    const t = q.trim()
    const n = t.toLowerCase()
    if (t && connection?.connected) {
      out.push({ key: 'smart', group: 'Search', icon: <Icon name="sparkles" size={16} />, label: <>Photos of “{t}”</>, sub: 'Describe what is in the photo — Immich’s smart search', run: () => navigate(`/search?q=${encodeURIComponent(t)}`) })
      out.push({ key: 'name', group: 'Search', icon: <Icon name="file" size={16} />, label: <>File names containing “{t}”</>, run: () => navigate(`/search?q=${encodeURIComponent(t)}&in=filename`) })
      out.push({ key: 'ocr', group: 'Search', icon: <Icon name="text" size={16} />, label: <>Text in photos: “{t}”</>, run: () => navigate(`/search?q=${encodeURIComponent(t)}&in=ocr`) })
    }
    for (const a of albums) {
      if (n && !a.albumName.toLowerCase().includes(n)) continue
      if (!n && out.length > 4) break
      out.push({
        key: 'a' + a.id, group: 'Albums', icon: a.albumThumbnailAssetId ? <img className="pal-thumb" src={thumb(a.albumThumbnailAssetId)} alt="" /> : <Icon name="album" size={16} />,
        label: a.albumName, sub: plural(a.assetCount, 'item'), run: () => navigate(`/albums/${a.id}`),
      })
    }
    if (n) for (const p of people) {
      if (!p.name.toLowerCase().includes(n)) continue
      out.push({ key: 'p' + p.id, group: 'People', icon: <img className="pal-thumb round" src={faceThumb(p.id)} alt="" />, label: p.name, run: () => navigate(`/people/${p.id}`) })
    }
    for (const c of commands) {
      if (n && !`${c.label} ${c.keywords || ''}`.toLowerCase().includes(n)) continue
      out.push({ key: c.id, group: 'Go to', icon: <Icon name={c.icon} size={16} />, label: c.label, hint: c.hint, run: c.run })
    }
    return out
  }, [q, albums, people, commands, connection, navigate])
  useEffect(() => setHi(0), [q])
  useEffect(() => { list.current?.querySelector(`[data-i="${hi}"]`)?.scrollIntoView({ block: 'nearest' }) }, [hi])

  const run = (r: Row | undefined) => { if (!r) return; onClose(); r.run() }
  let last = ''
  return createPortal(
    <div className="palette-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="palette-box" role="dialog" aria-label="Search and commands">
        <div className="pal-input">
          <Icon name="search" size={18} />
          <input autoFocus value={q} onChange={e => setQ(e.target.value)} placeholder="Search photos, albums and people, or run a command…" aria-label="Search photos"
            onKeyDown={e => {
              if (e.key === 'ArrowDown') { e.preventDefault(); setHi(h => Math.min(rows.length - 1, h + 1)) }
              else if (e.key === 'ArrowUp') { e.preventDefault(); setHi(h => Math.max(0, h - 1)) }
              else if (e.key === 'Enter') { e.preventDefault(); run(rows[hi]) }
              else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose() }
            }} />
          <kbd>esc</kbd>
        </div>
        <div className="pal-list" ref={list} role="listbox">
          {rows.length === 0 && <div className="pal-empty">Nothing matches.</div>}
          {rows.map((r, i) => {
            const head = r.group !== last ? <div className="pal-group" key={'g' + r.group}>{r.group}</div> : null
            last = r.group
            return (
              <React.Fragment key={r.key}>
                {head}
                <div data-i={i} role="option" aria-selected={i === hi} className={`pal-row ${i === hi ? 'hi' : ''}`} onMouseEnter={() => setHi(i)} onClick={() => run(r)}>
                  <span className="pal-ico">{r.icon}</span>
                  <span className="grow"><span className="pal-label">{r.label}</span>{r.sub && <span className="pal-sub">{r.sub}</span>}</span>
                  {r.hint && <kbd>{r.hint}</kbd>}
                  {i === hi && <Icon name="chevron-right" size={14} className="muted" />}
                </div>
              </React.Fragment>
            )
          })}
        </div>
      </div>
    </div>, document.body)
}
