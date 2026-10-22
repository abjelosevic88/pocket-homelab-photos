// Where the photos were taken: a bundled world map (no tile requests) and one card per place.
import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { cloudThumb, clouds, immich, isAbort } from '../lib/api'
import { useApp } from '../lib/app-context'
import { PhotoMap } from '../components/PhotoMap'
import { placeName, plural, thumb } from '../lib/photos'
import type { Asset, MapMarker } from '../lib/types'
import { Icon } from '../components/icons'
import { NeedsLibrary } from '../components/Library'
import { Viewer } from '../components/Viewer'
import { CloudViewer } from '../components/CloudViewer'
import { Empty, Loading, PageHeader, errMsg } from '../components/ui'

export default function Places() {
  return <NeedsLibrary><PlacesInner /></NeedsLibrary>
}

function PlacesInner() {
  const { version, bump, clouds: accounts } = useApp()
  const [library, setLibrary] = useState<MapMarker[] | null>(null)
  const [cloudMarkers, setCloudMarkers] = useState<MapMarker[]>([])
  const [showClouds, setShowClouds] = useState(() => localStorage.getItem('pp-places-clouds') !== '0')
  const [cloudOpen, setCloudOpen] = useState<{ ids: number[]; index: number } | null>(null)
  const [error, setError] = useState('')
  const [selection, setSelection] = useState<MapMarker[] | null>(null)
  const [limit, setLimit] = useState(24)
  const [opening, setOpening] = useState(false)
  const photoRequest = useRef(0)
  const select = (ms: MapMarker[] | null) => { photoRequest.current++; setOpening(false); setSelection(ms); setLimit(24) }
  const [open, setOpen] = useState<{ assets: Asset[]; index: number } | null>(null)
  useEffect(() => {
    const c = new AbortController()
    immich.get<MapMarker[]>('/map/markers', c.signal).then(setLibrary).catch(e => { if (!isAbort(e)) setError(errMsg(e)) })
    return () => c.abort()
  }, [version])
  // Photos that live in the person's clouds, from Photos' own index; none is fine.
  const anyCloud = !!accounts?.some(a => a.counts?.located)
  useEffect(() => {
    if (!anyCloud) { setCloudMarkers([]); return }
    const c = new AbortController()
    clouds.map(undefined, c.signal)
      .then(ms => setCloudMarkers(ms.map(m => ({ id: 'c' + m.id, lat: m.lat, lon: m.lon, city: m.city || null, country: m.country || null, cloud: true, src: cloudThumb(m.id) }))))
      .catch(() => setCloudMarkers([]))
    return () => c.abort()
  }, [anyCloud, version])
  useEffect(() => { localStorage.setItem('pp-places-clouds', showClouds ? '1' : '0') }, [showClouds])
  const markers = useMemo(() => (library ? [...library, ...(showClouds ? cloudMarkers : [])] : null), [library, cloudMarkers, showClouds])
  const groups = useMemo(() => {
    const g = new Map<string, MapMarker[]>()
    for (const m of library || []) {
      const k = placeName(m) || `${m.lat.toFixed(2)}, ${m.lon.toFixed(2)}`
      const group = g.get(k)
      if (group) group.push(m); else g.set(k, [m])
    }
    return [...g.entries()].sort((a, b) => b[1].length - a[1].length)
  }, [library])
  const markerById = useMemo(() => new Map(markers?.map(m => [m.id, m])), [markers])
  const pick = useMemo(() => selection?.map(m => markerById.get(m.id)).filter((m): m is MapMarker => !!m), [selection, markerById])
  const names = [...new Set(pick?.map(m => placeName(m)).filter(Boolean))]
  const selected = names.length === 1 ? names[0] : 'Selected area'
  const openPhoto = async (ms: MapMarker[], i: number) => {
    const request = ++photoRequest.current
    setOpening(true)
    try {
      // The viewer fetches details as you browse; don't fan out thousands of requests.
      const first = await immich.get<Asset>('/assets/' + ms[i].id)
      if (request !== photoRequest.current) return
      const assets: Asset[] = ms.map(m => ({ id: m.id, type: 'IMAGE', originalFileName: 'Photo', fileCreatedAt: '', isFavorite: false, isTrashed: false, visibility: 'timeline' }))
      assets[i] = first
      setOpen({ assets, index: i })
    } catch (e) { if (request === photoRequest.current) setError(errMsg(e)) }
    finally { if (request === photoRequest.current) setOpening(false) }
  }
  return (
    <div className="page">
      <PageHeader title="Places" sub={library ? `${plural(library.length, 'photo')} with a location · ${plural(groups.length, 'place')}${cloudMarkers.length ? ` · ${cloudMarkers.length.toLocaleString()} more in your clouds` : ''}` : 'See where your memories take you.'}
        actions={cloudMarkers.length > 0 && <button type="button" className={`chip toggle ${showClouds ? 'on' : ''}`} aria-pressed={showClouds} title="Show photos from your clouds on the map" onClick={() => { setShowClouds(v => !v); select(null) }}><Icon name="cloud" size={14} />Clouds</button>} />
      {error && <div className="callout danger"><Icon name="alert" size={15} /><span>{error}</span></div>}
      {!markers && !error && <Loading label="Finding your places…" />}
      {markers && !markers.length && <Empty icon="pin" title="Every photo has a place">Photos with a location show up here, on the map.</Empty>}
      {!!markers?.length && <PhotoMap markers={markers!} selected={pick?.[0]?.id || null} onSelect={select} />}
      {!!pick?.length && (
        <div className="place-pick">
          <div className="row"><Icon name="pin" size={16} className="muted" /><div className="grow"><b>{selected}</b><div className="small muted">{plural(pick.length, 'photo')}{pick.some(x => x.cloud) ? ` · ${pick.filter(x => x.cloud).length.toLocaleString()} in your clouds` : ''}</div></div><button type="button" className="btn sm" disabled={opening} onClick={() => { const ls = pick.filter(x => !x.cloud); if (ls.length) openPhoto(ls, 0); else setCloudOpen({ ids: pick.map(x => Number(x.id.slice(1))), index: 0 }) }}>{opening ? 'Opening…' : 'View photos'}</button><button type="button" className="btn ghost icon-only sm" aria-label="Clear place" onClick={() => select(null)}><Icon name="x" size={15} /></button></div>
          <div className="place-strip">
            {pick.slice(0, limit).map((m, i) => m.cloud
              ? <button type="button" key={m.id} className="cloud" onClick={() => { const cs = pick.filter(x => x.cloud); setCloudOpen({ ids: cs.map(x => Number(x.id.slice(1))), index: cs.indexOf(m) }) }} aria-label={`Open cloud photo ${i + 1} of ${pick.length}`}><img src={m.src} alt="" loading="lazy" /><Icon name="cloud" size={12} /></button>
              : <button type="button" key={m.id} disabled={opening} onClick={() => { const ls = pick.filter(x => !x.cloud); openPhoto(ls, ls.indexOf(m)) }} aria-label={`Open photo ${i + 1} of ${pick.length}`}><img src={thumb(m.id)} alt="" loading="lazy" /></button>)}
          </div>
          {pick.length > limit && <button type="button" className="btn sm" onClick={() => setLimit(n => n + 60)}>Show more photos ({Math.min(limit, pick.length).toLocaleString()} of {pick.length.toLocaleString()})</button>}
        </div>
      )}
      <div className="cards places-cards">
        {groups.map(([name, ms]) => (
          <Link key={name} to={ms[0].city ? `/places/${encodeURIComponent(ms[0].city)}` : '#'} className="card-tile" onClick={e => { if (!ms[0].city) { e.preventDefault(); select(ms) } }}>
            <span className="card-cover"><img src={thumb(ms[0].id, 'preview')} alt="" loading="lazy" /></span>
            <span className="card-name ellipsis">{ms[0].city || name}</span>
            <span className="card-meta">{ms[0].city ? (ms[0].country || '') + ' · ' : ''}{plural(ms.length, 'photo')}</span>
          </Link>
        ))}
      </div>
      {cloudOpen && <CloudViewer items={cloudOpen.ids.map(id => ({ id }))} index={cloudOpen.index} setIndex={i => setCloudOpen(o => (o ? { ...o, index: i } : o))} onClose={() => setCloudOpen(null)} />}
      {open && <Viewer assets={open.assets} index={open.index} setIndex={i => setOpen(o => (o ? { ...o, index: i } : o))} onClose={() => setOpen(null)}
        onUpdated={a => setOpen(o => (o ? { ...o, assets: o.assets.map(x => (x.id === a.id ? { ...x, ...a } : x)) } : o))} onRemoved={() => { setOpen(null); bump() }} />}
    </div>
  )
}
