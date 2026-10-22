// The date-grouped grid of thumbnails, with selection (click, shift-click a range, a whole day).
import { useMemo, useRef } from 'react'
import { useApp } from '../lib/app-context'
import { fmtDuration, type Grouping, groupAssets, groupLabel } from '../lib/photos'
import { thumb } from '../lib/photos'
import type { Asset } from '../lib/types'
import { Icon } from './icons'

export function PhotoGrid({ assets, grouping, selected, setSelected, selecting, onOpen }: {
  assets: Asset[]
  grouping: Grouping
  selected: Set<string>
  setSelected: (fn: (s: Set<string>) => Set<string>) => void
  selecting: boolean
  onOpen: (index: number) => void
}) {
  const { density } = useApp()
  const last = useRef<string | null>(null)
  const groups = useMemo(() => groupAssets(assets, grouping), [assets, grouping])
  const index = useMemo(() => new Map(assets.map((a, i) => [a.id, i])), [assets])
  const picking = selecting || selected.size > 0

  const toggle = (a: Asset, range: boolean) => {
    setSelected(old => {
      const n = new Set(old)
      if (range && last.current && index.has(last.current)) {
        const s = index.get(last.current)!, e = index.get(a.id)!
        assets.slice(Math.min(s, e), Math.max(s, e) + 1).forEach(x => n.add(x.id))
      } else if (n.has(a.id)) n.delete(a.id)
      else n.add(a.id)
      return n
    })
    last.current = a.id
  }

  return (
    <div className={`photo-groups ${picking ? 'picking' : ''}`}>
      {groups.map(([key, items]) => {
        const all = items.every(a => selected.has(a.id))
        return (
          <section className="photo-group" key={key}>
            {grouping !== 'all' && (
              <h2 className="group-head">
                <button type="button" className={`group-check ${all ? 'on' : ''}`} aria-label={`Select ${groupLabel(key, grouping)}`} aria-pressed={all}
                  onClick={() => setSelected(old => { const n = new Set(old); items.forEach(a => (all ? n.delete(a.id) : n.add(a.id))); return n })}>
                  <Icon name={all ? 'check-circle' : 'circle'} size={17} />
                </button>
                <span>{groupLabel(key, grouping)}</span>
                <span className="group-count tnum">{items.length}</span>
              </h2>
            )}
            <div className={`photo-grid ${density}`}>
              {items.map(a => {
                const on = selected.has(a.id)
                const w = a.width && a.height ? a.width / a.height : 1
                return (
                  <div key={a.id} data-photo-month={(a.localDateTime || a.fileCreatedAt).slice(0, 7)} className={`tile ${on ? 'selected' : ''}`} style={{ ['--ar' as string]: Math.min(2.2, Math.max(0.6, w)) }}>
                    <button type="button" className="tile-open" aria-label={`Open ${a.exifInfo?.description || a.originalFileName || 'photo'}`}
                      onClick={e => { if (picking || e.shiftKey) toggle(a, e.shiftKey); else onOpen(index.get(a.id)!) }}>
                      <img src={thumb(a)} loading="lazy" alt="" draggable={false} onError={e => e.currentTarget.classList.add('broken')} />
                      {a.type === 'VIDEO' && <span className="tile-badge"><Icon name="play" size={10} />{fmtDuration(a.duration) || 'Video'}</span>}
                      {a.livePhotoVideoId && <span className="tile-badge"><Icon name="live" size={11} />Live</span>}
                      {a.isFavorite && <span className="tile-fav"><Icon name="heart" size={15} fill /></span>}
                    </button>
                    <button type="button" className="tile-check" aria-label={`Select ${a.originalFileName || 'photo'}`} aria-pressed={on} onClick={e => toggle(a, e.shiftKey)}>
                      <Icon name={on ? 'check' : 'circle'} size={on ? 13 : 20} strokeWidth={on ? 3 : 1.75} />
                    </button>
                  </div>
                )
              })}
            </div>
          </section>
        )
      })}
    </div>
  )
}
