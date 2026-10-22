// Every list of photos: the library, favorites, videos, recently added, archive, trash,
// search results, an album, a person and a place.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { IMMICH, immich, isAbort } from '../lib/api'
import { useApp } from '../lib/app-context'
import type { GalleryView } from '../lib/nav'
import { type Grouping, plural, thumb } from '../lib/photos'
import type { Album, Asset, Person } from '../lib/types'
import { AlbumPicker, ShareDialog } from '../components/dialogs'
import { Icon } from '../components/icons'
import { Crumb, usePageTitle } from '../components/Layout'
import { NeedsLibrary } from '../components/Library'
import { PhotoTimeline } from '../components/PhotoTimeline'
import { PhotoGrid } from '../components/PhotoGrid'
import { Select } from '../components/Select'
import { Viewer } from '../components/Viewer'
import { Confirm, Empty, Loading, MenuButton, PageHeader, Prompt, Segmented, errMsg, useToast } from '../components/ui'

const SUB: Partial<Record<GalleryView, string>> = {
  favorites: 'The photos you love most.',
  videos: 'Every clip in your library.',
  recent: 'The newest arrivals, in the order they came in.',
  archive: 'Hidden from the library, kept safe.',
  trash: 'Restore what you want to keep. Immich empties the trash after its retention period.',
}
const GROUPINGS: { value: Grouping; label: string }[] = [{ value: 'all', label: 'All' }, { value: 'day', label: 'Days' }, { value: 'month', label: 'Months' }, { value: 'year', label: 'Years' }]
const SEARCH_IN = [{ value: 'smart', label: 'What is in the photo' }, { value: 'filename', label: 'File names' }, { value: 'ocr', label: 'Text in photos' }]
const MEDIA = [{ value: '', label: 'Photos and videos' }, { value: 'IMAGE', label: 'Photos' }, { value: 'VIDEO', label: 'Videos' }]

async function warmThumbnails(assets: Asset[], signal: AbortSignal) {
  if (signal.aborted) return
  await new Promise<void>(resolve => {
    const images: HTMLImageElement[] = []
    let remaining = assets.length
    const finish = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', finish)
      for (const image of images) { image.onload = null; image.onerror = null }
      resolve()
    }
    const timer = window.setTimeout(finish, 1500)
    signal.addEventListener('abort', finish, { once: true })
    if (!remaining) { finish(); return }
    for (const asset of assets) {
      const image = new Image()
      images.push(image)
      image.onload = image.onerror = () => { if (--remaining === 0) finish() }
      image.src = thumb(asset)
    }
  })
}

export default function Gallery({ view }: { view: GalleryView }) {
  return <NeedsLibrary><GalleryInner view={view} /></NeedsLibrary>
}

