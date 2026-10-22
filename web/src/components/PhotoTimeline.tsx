import { useEffect, useLayoutEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { useMediaQuery } from './ui'
import { immich, isAbort } from '../lib/api'
import { useApp } from '../lib/app-context'
import { Icon } from './icons'

export type Bucket = { timeBucket: string; count: number }
const monthName = (key: string) => new Date(Number(key.slice(0, 4)), Number(key.slice(5, 7)) - 1, 1).toLocaleDateString(undefined, { month: 'long' })

export function PhotoTimeline({ active, onJump, mobileOpen, onClose, loadBuckets, itemLabel = 'photos' }: { loadBuckets?: (signal: AbortSignal) => Promise<Bucket[]>; itemLabel?: string; active: string; onJump: (date: string) => void; mobileOpen: boolean; onClose: () => void }) {
  const { version } = useApp()
  const desktop = useMediaQuery('(min-width: 901px)')
  const [dock, setDock] = useState<HTMLElement | null>(null)
  useLayoutEffect(() => { setDock(document.getElementById('timeline-dock')) }, [])
  const [buckets, setBuckets] = useState<Bucket[] | null>(null)
  const [error, setError] = useState(false)
  const [retry, setRetry] = useState(0)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  useEffect(() => {
    const controller = new AbortController()
    setError(false); setBuckets(null)
    ;(loadBuckets ? loadBuckets(controller.signal) : immich.get<Bucket[]>('/timeline/buckets?visibility=timeline&isTrashed=false&order=desc', controller.signal))
      .then(data => {
        if (controller.signal.aborted) return
        setBuckets(data)
        const latest = data.map(b => b.timeBucket.slice(0, 4)).sort().at(-1)
        if (latest) setExpanded(old => old.size ? old : new Set([latest]))
      }).catch(e => { if (!controller.signal.aborted && !isAbort(e)) setError(true) })
    return () => controller.abort()
  }, [version, retry, loadBuckets])
  const years = useMemo(() => {
    const grouped = new Map<string, Map<string, number>>()
    for (const b of buckets || []) {
      if (!/^\d{4}-\d{2}/.test(b.timeBucket)) continue
      const year = b.timeBucket.slice(0, 4), month = b.timeBucket.slice(0, 7)
      if (!grouped.has(year)) grouped.set(year, new Map())
      const months = grouped.get(year)!
      months.set(month, (months.get(month) || 0) + b.count)
    }
    return [...grouped].sort(([a], [b]) => b.localeCompare(a)).map(([year, months]) => ({
      year, months: [...months].sort(([a], [b]) => b.localeCompare(a)), total: [...months.values()].reduce((a, b) => a + b, 0),
    }))
  }, [buckets])
  useEffect(() => { if (active) setExpanded(old => new Set([...old, active.slice(0, 4)])) }, [active])
  const jump = (date: string) => { onJump(date); onClose() }
  const timeline = <aside className={`photo-timeline ${mobileOpen ? 'mobile-open' : ''}`} aria-label="Photo timeline" id="photo-timeline">
    <div className="timeline-top">
    <div className="timeline-heading"><b>Timeline</b><span>{years.reduce((n, y) => n + y.total, 0).toLocaleString()}</span><button type="button" className="btn ghost icon-only xs timeline-close" aria-label="Close timeline" onClick={onClose}><Icon name="x" size={14} /></button></div>
    <button type="button" className={`timeline-latest ${!active ? 'active' : ''}`} onClick={() => jump('')}><Icon name="clock" size={13} />Latest</button>
    </div>
    <nav className="timeline-years" aria-label="Browse photos by date" tabIndex={0}>
    {error ? <div className="timeline-message">Could not load dates.<button type="button" className="btn sm" onClick={() => setRetry(n => n + 1)}>Try again</button></div> : !buckets ? <p className="timeline-message">Loading dates…</p> : !years.length ? <p className="timeline-message">No dated {itemLabel} yet.</p> : null}
    {years.map(({ year, months, total }) => {
      const max = Math.max(...months.map(([, count]) => count), 1)
      return <div className="timeline-year" key={year}>
        <div className={`timeline-year-row ${active === year ? 'active' : ''}`}>
          <button type="button" className="timeline-expand" aria-label={`${expanded.has(year) ? 'Collapse' : 'Expand'} ${year}`} aria-expanded={expanded.has(year)} aria-controls={`timeline-${year}`} onClick={() => setExpanded(old => { const next = new Set(old); if (next.has(year)) next.delete(year); else next.add(year); return next })}><Icon name={expanded.has(year) ? 'chevron-down' : 'chevron-right'} size={12} /></button>
          <button type="button" className="timeline-year-jump" aria-label={`Jump to ${year}, ${total.toLocaleString()} ${itemLabel}`} onClick={() => { setExpanded(old => new Set([...old, year])); jump(year) }}>
            <b>{year}</b><span className="timeline-spark" aria-hidden="true">{Array.from({ length: 12 }, (_, i) => { const count = months.find(([key]) => Number(key.slice(5)) === i + 1)?.[1] || 0; return <i key={i} style={{ height: `${Math.max(8, count / max * 100)}%`, opacity: count ? 1 : .2 }} /> })}</span><span className="timeline-count">{total.toLocaleString()}</span>
          </button>
        </div>
        {expanded.has(year) && <div id={`timeline-${year}`} className="timeline-months">{months.map(([month, count]) => <button type="button" key={month} className={`timeline-month ${active === month ? 'active' : ''}`} aria-current={active === month ? 'date' : undefined} aria-label={`Jump to ${monthName(month)} ${year}, ${count.toLocaleString()} ${itemLabel}`} onClick={() => jump(month)}>
          <span className="timeline-month-name">{monthName(month)}</span><span className="timeline-bar" aria-hidden="true"><i style={{ width: `${count / max * 100}%` }} /></span><span className="timeline-count">{count.toLocaleString()}</span>
        </button>)}</div>}
      </div>
    })}
    </nav>
  </aside>
  return desktop && dock ? createPortal(timeline, dock) : timeline
}
