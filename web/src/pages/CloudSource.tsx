// Photos indexed in one of the person's clouds: review them where they are, see them on the map, import what you pick.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { ApiError, type CloudFilter, cloudThumb, clouds, isAbort } from '../lib/api'
import { useApp } from '../lib/app-context'
import { cloudCounts, cloudKind, cloudPlace, cloudStatus, cloudWhen, groupCloud } from '../lib/clouds'
import { fmtDuration, groupLabel, plural } from '../lib/photos'
import type { CloudItem, MapMarker } from '../lib/types'
import { CloudViewer } from '../components/CloudViewer'
import { Icon } from '../components/icons'
import { usePageTitle } from '../components/Layout'
import { PhotoMap } from '../components/PhotoMap'
import { Select } from '../components/Select'
import { SourceSwitch } from '../components/SourceSwitch'
import { Empty, Loading, PageHeader, Segmented, Spinner, Tabs, errMsg, useToast } from '../components/ui'

const PAGE = 120
const FILTERS: { value: CloudFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'new', label: 'Not in library' },
  { value: 'imported', label: 'Imported' },
  { value: 'located', label: 'With location' },
  { value: 'unlocated', label: 'No location' },
]

export default function CloudSource() {
  const { id: raw } = useParams()
  const id = Number(raw)
  const { clouds: accounts, connection, bump, reloadClouds, density } = useApp()
  const { toast } = useToast()
  const account = accounts?.find(a => a.id === id)
  const kind = cloudKind(account?.kind || '')
  usePageTitle(<span className="ellipsis">{account?.name || 'Cloud'}</span>, [account?.name])

  const [tab, setTab] = useState<'photos' | 'map'>('photos')
  const [filter, setFilter] = useState<CloudFilter>('all')
  const [type, setType] = useState<'' | 'image' | 'video'>('')
  const [q, setQ] = useState('')
  const [search, setSearch] = useState('')
  const [items, setItems] = useState<CloudItem[]>([])
  const [total, setTotal] = useState(0)
  const [cursor, setCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [missing, setMissing] = useState(false)
  const [error, setError] = useState('')
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [open, setOpen] = useState<number | null>(null)
  const [importing, setImporting] = useState(false)
  const [progress, setProgress] = useState('')
  const [results, setResults] = useState<{ name: string; status: string; ok: boolean }[]>([])
  const [mapItems, setMapItems] = useState<CloudItem[] | null>(null)
  const [mapPick, setMapPick] = useState<number[] | null>(null)
  const stop = useRef(false)
  const loadingRef = useRef(false)
  const query = useRef(0)
  const sentinel = useRef<HTMLDivElement>(null)

  const load = useCallback(async (from: string | null, signal?: AbortSignal) => {
    const n = ++query.current
    loadingRef.current = true; setLoading(true); setError('')
    try {
      const page = await clouds.items({ account: id, cursor: from, limit: PAGE, filter, type, q: search }, signal)
      if (n !== query.current) return
      setItems(old => (from ? [...old, ...page.items.filter(i => !old.some(o => o.id === i.id))] : page.items))
      setTotal(page.total); setCursor(page.next_cursor || null); setMissing(false)
    } catch (e) {
      if (isAbort(e) || n !== query.current) return
      if (e instanceof ApiError && e.status === 404) setMissing(true)
      else setError(errMsg(e))
    } finally { if (n === query.current) { loadingRef.current = false; setLoading(false) } }
  }, [id, filter, type, search])

  useEffect(() => {
    const c = new AbortController()
    setItems([]); setCursor(null); setSelected(new Set()); setResults([])
    load(null, c.signal)
    return () => c.abort()
  }, [load])

  // A finished scan brings new photos: show them.
  const wasScanning = useRef(account?.status === 'scanning')
  useEffect(() => {
    const now = account?.status === 'scanning'
    if (wasScanning.current && !now && !importing) load(null)
    wasScanning.current = now
  }, [account?.status]) // eslint-disable-line react-hooks/exhaustive-deps

  // Endless scroll: the next page when the end of the grid comes into view.
  useEffect(() => {
    const el = sentinel.current
    if (!el || !cursor || tab !== 'photos') return
    // the page scrolls inside .content, so that is the root (rootMargin only widens the root)
    const io = new IntersectionObserver(es => { if (es.some(e => e.isIntersecting) && !loadingRef.current) load(cursor) }, { root: el.closest('.content'), rootMargin: '600px' })
    io.observe(el)
    return () => io.disconnect()
  }, [cursor, load, tab, items.length])

  // The map tab: every located photo of this account (the list's own filters don't apply).
  useEffect(() => {
    if (tab !== 'map' || mapItems) return
    const c = new AbortController()
    ;(async () => {
      const all: CloudItem[] = []
      let next: string | null = null
      do {
        const page = await clouds.items({ account: id, cursor: next, limit: 500, filter: 'located' }, c.signal)
        all.push(...page.items); next = page.next_cursor || null
      } while (next && all.length < 20000)
      setMapItems(all)
    })().catch(e => { if (!isAbort(e)) setError(errMsg(e)) })
    return () => c.abort()
  }, [tab, id, mapItems])
  useEffect(() => { setMapItems(null); setMapPick(null) }, [id])

  async function rescan() {
    try { await clouds.scan(id); await reloadClouds(); toast(`Scanning ${account?.name || 'the cloud'}…`) } catch (e) { toast(errMsg(e), 'err') }
  }
  async function reconnect() {
    try { const { url } = await clouds.oauthStart(account!.kind, id); window.location.href = url } catch (e) { toast(errMsg(e), 'err') }
  }

  async function runImport() {
    setImporting(true); stop.current = false
    const list = items.filter(i => selected.has(i.id) && !i.import_status)
    const all: { name: string; status: string; ok: boolean }[] = []
    for (let n = 0; n < list.length; n++) {
      if (stop.current) break
      const it = list[n]
      setProgress(`${n + 1} of ${list.length} · ${it.name}`)
      try {
        const r = await clouds.importItem(it.id)
        setItems(old => old.map(x => (x.id === it.id ? { ...x, import_status: r.status, imported_asset_id: r.asset_id } : x)))
        all.push({ name: it.name, status: r.status === 'duplicate' ? 'Already in your library' : 'Imported', ok: true })
      } catch (err) { all.push({ name: it.name, status: errMsg(err), ok: false }) }
      setResults([...all])
    }
    setProgress(''); setImporting(false); setSelected(new Set())
    toast(`${plural(all.filter(r => r.ok).length, 'photo')} in your library. Nothing in ${account?.name || 'the cloud'} was changed.`)
    bump(); reloadClouds()
  }

  const toggle = (i: CloudItem) => setSelected(old => { const n = new Set(old); if (n.has(i.id)) n.delete(i.id); else n.add(i.id); return n })
  const groups = useMemo(() => groupCloud(items), [items])
  const picking = selected.size > 0
  const markers = useMemo<MapMarker[]>(() => (mapItems || []).map(i => ({ id: 'c' + i.id, lat: i.lat!, lon: i.lon!, city: i.city || null, country: i.country || null, src: cloudThumb(i.id), cloud: true })), [mapItems])
  const picked = mapPick ? (mapItems || []).filter(i => mapPick.includes(i.id)) : []

  if (accounts && !account) return (
    <div className="page"><Empty icon="cloud" title="This cloud isn’t connected">It may have been removed, or it belongs to someone else. <Link to="/settings/sources">Your clouds</Link></Empty></div>
  )
  if (missing) return <div className="page"><Empty icon="cloud" title="This cloud isn’t connected">It may have been removed, or it belongs to someone else. <Link to="/settings/sources">Your clouds</Link></Empty></div>
  if (!account) return <div className="page"><Loading label="Opening your cloud…" /></div>

  return (
    <div className="page sources cloud-page">
      <PageHeader title={account.name} sub={`${kind.label}${account.login ? ' · ' + account.login : ''}${account.root ? ' · ' + account.root : ''} · ${cloudCounts(account)}`}
        actions={<>
          <button type="button" className="btn sm" disabled={account.status === 'scanning' || importing} onClick={rescan}><Icon name="refresh" size={15} />{account.status === 'scanning' ? 'Scanning…' : 'Rescan'}</button>
          <Link className="btn ghost icon-only sm" to="/settings/sources" aria-label="Cloud settings" title="Cloud settings"><Icon name="settings" size={16} /></Link>
        </>} />
      <SourceSwitch active={'cloud-' + account.id} disabled={importing} />
      <div className="callout info source-note"><Icon name="shield" size={15} /><span>Photos reads {account.name} with the sign-in you gave it, read only, and keeps just a small thumbnail. Importing copies the originals you pick into your Immich library — nothing in {account.name} is changed or moved.</span></div>
      {account.status === 'scanning' && <div className="callout cloud-scan" role="status"><Spinner /><span className="grow">{cloudStatus(account)}. New photos appear as they are read.</span><button type="button" className="btn sm" onClick={() => load(null)}>Show what’s found</button></div>}
      {account.status === 'error' && <div className="callout danger"><Icon name="alert" size={15} /><span className="grow">{cloudStatus(account)}</span><button type="button" className="btn sm" onClick={rescan}>Try again</button></div>}
      {account.status === 'reconnect' && <div className="callout warn"><Icon name="key" size={15} /><span className="grow">{kind.label} no longer accepts this sign-in{account.error ? ` (${account.error})` : ''}. Sign in again to keep the index up to date.</span><button type="button" className="btn sm primary" onClick={reconnect}>Reconnect</button></div>}
      {account.status === 'idle' && account.last_scan_at && <p className="muted small cloud-last">{cloudStatus(account)} · rescans by itself every few hours.</p>}

      <Tabs tabs={[{ id: 'photos', label: 'Photos', icon: 'image' }, { id: 'map', label: 'Map', icon: 'map' }]} value={tab} onChange={setTab} />

      {tab === 'photos' && <>
        <div className="source-tools">
          <Segmented options={FILTERS} value={filter} onChange={v => setFilter(v)} size="sm" label="Show" />
          <Select value={type} options={[{ value: '', label: 'Photos and videos' }, { value: 'image', label: 'Photos' }, { value: 'video', label: 'Videos' }]} onChange={v => setType(v as '' | 'image' | 'video')} label="Type" size="sm" className="inline" width={170} />
          <span className="spacer" />
          <form className="search-field sm" onSubmit={e => { e.preventDefault(); setSearch(q.trim()) }}>
            <Icon name="search" size={15} />
            <input aria-label="Search this cloud" placeholder={`Search ${account.name}…`} value={q} onChange={e => setQ(e.target.value)} />
          </form>
        </div>

        {picking && (
          <div className="select-bar" role="toolbar" aria-label="Selection">
            <button type="button" className="btn ghost icon-only sm" aria-label="Clear cloud selection" disabled={importing} onClick={() => setSelected(new Set())}><Icon name="x" size={16} /></button>
            <b className="tnum">{selected.size} selected</b>
            <button type="button" className="btn ghost sm" disabled={importing} onClick={() => setSelected(new Set(items.filter(i => !i.import_status).map(i => i.id)))}>Select all not in library</button>
            <span className="spacer" />
            <button type="button" className="btn primary sm" disabled={!connection?.connected || importing || !items.some(i => selected.has(i.id) && !i.import_status)} onClick={runImport}><Icon name="download" size={14} />Import to library</button>
          </div>
        )}
        {!connection?.connected && <div className="callout warn"><Icon name="info" size={15} /><span>You can review everything now. Connect your Immich library in Settings to import.</span></div>}
        {error && <div className="callout danger"><Icon name="alert" size={15} /><span className="grow">{error}</span><button type="button" className="btn sm" onClick={() => load(null)}>Try again</button></div>}
        {!!items.length && <p className="muted small tnum cloud-total">{total === items.length ? plural(total, 'item') : `${items.length.toLocaleString()} of ${plural(total, 'item')}`}</p>}

        <div className={`photo-groups ${picking ? 'picking' : ''}`}>
          {groups.map(([key, list]) => {
            const all = list.every(i => selected.has(i.id))
            return (
              <section className="photo-group" key={key}>
                <h2 className="group-head">
                  <button type="button" className={`group-check ${all ? 'on' : ''}`} aria-label={`Select ${groupLabel(key, 'month')}`} aria-pressed={all}
                    onClick={() => setSelected(old => { const n = new Set(old); list.forEach(i => (all ? n.delete(i.id) : n.add(i.id))); return n })}>
                    <Icon name={all ? 'check-circle' : 'circle'} size={17} />
                  </button>
                  <span>{groupLabel(key, 'month')}</span>
                  <span className="group-count tnum">{list.length}</span>
                </h2>
                <div className={`photo-grid ${density}`}>
                  {list.map(i => {
                    const on = selected.has(i.id)
                    const ar = i.width && i.height ? i.width / i.height : 1.33
                    const where = cloudPlace(i)
                    return (
                      <div key={i.id} className={`tile cloud-tile ${on ? 'selected' : ''} ${i.import_status ? 'in-library' : ''}`} style={{ ['--ar' as string]: Math.min(2.2, Math.max(0.6, ar)) }}>
                        <button type="button" className="tile-open" aria-label={`Open ${i.name}`} title={[i.name, where, cloudWhen(i).slice(0, 10)].filter(Boolean).join(' · ')}
                          onClick={e => { if (picking || e.shiftKey) toggle(i); else setOpen(items.indexOf(i)) }}>
                          {i.has_thumb
                            ? <img src={cloudThumb(i.id)} loading="lazy" alt="" draggable={false} onError={e => e.currentTarget.classList.add('broken')} />
                            : <span className="tile-nothumb"><Icon name={i.video ? 'video' : 'image'} size={22} /><small className="ellipsis">{i.name}</small></span>}
                          {i.video && <span className="tile-badge"><Icon name="play" size={10} />{fmtDuration(i.duration_ms) || 'Video'}</span>}
                          {i.import_status && <span className="tile-lib" title="In your library"><Icon name="check" size={11} strokeWidth={3} /></span>}
                          {i.lat != null && <span className="tile-pin" title={where || 'Has a location'}><Icon name="pin" size={12} /></span>}
                        </button>
                        <button type="button" className="tile-check" aria-label={`Select ${i.name}`} aria-pressed={on} onClick={() => toggle(i)}>
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
        <div ref={sentinel} className="grid-sentinel" />
        {loading && <Loading label={items.length ? 'Loading more…' : `Opening ${account.name}…`} />}
        {!loading && !items.length && !error && (
          <Empty icon={kind.icon} title={account.status === 'scanning' ? 'Looking for photos…' : filter === 'all' && !search && !type ? 'No photos here yet' : 'Nothing matches'}>
            {account.status === 'scanning' ? 'They show up here as the scan reads them.' : filter === 'all' && !search && !type ? `Photos and videos in ${account.name}${account.root ? ' below ' + account.root : ''} show up here after a scan.` : 'Try another filter.'}
          </Empty>
        )}
      </>}

      {tab === 'map' && <>
        {!mapItems && !error && <Loading label="Finding places…" />}
        {mapItems && !mapItems.length && <Empty icon="pin" title="No places yet">Photos from {account.name} that know where they were taken show up here.</Empty>}
        {!!mapItems?.length && <>
          <p className="muted small tnum">{plural(mapItems.length, 'photo')} with a location in {account.name}</p>
          <PhotoMap markers={markers} selected={mapPick ? 'c' + mapPick[0] : null} onSelect={ms => setMapPick(ms.map(m => Number(m.id.slice(1))))} />
        </>}
        {!!picked.length && (
          <div className="place-pick">
            <div className="row"><Icon name="pin" size={16} className="muted" /><div className="grow"><b>{[...new Set(picked.map(cloudPlace).filter(Boolean))].length === 1 ? cloudPlace(picked[0]) : 'Selected area'}</b><div className="small muted">{plural(picked.length, 'photo')}</div></div><button type="button" className="btn ghost icon-only sm" aria-label="Clear place" onClick={() => setMapPick(null)}><Icon name="x" size={15} /></button></div>
            <div className="place-strip">{picked.slice(0, 60).map((i, n) => <button type="button" key={i.id} onClick={() => setOpen(-1 - n)} aria-label={`Open ${i.name}`}><img src={cloudThumb(i.id)} alt="" loading="lazy" /></button>)}</div>
          </div>
        )}
      </>}

      {importing && <div className="import-bar" role="status"><Spinner /><b className="grow ellipsis">Importing {progress}</b><button type="button" className="btn sm" onClick={() => { stop.current = true }}>Stop after this one</button></div>}
      {results.length > 0 && (
        <section className="import-results" aria-label="Import results">
          <h3>Imported</h3>
          {results.map((r, i) => <div key={i} className="import-row"><Icon name={r.ok ? 'check-circle' : 'alert'} size={15} className={r.ok ? 'ok-text' : 'danger-text'} /><span className="grow ellipsis">{r.name}</span><span className="muted small">{r.status}</span></div>)}
        </section>
      )}

      {open !== null && (() => {
        // non-negative: an index into the grid; negative: into the map's picked place
        const list = open >= 0 ? items : picked
        const index = open >= 0 ? open : -1 - open
        if (!list[index]) return null
        return <CloudViewer items={list} index={index} setIndex={n => setOpen(open >= 0 ? n : -1 - n)} onClose={() => setOpen(null)}
          onImported={it => { setItems(old => old.map(x => (x.id === it.id ? it : x))); setMapItems(old => old && old.map(x => (x.id === it.id ? it : x))) }} />
      })()}
    </div>
  )
}
