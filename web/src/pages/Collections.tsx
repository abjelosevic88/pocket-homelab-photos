// Albums, people and memories: cards that open a set of photos.
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { immich, isAbort } from '../lib/api'
import { useApp } from '../lib/app-context'
import { faceThumb, fmtDate, plural, thumb } from '../lib/photos'
import type { Asset, Memory, Person } from '../lib/types'
import { Icon } from '../components/icons'
import { NeedsLibrary } from '../components/Library'
import { Viewer } from '../components/Viewer'
import { Empty, Loading, PageHeader, Prompt, errMsg, useToast } from '../components/ui'

export function Albums() {
  return <NeedsLibrary><AlbumsInner /></NeedsLibrary>
}
function AlbumsInner() {
  const { albums, reloadAlbums, bump } = useApp()
  const { toast } = useToast()
  const [loaded, setLoaded] = useState(false)
  const [create, setCreate] = useState(false)
  useEffect(() => { reloadAlbums().finally(() => setLoaded(true)) }, [reloadAlbums])
  const sorted = [...albums].sort((a, b) => (b.endDate || '').localeCompare(a.endDate || ''))
  return (
    <div className="page">
      <PageHeader title="Albums" sub={albums.length ? plural(albums.length, 'album') : 'A little order for your favorite stories.'}
        actions={<button type="button" className="btn primary" onClick={() => setCreate(true)}><Icon name="plus" size={15} />New album</button>} />
      {!loaded && !albums.length && <Loading />}
      {loaded && !albums.length && <Empty icon="album" title="Your next story starts with an album">Create an album, then select photos and add them to it.</Empty>}
      <div className="cards">
        {sorted.map(a => (
          <Link key={a.id} to={`/albums/${a.id}`} className="card-tile">
            <span className="card-cover">{a.albumThumbnailAssetId ? <img src={thumb(a.albumThumbnailAssetId, 'preview')} alt="" loading="lazy" /> : <Icon name="album" size={30} />}</span>
            <span className="card-name ellipsis">{a.albumName}</span>
            <span className="card-meta">{plural(a.assetCount, 'item')}{a.startDate ? ' · ' + fmtDate(a.startDate, { month: 'short', year: 'numeric' }) : ''}{a.shared ? ' · Shared' : ''}</span>
          </Link>
        ))}
      </div>
      {create && <Prompt title="New album" label="Album name" placeholder="A weekend to remember" button="Create album" onClose={() => setCreate(false)} onDone={async name => {
        try { await immich.post('/albums', { albumName: name, assetIds: [] }); setCreate(false); bump(); toast(`Created “${name}”`) } catch (e) { toast(errMsg(e), 'err') }
      }} />}
    </div>
  )
}

export function People() {
  return <NeedsLibrary><PeopleInner /></NeedsLibrary>
}
function PeopleInner() {
  const { version, bump } = useApp()
  const { toast } = useToast()
  const [people, setPeople] = useState<Person[] | null>(null)
  const [page, setPage] = useState(1)
  const [more, setMore] = useState(false)
  const [error, setError] = useState('')
  const [naming, setNaming] = useState<Person | null>(null)
  useEffect(() => {
    const c = new AbortController()
    immich.get<{ people: Person[]; hasNextPage: boolean }>(`/people?size=100&page=${page}`, c.signal)
      .then(v => { setPeople(old => (page > 1 && old ? [...old, ...v.people] : v.people)); setMore(v.hasNextPage) })
      .catch(e => { if (!isAbort(e)) setError(errMsg(e)) })
    return () => c.abort()
  }, [page, version])
  const named = people?.filter(p => p.name) || []
  return (
    <div className="page">
      <PageHeader title="People" sub={people?.length ? (named.length === people.length ? plural(people.length, 'person', 'people') : `${plural(named.length, 'person', 'people')} named · ${people.length} found`) : 'The people who make your photos yours.'} />
      {error && <div className="callout danger"><Icon name="alert" size={15} /><span>{error}</span></div>}
      {!people && !error && <Loading />}
      {people && !people.length && <Empty icon="users" title="No people found yet">Immich finds faces as it works through your library. They show up here.</Empty>}
      <div className="people">
        {people?.map(p => (
          <div key={p.id} className="person">
            <Link to={`/people/${p.id}`} className="person-face"><img src={faceThumb(p.id)} alt="" loading="lazy" /></Link>
            {p.name ? <Link to={`/people/${p.id}`} className="person-name ellipsis">{p.name}</Link> : <button type="button" className="link-btn person-name" onClick={() => setNaming(p)}>Add a name</button>}
          </div>
        ))}
      </div>
      {more && <div className="center mt"><button type="button" className="btn" onClick={() => setPage(p => p + 1)}>Load more</button></div>}
      {naming && <Prompt title="Who is this?" label="Name" onClose={() => setNaming(null)} onDone={async name => {
        try { await immich.put(`/people/${naming.id}`, { name }); setNaming(null); bump(); toast('Saved') } catch (e) { toast(errMsg(e), 'err') }
      }} />}
    </div>
  )
}

export function Memories() {
  return <NeedsLibrary><MemoriesInner /></NeedsLibrary>
}
function MemoriesInner() {
  const { version, bump } = useApp()
  const [list, setList] = useState<Memory[] | null>(null)
  const [error, setError] = useState('')
  const [open, setOpen] = useState<{ assets: Asset[]; index: number } | null>(null)
  useEffect(() => {
    const c = new AbortController()
    immich.get<Memory[]>('/memories?size=50&page=1', c.signal).then(setList).catch(e => { if (!isAbort(e)) setError(errMsg(e)) })
    return () => c.abort()
  }, [version])
  const title = (m: Memory) => m.data?.title || (m.data?.year ? yearsAgo(m.data.year) : fmtDate(m.memoryAt))
  return (
    <div className="page">
      <PageHeader title="Memories" sub="A look back at the days worth remembering." />
      {error && <div className="callout danger"><Icon name="alert" size={15} /><span>{error}</span></div>}
      {!list && !error && <Loading />}
      {list && !list.length && <Empty icon="sparkle" title="No memories yet">Immich gathers photos from this day in earlier years. Come back tomorrow.</Empty>}
      <div className="memories">
        {list?.filter(m => m.assets?.length).map(m => (
          <button type="button" key={m.id} className="memory" onClick={() => setOpen({ assets: m.assets, index: 0 })} aria-label={`${title(m)}, ${plural(m.assets.length, 'photo')}`}>
            <img src={thumb(m.assets[0], 'preview')} alt="" loading="lazy" />
            <span className="memory-shade" />
            <span className="memory-text"><b>{title(m)}</b><span>{fmtDate(m.assets[0].localDateTime || m.assets[0].fileCreatedAt)} · {plural(m.assets.length, 'photo')}</span></span>
            <span className="memory-strip">{m.assets.slice(1, 5).map(a => <img key={a.id} src={thumb(a)} alt="" loading="lazy" />)}</span>
          </button>
        ))}
      </div>
      {open && <Viewer assets={open.assets} index={open.index} setIndex={i => setOpen(o => (o ? { ...o, index: i } : o))} onClose={() => setOpen(null)}
        onUpdated={a => setOpen(o => (o ? { ...o, assets: o.assets.map(x => (x.id === a.id ? { ...x, ...a } : x)) } : o))} onRemoved={() => { setOpen(null); bump() }} />}
    </div>
  )
}

function yearsAgo(year: number) {
  const n = new Date().getFullYear() - year
  return n === 1 ? '1 year ago' : `${n} years ago`
}
