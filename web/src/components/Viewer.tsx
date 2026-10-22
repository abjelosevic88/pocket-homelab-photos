// Full-screen viewer: previous/next, zoom, slideshow, details, rating, non-destructive edits.
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { immich } from '../lib/api'
import { bytes, fmtDate, fmtTime, original, placeName, playback, takenAt, thumb } from '../lib/photos'
import type { Asset } from '../lib/types'
import { Icon } from './icons'
import { Select } from './Select'
import { Confirm, errMsg, useToast } from './ui'

const RATINGS = [{ value: 0, label: 'Unrated' }, ...[1, 2, 3, 4, 5].map(n => ({ value: n, label: '★'.repeat(n) }))]

export function Viewer({ assets, index, setIndex, onClose, onUpdated, onRemoved }: {
  assets: Asset[]
  index: number
  setIndex: (n: number) => void
  onClose: () => void
  onUpdated: (a: Asset) => void
  onRemoved: () => void
}) {
  const { toast } = useToast()
  const asset = assets[index]
  const [detail, setDetail] = useState<Asset>(asset)
  const [info, setInfo] = useState(() => window.innerWidth >= 1100 && localStorage.getItem('pp-info') === '1')
  const [editing, setEditing] = useState(false)
  const [zoom, setZoom] = useState(false)
  const [slide, setSlide] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const [angle, setAngle] = useState(0)
  const [mirror, setMirror] = useState(false)
  const [crop, setCrop] = useState(0)
  const [imageVersion, setImageVersion] = useState(0)
  const [live, setLive] = useState(false)
  const [desc, setDesc] = useState('')
  const ref = useRef<HTMLDivElement>(null)
  const touch = useRef(0)

  useEffect(() => { const prev = document.activeElement as HTMLElement | null; ref.current?.focus(); return () => prev?.focus?.() }, [])
  useEffect(() => { localStorage.setItem('pp-info', info ? '1' : '0') }, [info])
  useEffect(() => {
    let live = true
    setDetail(asset); setDesc(asset.exifInfo?.description || ''); setEditing(false); setConfirm(false); setZoom(false); setError(''); setLive(false)
    immich.get<Asset>('/assets/' + asset.id).then(a => { if (live) { setDetail(a); setDesc(a.exifInfo?.description || '') } }).catch(e => { if (live) setError(errMsg(e)) })
    return () => { live = false }
  }, [asset.id]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!slide) return
    const t = setInterval(() => setIndex((index + 1) % assets.length), 5000)
    return () => clearInterval(t)
  }, [slide, index, assets.length, setIndex])

  async function update(v: Record<string, unknown>, ok?: string) {
    setBusy(true)
    try {
      const a = await immich.put<Asset>('/assets/' + asset.id, v)
      setDetail(a); onUpdated(a)
      if (ok) toast(ok)
      return true
    } catch (e) { setError(errMsg(e)); return false } finally { setBusy(false) }
  }
  const go = (d: number) => { if (!editing) setIndex(Math.max(0, Math.min(assets.length - 1, index + d))) }
  const startEdit = () => { if (asset.type === 'VIDEO' || detail.isTrashed) return; setEditing(e => !e); setAngle(0); setMirror(false); setCrop(0) }

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest('input,textarea,select,.select-pop') || document.querySelector('.modal-backdrop')) return
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (e.key === 'Escape') { e.preventDefault(); if (editing) setEditing(false); else onClose() }
      else if (e.key === 'ArrowRight') go(1)
      else if (e.key === 'ArrowLeft') go(-1)
      else if (e.key === 'i') setInfo(v => !v)
      else if (e.key === 'f' && !busy) update({ isFavorite: !detail.isFavorite })
      else if (e.key === 'e') startEdit()
      else if (e.key === ' ') { e.preventDefault(); setSlide(s => !s) }
      else if (e.key === 'Tab') {
        const all = ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input,textarea,a[href]')
        if (!all?.length) return
        const first = all[0], last = all[all.length - 1]
        if (e.shiftKey && (document.activeElement === first || document.activeElement === ref.current)) { e.preventDefault(); last.focus() }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
      }
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  })

  const ex = detail.exifInfo || {}
  const w = detail.width || ex.exifImageWidth, h = detail.height || ex.exifImageHeight
  const saveEdits = async () => {
    setBusy(true)
    try {
      const edits: { action: string; parameters: Record<string, number | string> }[] = []
      if (crop) {
        if (!w || !h) throw new Error('Photo dimensions are not available for cropping')
        edits.push({ action: 'crop', parameters: { x: Math.floor((w * crop) / 100), y: Math.floor((h * crop) / 100), width: Math.floor(w * (1 - crop / 50)), height: Math.floor(h * (1 - crop / 50)) } })
      }
      if (angle) edits.push({ action: 'rotate', parameters: { angle } })
      if (mirror) edits.push({ action: 'mirror', parameters: { axis: 'horizontal' } })
      await immich.put('/assets/' + asset.id + '/edits', { edits })
      setEditing(false); setImageVersion(v => v + 1)
      toast('Edits saved. Immich is making the new preview.')
    } catch (e) { setError(errMsg(e)) } finally { setBusy(false) }
  }
  const revert = async () => {
    setBusy(true)
    try { await immich.del('/assets/' + asset.id + '/edits'); setImageVersion(v => v + 1); setEditing(false); toast('Original restored') } catch (e) { setError(errMsg(e)) } finally { setBusy(false) }
  }
  const remove = async () => {
    setConfirm(false); setBusy(true)
    try { await immich.del('/assets', { ids: [asset.id], force: !!detail.isTrashed }); toast(detail.isTrashed ? 'Deleted for good' : 'Moved to Recently deleted'); onRemoved() } catch (e) { setError(errMsg(e)) } finally { setBusy(false) }
  }
  const restore = async () => {
    try { await immich.post('/trash/restore/assets', { ids: [asset.id] }); toast('Restored'); onRemoved() } catch (e) { setError(errMsg(e)) }
  }

  return createPortal(
    <div className={`viewer ${info && !editing ? 'with-info' : ''}`} role="dialog" aria-modal="true" aria-label="Photo viewer" ref={ref} tabIndex={-1}>
      <header className="viewer-bar">
        <button type="button" className="vbtn" aria-label="Close viewer" title="Close (esc)" onClick={onClose}><Icon name="x" size={20} /></button>
        <div className="viewer-title">
          <b className="ellipsis">{ex.description || detail.originalFileName || 'Photo'}</b>
          <small>{fmtDate(takenAt(detail))}{placeName(ex) ? ' · ' + placeName(ex) : ''} · {index + 1} of {assets.length}</small>
        </div>
        <span className="spacer" />
        <button type="button" className={`vbtn ${detail.isFavorite ? 'fav' : ''}`} aria-label={detail.isFavorite ? 'Remove from favorites' : 'Add to favorites'} title="Favorite (f)" disabled={busy} onClick={() => update({ isFavorite: !detail.isFavorite })}><Icon name="heart" size={19} fill={detail.isFavorite} /></button>
        <button type="button" className={`vbtn ${info ? 'on' : ''}`} aria-label="Show photo information" aria-pressed={info} title="Details (i)" onClick={() => setInfo(!info)}><Icon name="info" size={19} /></button>
        <button type="button" className={`vbtn ${editing ? 'on' : ''}`} aria-label="Edit photo" title="Edit (e)" disabled={asset.type === 'VIDEO' || detail.isTrashed} onClick={startEdit}><Icon name="edit" size={19} /></button>
        <button type="button" className={`vbtn ${slide ? 'on' : ''}`} aria-label={slide ? 'Stop slideshow' : 'Start slideshow'} title="Slideshow (space)" onClick={() => setSlide(!slide)}><Icon name={slide ? 'pause' : 'play'} size={17} /></button>
        <a className="vbtn" href={original(asset.id)} download={detail.originalFileName} aria-label="Download original" title="Download original"><Icon name="download" size={19} /></a>
        <button type="button" className="vbtn" aria-label={detail.isTrashed ? 'Delete permanently' : 'Move to recently deleted'} title={detail.isTrashed ? 'Delete permanently' : 'Delete'} onClick={() => setConfirm(true)}><Icon name="trash" size={19} /></button>
      </header>
      {error && <div className="viewer-error" role="alert"><Icon name="alert" size={15} /><span className="grow">{error}</span><button type="button" className="vbtn sm" aria-label="Dismiss" onClick={() => setError('')}><Icon name="x" size={15} /></button></div>}
      <div className="viewer-body">
        <div className={`viewer-stage ${zoom ? 'zoom' : ''}`}
          onTouchStart={e => (touch.current = e.touches[0].clientX)}
          onTouchEnd={e => { const d = e.changedTouches[0].clientX - touch.current; if (Math.abs(d) > 70 && !zoom) go(d < 0 ? 1 : -1) }}>
          {!editing && index > 0 && <button type="button" className="viewer-nav prev" aria-label="Previous photo" onClick={() => go(-1)}><Icon name="chevron-left" size={26} /></button>}
          {asset.type === 'VIDEO' || live ? (
            <video key={asset.id + String(live)} src={playback(live && detail.livePhotoVideoId ? detail.livePhotoVideoId : asset.id)} poster={thumb(detail, 'preview')} controls autoPlay playsInline
              onError={() => setError('This video could not be played. Try downloading the original.')} />
          ) : (
            <img key={asset.id + imageVersion} className={editing ? 'editing' : ''} src={thumb(detail, 'preview', !editing) + '&v=' + imageVersion}
              alt={ex.description || detail.originalFileName || 'Photo'} onDoubleClick={() => setZoom(!zoom)} draggable={false}
              style={{ transform: editing ? `scaleX(${mirror ? -1 : 1}) rotate(${angle}deg)` : undefined, clipPath: editing && crop ? `inset(${crop}%)` : undefined }}
              onError={() => setError('The preview is unavailable. The original may still be downloadable.')} />
          )}
          {!editing && index < assets.length - 1 && <button type="button" className="viewer-nav next" aria-label="Next photo" onClick={() => go(1)}><Icon name="chevron-right" size={26} /></button>}
          {!editing && (
            <div className="viewer-float">
              {detail.livePhotoVideoId && <button type="button" className="vpill" onClick={() => setLive(!live)}><Icon name="live" size={15} />{live ? 'Still photo' : 'Play Live Photo'}</button>}
              {asset.type !== 'VIDEO' && <button type="button" className="vbtn" aria-label={zoom ? 'Fit photo' : 'Zoom photo'} title={zoom ? 'Fit' : 'Zoom'} onClick={() => setZoom(!zoom)}><Icon name={zoom ? 'zoom-out' : 'zoom-in'} size={18} /></button>}
              <button type="button" className="vbtn" aria-label="Full screen" title="Full screen" onClick={() => { if (document.fullscreenElement) document.exitFullscreen(); else ref.current?.requestFullscreen().catch(() => {}) }}><Icon name="fullscreen" size={18} /></button>
            </div>
          )}
        </div>
        {info && !editing && (
          <aside className="viewer-info" aria-label="Photo details">
            <h2>Details</h2>
            <form className="stack tight" onSubmit={e => { e.preventDefault(); update({ description: desc }, 'Description saved') }} key={asset.id + '-d'}>
              <textarea name="description" aria-label="Description" value={desc} onChange={e => setDesc(e.target.value)} placeholder="Add a description…" rows={2} />
              {desc !== (detail.exifInfo?.description || '') && <div className="row"><button type="submit" className="btn sm primary" disabled={busy}>Save description</button><button type="button" className="btn sm ghost" onClick={() => setDesc(detail.exifInfo?.description || '')}>Cancel</button></div>}
            </form>
            <dl className="info-list">
              <div><Icon name="calendar" size={16} /><dd><b>{fmtDate(takenAt(detail), { weekday: 'short', day: 'numeric', month: 'long', year: 'numeric' })}</b><span>{fmtTime(takenAt(detail))}</span></dd></div>
              <div><Icon name="image" size={16} /><dd><b className="ellipsis">{detail.originalFileName}</b><span>{bytes(ex.fileSizeInByte || 0)}{w && h ? ` · ${w} × ${h}` : ''}{w && h ? ` · ${((w * h) / 1e6).toFixed(1)} MP` : ''}</span></dd></div>
              {(ex.make || ex.model) && <div><Icon name="monitor" size={16} /><dd><b>{[ex.make, ex.model].filter(Boolean).join(' ')}</b><span>{[ex.lensModel, ex.fNumber ? 'ƒ/' + ex.fNumber : '', ex.exposureTime ? ex.exposureTime + ' s' : '', ex.focalLength ? ex.focalLength + ' mm' : '', ex.iso ? 'ISO ' + ex.iso : ''].filter(Boolean).join(' · ')}</span></dd></div>}
              {(ex.city || ex.country) && <div><Icon name="pin" size={16} /><dd><b>{[ex.city, ex.state].filter(Boolean).join(', ') || ex.country}</b><span>{ex.city ? ex.country : ''}{ex.latitude != null && ex.longitude != null && <> {ex.city ? '· ' : ''}<a target="_blank" rel="noreferrer" href={`https://www.openstreetmap.org/?mlat=${ex.latitude}&mlon=${ex.longitude}#map=14/${ex.latitude}/${ex.longitude}`}>{ex.latitude.toFixed(4)}, {ex.longitude.toFixed(4)}</a></>}</span></dd></div>}
            </dl>
            {!!detail.people?.length && (
              <div className="info-people">
                <h3>People</h3>
                <div className="chips">{detail.people.map(p => <span key={p.id} className="chip">{p.name || 'Unnamed person'}</span>)}</div>
              </div>
            )}
            <div className="info-row"><span className="grow">Rating</span><Select value={ex.rating || 0} options={RATINGS} onChange={v => update({ rating: v || null })} label="Rating" size="sm" className="inline" /></div>
            <div className="row wrap">
              <button type="button" className="btn sm" disabled={busy} onClick={() => update({ visibility: detail.visibility === 'archive' ? 'timeline' : 'archive' }, detail.visibility === 'archive' ? 'Back in the library' : 'Archived')}><Icon name="archive" size={14} />{detail.visibility === 'archive' ? 'Move to library' : 'Archive'}</button>
              {detail.isTrashed && <button type="button" className="btn sm" onClick={restore}><Icon name="undo" size={14} />Restore</button>}
            </div>
          </aside>
        )}
      </div>
      {editing && (
        <div className="edit-bar">
          <div className="edit-note"><b>Edit photo</b><small>The original stays untouched. Saving replaces earlier edits.</small></div>
          <button type="button" className="vpill" onClick={() => setAngle((angle + 90) % 360)}><Icon name="rotate" size={15} />Rotate</button>
          <button type="button" className={`vpill ${mirror ? 'on' : ''}`} onClick={() => setMirror(!mirror)}><Icon name="flip" size={15} />Mirror</button>
          <label className="edit-crop">Crop edges <input type="range" min="0" max="40" value={crop} onChange={e => setCrop(+e.target.value)} /><span className="tnum">{crop}%</span></label>
          <span className="spacer" />
          <button type="button" className="vpill" disabled={busy} onClick={revert}>Revert to original</button>
          <button type="button" className="vpill" onClick={() => setEditing(false)}>Cancel</button>
          <button type="button" className="btn primary" disabled={busy || (!angle && !mirror && !crop)} onClick={saveEdits}>{busy ? 'Saving…' : 'Save edits'}</button>
        </div>
      )}
      {confirm && <Confirm title={detail.isTrashed ? 'Delete this photo for good?' : 'Move this photo to Recently deleted?'}
        message={detail.isTrashed ? 'The original is removed from Immich. This can’t be undone.' : 'You can restore it from Recently deleted until Immich empties the trash.'}
        confirmLabel={detail.isTrashed ? 'Delete forever' : 'Move to trash'} onCancel={() => setConfirm(false)} onConfirm={remove} />}
    </div>, document.body)
}
