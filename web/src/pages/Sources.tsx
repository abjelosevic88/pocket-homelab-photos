// Photos that live in Pocket Files and Pocket Documents: browse them with the person's
// own access (through Pocket Core) and copy chosen originals into their Immich.
import { useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { api, isAbort, V1 } from '../lib/api'
import { useApp } from '../lib/app-context'
import { SOURCES, type SourceId } from '../lib/nav'
import { bytes, fmtDate, plural } from '../lib/photos'
import { Icon } from '../components/icons'
import { usePageTitle } from '../components/Layout'
import { Select } from '../components/Select'
import { Empty, Loading, Modal, PageHeader, Spinner, errMsg, useToast } from '../components/ui'

interface Entry { id?: number; name: string; path: string; is_dir?: boolean; size?: number; mime?: string; modified?: string; title?: string }
interface Space { id: string; name: string }
const PAGE = 60
const MEDIA = /\.(heic|heif|dng|cr2|cr3|nef|arw|raf|jpe?g|png|webp|gif|avif|tiff?|mp4|mov|m4v|mkv|webm)$/i
const isMedia = (e: Entry) => !!e.mime?.startsWith('image/') || !!e.mime?.startsWith('video/') || MEDIA.test(e.name)

export default function Sources() {
  const { source: raw } = useParams()
  const source: SourceId = raw === 'documents' ? 'documents' : 'files'
  const navigate = useNavigate()
  const { connection, bump } = useApp()
  const { toast } = useToast()
  const connected = !!connection?.connected
  const meta = SOURCES.find(s => s.id === source)!
  usePageTitle(<span className="ellipsis">{meta.label}</span>, [meta.label])

  const [spaces, setSpaces] = useState<Space[]>([])
  const [space, setSpace] = useState('home')
  const [path, setPath] = useState('/')
  const [entries, setEntries] = useState<Entry[]>([])
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [partial, setPartial] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [preview, setPreview] = useState<Entry | null>(null)
  const [importing, setImporting] = useState(false)
  const [progress, setProgress] = useState('')
  const [results, setResults] = useState<{ name: string; status: string; ok: boolean }[]>([])
  const [q, setQ] = useState('')
  const [search, setSearch] = useState('')
  const [offset, setOffset] = useState(0)
  const [count, setCount] = useState(0)
  const stop = useRef(false)

  const key = (e: Entry) => (source === 'files' ? e.path : String(e.id))
  const base = `${V1}/sources/${source}`
  const raw_ = (e: Entry) => base + (source === 'files' ? '/fs/raw?' + new URLSearchParams({ space, path: e.path }) : `/documents/${e.id}/download?original=1&inline=1`)
  const thumbnail = (e: Entry) => base + (source === 'files' ? '/fs/thumb?' + new URLSearchParams({ space, path: e.path, size: '400' }) : `/documents/${e.id}/thumb`)

  useEffect(() => { setPath('/'); setSearch(''); setQ(''); setOffset(0); setResults([]) }, [source])

  async function load(signal?: AbortSignal) {
    setLoading(true); setError(''); setPartial(false)
    try {
      if (source === 'files') {
        setSpaces(await api.get<Space[]>(`${base}/spaces`, signal))
        const v = await api.get<Entry[] | { entries: Entry[]; partial?: boolean }>(`${base}${search ? '/fs/search?' : '/fs/list?'}${new URLSearchParams({ space, path, q: search })}`, signal)
        const list = Array.isArray(v) ? v : v.entries || []
        setPartial(!Array.isArray(v) && !!v.partial)
        setEntries(list.filter(e => e.is_dir || isMedia(e)).sort((a, b) => Number(!!b.is_dir) - Number(!!a.is_dir)))
      } else {
        const v = await api.get<{ count: number; results: Record<string, unknown>[] }>(`${base}/documents?${new URLSearchParams({ mime: 'image/', q: search, limit: String(PAGE), offset: String(offset) })}`, signal)
        setEntries((v.results || []).map(e => ({
          ...e, name: (e.original_name || e.original_filename || e.title) as string, size: (e.size || e.file_size) as number,
          modified: e.created ? e.created + 'T12:00:00Z' : (e.modified_at as string), path: String(e.id),
        }) as Entry).filter(isMedia))
        setCount(v.count || 0)
      }
    } catch (e) { if (!isAbort(e)) setError(errMsg(e)) } finally { if (!signal?.aborted) setLoading(false) }
  }
  useEffect(() => {
    const c = new AbortController()
    setSelected(new Set()); setEntries([])
    load(c.signal)
    return () => c.abort()
  }, [source, space, path, search, offset]) // eslint-disable-line react-hooks/exhaustive-deps

  async function runImport() {
    setImporting(true); stop.current = false
    const list = entries.filter(e => selected.has(key(e)) && !e.is_dir)
    const all: { name: string; status: string; ok: boolean }[] = []
    for (let i = 0; i < list.length; i++) {
      if (stop.current) break
      const e = list[i]
      setProgress(`${i + 1} of ${list.length} · ${e.name}`)
      try {
        const r = await api.post<{ status?: string }>(`${base}/import`, { space, path: e.path, id: e.id, name: e.name, modified: e.modified })
        all.push({ name: e.name, status: r?.status === 'duplicate' ? 'Already in your library' : 'Imported', ok: true })
      } catch (err) { all.push({ name: e.name, status: errMsg(err), ok: false }) }
      setResults([...all])
    }
    setProgress(''); setImporting(false); setSelected(new Set())
    const ok = all.filter(r => r.ok).length
    toast(`${plural(ok, 'photo')} in your library. The originals in ${meta.label} are unchanged.`)
    bump()
  }

  const toggle = (e: Entry) => setSelected(old => { const n = new Set(old); if (n.has(key(e))) n.delete(key(e)); else n.add(key(e)); return n })
  const crumbs = path.split('/').filter(Boolean)
  const files = entries.filter(e => !e.is_dir)

  return (
    <div className="page sources">
      <PageHeader title={meta.label} sub={source === 'files' ? 'Photos and videos in your home, shared and mounted folders.' : 'Images and scanned photos in your document archive.'}
        actions={<button type="button" className="btn ghost icon-only" aria-label="Refresh source" title="Refresh" disabled={importing} onClick={() => load()}><Icon name="refresh" size={16} /></button>} />
      <div className="source-switch" role="tablist" aria-label="Source">
        {SOURCES.map(s => (
          <button key={s.id} type="button" role="tab" aria-selected={s.id === source} disabled={importing} className={`source-tab ${s.id === source ? 'active' : ''}`} onClick={() => navigate(`/sources/${s.id}`)}>
            <span className="source-ico"><Icon name={s.icon} size={18} /></span>
            <span className="grow"><b>{s.label}</b><small>{s.desc}</small></span>
          </button>
        ))}
      </div>
      <div className="callout info source-note"><Icon name="shield" size={15} /><span>Photos browses with your own access in Pocket Core. Importing copies the originals you pick into your Immich library — nothing in {meta.label} is changed or moved.</span></div>

      <div className="source-tools">
        {source === 'files' && <>
          <Select value={space} options={spaces.map(s => ({ value: s.id, label: s.name }))} onChange={v => { setSpace(v); setPath('/') }} label="File location" size="sm" className="inline" disabled={importing} width={220} />
          <nav className="source-crumbs" aria-label="Folder">
            <button type="button" className="crumb" disabled={importing} onClick={() => { setPath('/'); setSearch(''); setQ('') }}>{spaces.find(s => s.id === space)?.name || 'Home'}</button>
            {crumbs.map((c, i) => <span key={i} className="row"><Icon name="chevron-right" size={14} className="crumb-sep" /><button type="button" className="crumb" disabled={importing} onClick={() => { setPath('/' + crumbs.slice(0, i + 1).join('/')); setSearch(''); setQ('') }}>{c}</button></span>)}
          </nav>
        </>}
        <span className="spacer" />
        <form className="search-field sm" onSubmit={e => { e.preventDefault(); setSearch(q.trim()); setOffset(0) }}>
          <Icon name="search" size={15} />
          <input aria-label="Search this source" placeholder={`Search ${meta.label}…`} value={q} onChange={e => setQ(e.target.value)} disabled={importing} />
        </form>
      </div>

      {selected.size > 0 && (
        <div className="select-bar" role="toolbar" aria-label="Selection">
          <button type="button" className="btn ghost icon-only sm" aria-label="Clear source selection" disabled={importing} onClick={() => setSelected(new Set())}><Icon name="x" size={16} /></button>
          <b className="tnum">{selected.size} selected</b>
          <button type="button" className="btn ghost sm" disabled={importing} onClick={() => setSelected(new Set(files.map(key)))}>Select all</button>
          <span className="spacer" />
          <button type="button" className="btn primary sm" disabled={!connected || importing} onClick={runImport}><Icon name="download" size={14} />Import to library</button>
        </div>
      )}
      {!connected && <div className="callout warn"><Icon name="info" size={15} /><span>You can browse now. Connect your Immich library in Settings to import.</span></div>}
      {error && <div className="callout danger"><Icon name="alert" size={15} /><span className="grow">{error}</span><button type="button" className="btn sm" onClick={() => load()}>Try again</button></div>}
      {partial && <div className="callout warn"><Icon name="info" size={15} /><span>This search reached the source’s limit. Narrow it down or open a smaller folder to see more.</span></div>}
      {loading && <Loading label={`Opening ${meta.label}…`} />}

      <div className="source-grid">
        {entries.map(e => e.is_dir ? (
          <button type="button" key={key(e)} className="source-folder" disabled={importing} onClick={() => { setPath(e.path); setSearch(''); setQ('') }}>
            <Icon name="folder" size={22} /><span className="ellipsis grow">{e.name}</span><Icon name="chevron-right" size={15} className="faint" />
          </button>
        ) : (
          <div key={key(e)} className={`source-item ${selected.has(key(e)) ? 'selected' : ''}`}>
            <button type="button" className="source-thumb" onClick={() => setPreview(e)} aria-label={`Preview ${e.title || e.name}`}>
              <img loading="lazy" src={thumbnail(e)} alt="" onError={ev => ev.currentTarget.classList.add('broken')} />
            </button>
            <label className="source-check">
              <input type="checkbox" checked={selected.has(key(e))} disabled={importing} onChange={() => toggle(e)} aria-label={`Select ${e.name}`} />
              <span className="grow"><span className="ellipsis source-name">{e.title || e.name}</span><span className="faint xsmall">{bytes(e.size || 0)}{e.modified ? ' · ' + fmtDate(e.modified, { day: 'numeric', month: 'short', year: 'numeric' }) : ''}</span></span>
            </label>
          </div>
        ))}
      </div>
      {!entries.length && !loading && !error && <Empty icon="folder" title="No photos here">{source === 'files' ? 'Open another folder or choose another location.' : 'Image documents show up here. PDFs and other documents stay in Pocket Documents.'}</Empty>}
      {source === 'documents' && count > PAGE && (
        <div className="pager">
          <button type="button" className="btn sm" disabled={!offset || importing} onClick={() => setOffset(Math.max(0, offset - PAGE))}>Previous</button>
          <span className="muted small tnum">{offset + 1}–{Math.min(offset + PAGE, count)} of {count}</span>
          <button type="button" className="btn sm" disabled={offset + PAGE >= count || importing} onClick={() => setOffset(offset + PAGE)}>Next</button>
        </div>
      )}

      {importing && <div className="import-bar" role="status"><Spinner /><b className="grow ellipsis">Importing {progress}</b><button type="button" className="btn sm" onClick={() => { stop.current = true }}>Stop after this one</button></div>}
      {results.length > 0 && (
        <section className="import-results" aria-label="Import results">
          <h3>Imported</h3>
          {results.map((r, i) => <div key={i} className="import-row"><Icon name={r.ok ? 'check-circle' : 'alert'} size={15} className={r.ok ? 'ok-text' : 'danger-text'} /><span className="grow ellipsis">{r.name}</span><span className="muted small">{r.status}</span></div>)}
        </section>
      )}

      {preview && (
        <Modal size="xl" title={preview.title || preview.name} onClose={() => setPreview(null)} footer={<>
          <a className="btn ghost" href={raw_(preview)} target="_blank" rel="noreferrer"><Icon name="external" size={15} />Open original</a>
          <span className="spacer" />
          <button type="button" className="btn primary" disabled={!connected || importing} onClick={() => { setSelected(s => new Set(s).add(key(preview))); setPreview(null) }}>Select for import</button>
        </>}>
          <div className="source-preview">{preview.mime?.startsWith('video/') ? <video src={raw_(preview)} controls autoPlay /> : <img src={raw_(preview)} alt={preview.name} />}</div>
        </Modal>
      )}
    </div>
  )
}
