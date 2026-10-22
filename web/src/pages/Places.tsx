// Where the photos were taken: a bundled world map (no tile requests) and one card per place.
import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { immich, isAbort } from '../lib/api'
import { useApp } from '../lib/app-context'
import { land } from '../lib/world'
import { placeName, plural, thumb } from '../lib/photos'
import type { Asset, MapMarker } from '../lib/types'
import { Icon } from '../components/icons'
import { NeedsLibrary } from '../components/Library'
import { Viewer } from '../components/Viewer'
import { Empty, Loading, PageHeader, errMsg } from '../components/ui'

export default function Places() {
  return <NeedsLibrary><PlacesInner /></NeedsLibrary>
}

const W = 1000, H = 440
const px = (m: MapMarker) => [((m.lon + 180) / 360) * W, ((90 - m.lat) / 180) * H]

function PlacesInner() {
  const { version, bump } = useApp()
  const [markers, setMarkers] = useState<MapMarker[] | null>(null)
  const [error, setError] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const [open, setOpen] = useState<{ assets: Asset[]; index: number } | null>(null)
  useEffect(() => {
    const c = new AbortController()
    immich.get<MapMarker[]>('/map/markers', c.signal).then(setMarkers).catch(e => { if (!isAbort(e)) setError(errMsg(e)) })
    return () => c.abort()
  }, [version])
  const groups = useMemo(() => {
    const g = new Map<string, MapMarker[]>()
    for (const m of markers || []) {
      const k = placeName(m) || `${m.lat.toFixed(2)}, ${m.lon.toFixed(2)}`
      g.set(k, [...(g.get(k) || []), m])
    }
    return [...g.entries()].sort((a, b) => b[1].length - a[1].length)
  }, [markers])
  // zoom the map to where the photos are, with some room around them
  const box = useMemo(() => {
    if (!markers?.length) return `0 0 ${W} ${H}`
    const pts = markers.map(px)
    const xs = pts.map(p => p[0]), ys = pts.map(p => p[1])
    let x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys)
    const pad = 40
    x0 -= pad; x1 += pad; y0 -= pad; y1 += pad
    let w = x1 - x0, h = y1 - y0
    const ar = W / H
    if (w / h < ar) { const nw = h * ar; x0 -= (nw - w) / 2; w = nw } else { const nh = w / ar; y0 -= (nh - h) / 2; h = nh }
    if (w < 160) { const s = 160 / w; x0 -= (w * s - w) / 2; y0 -= (h * s - h) / 2; w *= s; h *= s }
    return `${Math.max(0, x0).toFixed(1)} ${Math.max(0, y0).toFixed(1)} ${Math.min(W, w).toFixed(1)} ${Math.min(H, h).toFixed(1)}`
  }, [markers])
  const scale = Number(box.split(' ')[2]) / W
  const pick = groups.find(([n]) => n === selected)?.[1]
  const openPhoto = async (ms: MapMarker[], i: number) => {
    try {
      const assets = await Promise.all(ms.slice(0, 60).map(m => immich.get<Asset>('/assets/' + m.id)))
      setOpen({ assets, index: i })
    } catch (e) { setError(errMsg(e)) }
  }
  return (
    <div className="page">
      <PageHeader title="Places" sub={markers ? `${plural(markers.length, 'photo')} with a location · ${plural(groups.length, 'place')}` : 'See where your memories take you.'} />
      {error && <div className="callout danger"><Icon name="alert" size={15} /><span>{error}</span></div>}
      {!markers && !error && <Loading label="Finding your places…" />}
      {markers && !markers.length && <Empty icon="pin" title="Every photo has a place">Photos with a location show up here, on the map.</Empty>}
      {!!markers?.length && (
        <div className="map-card">
          <svg viewBox={box} role="img" aria-label="Photo locations on a world map" preserveAspectRatio="xMidYMid meet">
            <rect x="0" y="0" width={W} height={H} className="map-sea" />
            <path d={land} className="map-land" />
            {groups.map(([name, ms]) => {
              const [x, y] = px(ms[0])
              const r = Math.min(16, 5 + Math.log2(ms.length) * 2.2) * Math.max(scale, 0.18)
              return (
                <g key={name} role="button" tabIndex={0} aria-label={`${name}, ${plural(ms.length, 'photo')}`} className={`map-pin ${selected === name ? 'active' : ''}`}
                  onClick={() => setSelected(selected === name ? null : name)} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') setSelected(name) }}>
                  <circle cx={x} cy={y} r={r * 1.9} className="map-halo" />
                  <circle cx={x} cy={y} r={r} className="map-dot" strokeWidth={r * 0.28} />
                  <title>{name} · {plural(ms.length, 'photo')}</title>
                </g>
              )
            })}
          </svg>
          <span className="map-caption">Natural Earth · no map tiles are loaded from anywhere</span>
        </div>
      )}
      {pick && (
        <div className="place-pick">
          <div className="row"><Icon name="pin" size={16} className="muted" /><b className="grow">{selected}</b><Link className="btn sm" to={`/places/${encodeURIComponent(pick[0].city || '')}`}>All photos here</Link><button type="button" className="btn ghost icon-only sm" aria-label="Clear place" onClick={() => setSelected(null)}><Icon name="x" size={15} /></button></div>
          <div className="place-strip">
            {pick.slice(0, 24).map((m, i) => <button type="button" key={m.id} onClick={() => openPhoto(pick, i)} aria-label="Open photo"><img src={thumb(m.id)} alt="" loading="lazy" /></button>)}
          </div>
        </div>
      )}
      <div className="cards places-cards">
        {groups.map(([name, ms]) => (
          <Link key={name} to={ms[0].city ? `/places/${encodeURIComponent(ms[0].city)}` : '#'} className="card-tile" onClick={e => { if (!ms[0].city) { e.preventDefault(); setSelected(name) } }}>
            <span className="card-cover"><img src={thumb(ms[0].id, 'preview')} alt="" loading="lazy" /></span>
            <span className="card-name ellipsis">{ms[0].city || name}</span>
            <span className="card-meta">{ms[0].city ? (ms[0].country || '') + ' · ' : ''}{plural(ms.length, 'photo')}</span>
          </Link>
        ))}
      </div>
      {open && <Viewer assets={open.assets} index={open.index} setIndex={i => setOpen(o => (o ? { ...o, index: i } : o))} onClose={() => setOpen(null)}
        onUpdated={a => setOpen(o => (o ? { ...o, assets: o.assets.map(x => (x.id === a.id ? { ...x, ...a } : x)) } : o))} onRemoved={() => { setOpen(null); bump() }} />}
    </div>
  )
}