function GalleryInner({ view }: { view: GalleryView }) {
  const { id = '', place = '' } = useParams()
  const [sp, setSp] = useSearchParams()
  const navigate = useNavigate()
  const { version, bump, grouping, setGrouping, density, setDensity, albums } = useApp()
  const { toast } = useToast()
  const [assets, setAssets] = useState<Asset[]>([])
  const [next, setNext] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [replacing, setReplacing] = useState(false)
  const scrollAfterLoad = useRef(false)
  const scrollOnCommit = useRef(false)
  const [error, setError] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [selecting, setSelecting] = useState(false)
  const [viewer, setViewer] = useState<number | null>(null)
  const [order, setOrder] = useState<'desc' | 'asc'>('desc')
  const [dialog, setDialog] = useState<'album' | 'share' | 'share-album' | 'trash' | 'delete' | 'rename' | 'delete-album' | 'name-person' | null>(null)
  const [busy, setBusy] = useState(false)
  const [person, setPerson] = useState<Person | null>(null)
  const generation = useRef(0)
  const abort = useRef<AbortController | null>(null)

  const [timelineOpen, setTimelineOpen] = useState(false)
  const jumpDate = view === 'library' && /^\d{4}(-\d{2})?$/.test(sp.get('date') || '') ? sp.get('date')! : ''
  const [visibleMonth, setVisibleMonth] = useState('')
  const q = sp.get('q') || ''
  const searchIn = sp.get('in') || 'smart'
  const type = sp.get('type') || ''
  const from = sp.get('from') || ''
  const until = sp.get('until') || ''
  const album: Album | undefined = view === 'album' ? albums.find(a => a.id === id) : undefined
  const city = decodeURIComponent(place)
  const smart = view === 'search' && !!q && searchIn === 'smart'
  const scope = JSON.stringify([view, id, city, type, from, until, q, searchIn])
  const previousScope = useRef(scope)

  useEffect(() => {
    if (view !== 'person') { setPerson(null); return }
    immich.get<Person>('/people/' + id).then(setPerson).catch(() => setPerson(null))
  }, [view, id, version])

  usePageTitle(
    view === 'album' ? <Crumb to="/albums" parent="Albums">{album?.albumName || 'Album'}</Crumb>
      : view === 'person' ? <Crumb to="/people" parent="People">{person?.name || 'Someone'}</Crumb>
        : view === 'place' ? <Crumb to="/places" parent="Places">{city}</Crumb>
          : null,
    [view, album?.albumName, person?.name, city],
  )

  // Immich 3.2+ structured search filters
  const filter = useCallback(() => {
    const f: Record<string, unknown> = {
      trashedAt: view === 'trash' ? { ne: null } : { eq: null },
      visibility: { eq: view === 'archive' ? 'archive' : 'timeline' },
    }
    if (['trash', 'album', 'person', 'search', 'place'].includes(view)) delete f.visibility
    if (view === 'favorites') f.isFavorite = { eq: true }
    if (view === 'videos' || type) f.type = { eq: view === 'videos' ? 'VIDEO' : type }
    if (view === 'album') f.albumIds = { any: [id] }
    if (view === 'person') f.personIds = { any: [id] }
    if (view === 'place') f.city = { eq: city }
    if (from || until) f.takenAt = { ...(from ? { gte: new Date(from + 'T00:00:00').toISOString() } : {}), ...(until ? { lte: new Date(until + 'T23:59:59').toISOString() } : {}) }
    if (jumpDate) {
      const year = Number(jumpDate.slice(0, 4)), month = jumpDate.length === 7 ? Number(jumpDate.slice(5)) : 12
      f.takenAt = { lt: new Date(year, month, 1).toISOString() }
    }
    if (view === 'search' && q && searchIn === 'ocr') f.ocr = { matches: q }
    if (view === 'search' && q && searchIn === 'filename') f.originalFileName = { like: '%' + q + '%' }
    return f
  }, [view, id, city, type, from, until, q, searchIn, jumpDate])

  const load = useCallback(async (cursor?: string) => {
    const g = generation.current
    if (!cursor) abort.current?.abort()
    const c = new AbortController()
    abort.current = c
    setLoading(true); setReplacing(!cursor); setError('')
    try {
      const body = {
        filter: filter(), size: 120, withExif: true,
        ...(smart ? { query: q } : { ...(cursor ? { cursor } : {}), orderBy: { field: view === 'recent' ? 'createdAt' : 'fileCreatedAt', direction: jumpDate ? 'desc' : order } }),
      }
      const v = await immich.post<{ assets: { items: Asset[]; nextCursor?: string | null } }>(smart ? '/search/smart' : '/search/metadata', body, c.signal)
      if (g !== generation.current || c.signal.aborted) return
      if (!cursor && scrollAfterLoad.current) {
        // Warm the first screen before swapping grids, so new thumbnails don't flash blank.
        await warmThumbnails(v.assets.items.slice(0, 18), c.signal)
        if (g !== generation.current || c.signal.aborted) return
        scrollOnCommit.current = true
        scrollAfterLoad.current = false
      }
      setAssets(old => (cursor ? [...old, ...v.assets.items.filter(a => !old.some(o => o.id === a.id))] : v.assets.items))
      // Structured smart search returns the best matches without pagination.
      setNext(smart ? null : v.assets.nextCursor || null)
    } catch (e) {
      if (!isAbort(e) && g === generation.current) { setError(errMsg(e)); scrollAfterLoad.current = false }
    } finally { if (g === generation.current) { setLoading(false); setReplacing(false) } }
  }, [filter, smart, q, order, view, jumpDate])

  useEffect(() => {
    generation.current++
    // A date jump or refresh keeps the current grid mounted while its replacement loads.
    if (previousScope.current !== scope) { setAssets([]); scrollAfterLoad.current = false }
    previousScope.current = scope
    setNext(null); setVisibleMonth(''); setSelected(new Set()); setSelecting(false); setViewer(null)
    if (view === 'search' && !q && !type && !from && !until) { setAssets([]); setLoading(false); setReplacing(false); return }
    load()
    return () => abort.current?.abort()
  }, [load, version]) // eslint-disable-line react-hooks/exhaustive-deps

  useLayoutEffect(() => {
    if (!scrollOnCommit.current) return
    scrollOnCommit.current = false
    document.querySelector('.content')?.scrollTo({ top: 0, behavior: 'instant' })
  }, [assets])

  // more as the end of the page comes into view
  const sentinel = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = sentinel.current
    if (!el || !next) return
    const io = new IntersectionObserver(es => { if (es[0].isIntersecting && !loading) load(next) }, { rootMargin: '800px' })
    io.observe(el)
    return () => io.disconnect()
  }, [next, loading, load])

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (replacing) return
      if ((e.target as HTMLElement).closest('input,textarea') || document.querySelector('.modal-backdrop, .palette-backdrop, .viewer')) return
      if ((e.metaKey || e.ctrlKey) && e.key === 'a') { e.preventDefault(); setSelected(new Set(assets.map(a => a.id))); setSelecting(true) }
      if (e.key === 'Escape' && (selected.size || selecting)) { setSelected(new Set()); setSelecting(false) }
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [assets, selected, selecting, replacing])

  const jumpToDate = (date: string) => {
    if (date === jumpDate && order === 'desc') {
      document.querySelector('.content')?.scrollTo({ top: 0, behavior: 'instant' })
      setVisibleMonth('')
      return
    }
    scrollAfterLoad.current = true
    setOrder('desc')
    setVisibleMonth('')
    setSp(prev => { const next = new URLSearchParams(prev); if (date) next.set('date', date); else next.delete('date'); return next })
  }
  // Follow the month at the top of the viewport, including newly paginated photos.
  useEffect(() => {
    if (view !== 'library' || replacing) return
    const root = document.querySelector('.content')
    if (!root) return
    let frame = 0
    const update = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        if (root.scrollTop < 80) { setVisibleMonth(''); return }
        const top = root.getBoundingClientRect().top + 100
        const tile = [...root.querySelectorAll<HTMLElement>('[data-photo-month]')].find(el => el.getBoundingClientRect().bottom >= top)
        if (tile) setVisibleMonth(tile.dataset.photoMonth || '')
      })
    }
    root.addEventListener('scroll', update, { passive: true })
    update()
    return () => { cancelAnimationFrame(frame); root.removeEventListener('scroll', update) }
  }, [view, assets, replacing])

  const ids = [...selected]
  const done = (msg: string) => { toast(msg); setSelected(new Set()); setSelecting(false); setDialog(null); bump() }
  async function act(action: 'favorite' | 'unfavorite' | 'archive' | 'unarchive' | 'trash' | 'delete' | 'restore' | 'remove') {
    if (!ids.length) return
    setBusy(true)
    try {
      if (action === 'trash' || action === 'delete') await immich.del('/assets', { ids, force: action === 'delete' })
      else if (action === 'restore') await immich.post('/trash/restore/assets', { ids })
      else if (action === 'remove') {
        const r = await immich.del<{ success: boolean }[]>(`/albums/${id}/assets`, { ids })
        if (r?.some(x => !x.success)) throw new Error('Some photos could not be removed. Refresh the album and try again.')
      } else await immich.put('/assets', { ids, ...(action === 'favorite' || action === 'unfavorite' ? { isFavorite: action === 'favorite' } : { visibility: action === 'archive' ? 'archive' : 'timeline' }) })
      done({ trash: 'Moved to Recently deleted', delete: 'Deleted for good', restore: 'Restored', remove: 'Removed from the album', favorite: 'Added to favorites', unfavorite: 'Removed from favorites', archive: 'Archived', unarchive: 'Back in the library' }[action])
    } catch (e) { toast(errMsg(e), 'err') } finally { setBusy(false) }
  }
  async function downloadZip() {
    setBusy(true)
    try {
      const r = await fetch(IMMICH + '/download/archive', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Pocket-Source': 'web' }, body: JSON.stringify({ assetIds: ids, archiveName: 'Pocket Photos' }) })
      if (!r.ok) throw new Error('The download could not be prepared')
      const url = URL.createObjectURL(await r.blob())
      const a = document.createElement('a')
      a.href = url; a.download = 'Pocket Photos.zip'; a.click()
      setTimeout(() => URL.revokeObjectURL(url), 60000)
    } catch (e) { toast(errMsg(e), 'err') } finally { setBusy(false) }
  }

  const setParam = (k: string, v: string) => { const n = new URLSearchParams(sp); if (v) n.set(k, v); else n.delete(k); setSp(n, { replace: true }) }
  const title = view === 'library' ? 'All photos' : view === 'search' ? (q ? `“${q}”` : 'Search') : view === 'album' ? album?.albumName || 'Album' : view === 'person' ? person?.name || 'Someone' : view === 'place' ? city : { favorites: 'Favorites', videos: 'Videos', recent: 'Recently added', archive: 'Archive', trash: 'Recently deleted' }[view as string] || ''
  const count = assets.length ? `${plural(assets.length, 'item')}${next ? '+' : ''}` : ''
  const sub = view === 'album' ? [album?.description, count].filter(Boolean).join(' · ') : [SUB[view], count].filter(Boolean).join(' · ')
  const picking = selecting || selected.size > 0

  const headerActions = (
    <>
      {view === 'album' && <>
        <button type="button" className="btn" onClick={() => setDialog('share-album')}><Icon name="link" size={15} />Share</button>
        <MenuButton label="Album options" items={[
          { label: 'Rename…', icon: 'edit', onSelect: () => setDialog('rename') },
          'sep',
          { label: 'Delete album…', icon: 'trash', danger: true, onSelect: () => setDialog('delete-album') },
        ]}><Icon name="more" size={18} /></MenuButton>
      </>}
      {view === 'person' && <button type="button" className="btn" onClick={() => setDialog('name-person')}><Icon name="edit" size={15} />{person?.name ? 'Rename' : 'Add a name'}</button>}
    </>
  )

  return (
    <div className={`page gallery ${view === 'library' ? 'timeline-layout' : ''}`}>
      <div className="gallery-main">
      <PageHeader title={title} sub={sub} actions={view === 'album' || view === 'person' ? headerActions : undefined} />
      {view === 'search' && (
        <div className="search-bar">
          <form className="search-field" onSubmit={e => { e.preventDefault(); setParam('q', (new FormData(e.currentTarget).get('q') as string || '').trim()) }}>
            <Icon name="search" size={16} />
            <input name="q" key={q} defaultValue={q} placeholder="A beach at sunset, a red car, a birthday cake…" aria-label="Search photos" />
          </form>
          <div className="search-filters">
            <Select value={searchIn} options={SEARCH_IN} onChange={v => setParam('in', v === 'smart' ? '' : v)} label="Search in" size="sm" className="inline" />
            <Select value={type} options={MEDIA} onChange={v => setParam('type', v)} label="Media" size="sm" className="inline" />
            <label className="date-filter"><span>From</span><input type="date" value={from} onChange={e => setParam('from', e.target.value)} /></label>
            <label className="date-filter"><span>Until</span><input type="date" value={until} onChange={e => setParam('until', e.target.value)} /></label>
            {(type || from || until || searchIn !== 'smart') && <button type="button" className="btn ghost sm" onClick={() => setSp(q ? { q } : {}, { replace: true })}>Clear filters</button>}
          </div>
        </div>
      )}

      {picking ? (
        <div className="select-bar" role="toolbar" aria-label="Selection">
          <button type="button" className="btn ghost icon-only sm" aria-label="Clear selection" title="Clear selection (esc)" onClick={() => { setSelected(new Set()); setSelecting(false) }}><Icon name="x" size={16} /></button>
          <b className="tnum">{selected.size ? `${selected.size} selected` : 'Select photos'}</b>
          <button type="button" className="btn ghost sm" onClick={() => setSelected(new Set(assets.map(a => a.id)))}>Select all</button>
          <span className="spacer" />
          {view === 'trash' ? <>
            <button type="button" className="btn sm" disabled={busy || !ids.length} onClick={() => act('restore')}><Icon name="undo" size={14} />Restore</button>
            <button type="button" className="btn sm danger" disabled={busy || !ids.length} onClick={() => setDialog('delete')}><Icon name="trash" size={14} />Delete forever</button>
          </> : <>
            <button type="button" className="btn ghost icon-only sm" disabled={!ids.length || busy} aria-label={view === 'favorites' ? 'Remove from favorites' : 'Add to favorites'} title={view === 'favorites' ? 'Remove from favorites' : 'Add to favorites'} onClick={() => act(view === 'favorites' ? 'unfavorite' : 'favorite')}><Icon name="heart" size={17} /></button>
            <button type="button" className="btn ghost icon-only sm" disabled={!ids.length} aria-label="Add to album" title="Add to album" onClick={() => setDialog('album')}><Icon name="album" size={17} /></button>
            <button type="button" className="btn ghost icon-only sm" disabled={!ids.length} aria-label="Share selected photos" title="Share" onClick={() => setDialog('share')}><Icon name="link" size={17} /></button>
            <button type="button" className="btn ghost icon-only sm" disabled={!ids.length || busy} aria-label="Download selected photos as ZIP" title="Download as ZIP" onClick={downloadZip}><Icon name="download" size={17} /></button>
            <button type="button" className="btn ghost icon-only sm" disabled={!ids.length || busy} aria-label={view === 'archive' ? 'Move to library' : 'Archive'} title={view === 'archive' ? 'Move to library' : 'Archive'} onClick={() => act(view === 'archive' ? 'unarchive' : 'archive')}><Icon name="archive" size={17} /></button>
            {view === 'album' && <button type="button" className="btn ghost icon-only sm" disabled={!ids.length || busy} aria-label="Remove from this album" title="Remove from this album" onClick={() => act('remove')}><Icon name="minus" size={17} /></button>}
            <button type="button" className="btn ghost icon-only sm" disabled={!ids.length} aria-label="Move to recently deleted" title="Delete" onClick={() => setDialog('trash')}><Icon name="trash" size={17} /></button>
          </>}
        </div>
      ) : (assets.length > 0 || view !== 'search') && (
        <div className="gallery-tools">
          <Segmented value={grouping} onChange={setGrouping} options={GROUPINGS} size="sm" label="Group photos" />
          <span className="spacer" />
          {view === 'library' && <button type="button" className="btn sm timeline-mobile-toggle" aria-controls="photo-timeline" aria-expanded={timelineOpen} onClick={() => setTimelineOpen(o => !o)}><Icon name="clock" size={14} />Timeline</button>}
          {view !== 'recent' && !smart && <Select value={order} options={[{ value: 'desc', label: 'Newest first' }, { value: 'asc', label: 'Oldest first' }]} onChange={v => { if (jumpDate) jumpToDate(''); setOrder(v) }} label="Sort photos" size="sm" className="ghost inline sort-select" width={170} />}
          <button type="button" className="btn ghost icon-only sm" aria-label={density === 'compact' ? 'Larger thumbnails' : 'Smaller thumbnails'} title={density === 'compact' ? 'Larger thumbnails' : 'Smaller thumbnails'} onClick={() => setDensity(density === 'compact' ? 'comfortable' : 'compact')}><Icon name={density === 'compact' ? 'zoom-in' : 'grid'} size={16} /></button>
          <button type="button" className="btn sm" onClick={() => setSelecting(true)} disabled={!assets.length || replacing}><Icon name="check-circle" size={14} />Select</button>
        </div>
      )}

      {view === 'library' && <div className="timeline-position"><span>{jumpDate ? <>Browsing from {jumpDate.length === 7 ? new Date(Number(jumpDate.slice(0, 4)), Number(jumpDate.slice(5)) - 1, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' }) : jumpDate}</> : 'Latest photos'}</span><button type="button" className="btn ghost sm" style={{ visibility: jumpDate ? 'visible' : 'hidden' }} onClick={() => jumpToDate('')}>Back to latest</button></div>}
      {error && <div className="callout danger"><Icon name="alert" size={15} /><span className="grow">{error}</span><button type="button" className="btn sm" onClick={() => load()}>Try again</button></div>}
      {assets.length > 0 && <div className="gallery-results" aria-busy={replacing}>
        {replacing && <span className="gallery-refresh-status" role="status">Loading photos…</span>}
        <div inert={replacing || undefined}><PhotoGrid assets={assets} grouping={grouping} selected={selected} setSelected={setSelected} selecting={selecting} onOpen={setViewer} /></div>
      </div>}
      {loading && (!assets.length || !replacing) && <Loading label={assets.length ? 'Loading more…' : 'Loading your moments…'} />}
      {!loading && !error && !assets.length && (
        view === 'search' && !q && !type && !from && !until
          ? <Empty icon="search" title="Find the moment you have in mind">Describe what is in the photo — “sunset over the sea”, “a dog in the snow” — or search file names and text in photos.</Empty>
          : <Empty icon={view === 'trash' ? 'trash' : view === 'favorites' ? 'heart' : view === 'videos' ? 'video' : 'image'} title={view === 'search' ? 'No photos found' : view === 'trash' ? 'Nothing was deleted recently' : view === 'favorites' ? 'No favorites yet' : 'A little room for memories'}>
            {view === 'search' ? 'Try another description or other filters.' : view === 'library' ? <>Upload photos, or bring them in from <a href="/sources/files" onClick={e => { e.preventDefault(); navigate('/sources/files') }}>Pocket Files</a>.</> : view === 'favorites' ? 'Tap the heart on a photo to keep it here.' : 'Photos you add here will show up in this view.'}
          </Empty>
      )}
      <div ref={sentinel} />
      {next && !loading && <div className="center"><button type="button" className="btn" onClick={() => load(next)}>Load more</button></div>}

      {viewer !== null && assets[viewer] && <Viewer assets={assets} index={viewer} setIndex={setViewer} onClose={() => setViewer(null)}
        onUpdated={a => setAssets(old => old.map(x => (x.id === a.id ? { ...x, ...a } : x)))} onRemoved={() => { setViewer(null); bump() }} />}
      {dialog === 'album' && <AlbumPicker ids={ids} onClose={() => setDialog(null)} onDone={() => { setDialog(null); setSelected(new Set()); setSelecting(false) }} />}
      {dialog === 'share' && <ShareDialog ids={ids} onClose={() => setDialog(null)} />}
      {dialog === 'share-album' && <ShareDialog albumId={id} onClose={() => setDialog(null)} />}
      {dialog === 'trash' && <Confirm title={`Move ${plural(ids.length, 'item')} to Recently deleted?`} message="You can restore them from Recently deleted." confirmLabel="Move to trash" onCancel={() => setDialog(null)} onConfirm={() => act('trash')} />}
      {dialog === 'delete' && <Confirm title={`Delete ${plural(ids.length, 'item')} for good?`} message="The originals are removed from Immich. This can’t be undone." confirmLabel="Delete forever" onCancel={() => setDialog(null)} onConfirm={() => act('delete')} />}
      {dialog === 'rename' && <Prompt title="Rename album" label="Album name" value={album?.albumName} onClose={() => setDialog(null)} onDone={async name => {
        try { await immich.patch(`/albums/${id}`, { albumName: name }); setDialog(null); bump(); toast('Album renamed') } catch (e) { toast(errMsg(e), 'err') }
      }} />}
      {dialog === 'delete-album' && <Confirm title={`Delete “${album?.albumName || 'this album'}”?`} message="The album goes away. The photos in it stay in your library." confirmLabel="Delete album" onCancel={() => setDialog(null)} onConfirm={async () => {
        try { await immich.del(`/albums/${id}`); setDialog(null); bump(); navigate('/albums'); toast('Album deleted') } catch (e) { toast(errMsg(e), 'err') }
      }} />}
      {dialog === 'name-person' && <Prompt title={person?.name ? 'Rename' : 'Who is this?'} label="Name" value={person?.name} onClose={() => setDialog(null)} onDone={async name => {
        try { await immich.put(`/people/${id}`, { name }); setDialog(null); bump(); toast('Saved') } catch (e) { toast(errMsg(e), 'err') }
      }} />}
      </div>
      {view === 'library' && <PhotoTimeline active={visibleMonth || jumpDate} onJump={jumpToDate} mobileOpen={timelineOpen} onClose={() => setTimelineOpen(false)} />}
    </div>
  )
}
