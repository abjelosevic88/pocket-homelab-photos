// A light full-screen viewer for photos that live in a cloud: look, zoom, read where and when, import.
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { cloudOriginal, cloudPreview, cloudThumb, clouds } from '../lib/api'
import { useApp } from '../lib/app-context'
import { cloudKind, cloudPlace, cloudWhen, coords, isWebSafe } from '../lib/clouds'
import { bytes, fmtDate, fmtTime } from '../lib/photos'
import type { CloudItem } from '../lib/types'
import { Icon } from './icons'
import { MiniMap } from './PhotoMap'
import { errMsg, useToast } from './ui'
import { usePanZoom } from './usePanZoom'
import { PhotoAskButton } from './PhotoAskButton'

export type CloudRef = CloudItem | { id: number; name?: undefined }

export function CloudViewer({ items, index, setIndex, onClose, onImported }: {
  items: CloudRef[]
  index: number
  setIndex: (n: number) => void
  onClose: () => void
  onImported?: (item: CloudItem) => void
}) {
  const { connection, clouds: accounts, bump, reloadClouds } = useApp()
  const { toast } = useToast()
  const ref = useRef<HTMLDivElement>(null)
  const current = items[index]
  const [item, setItem] = useState<CloudItem | null>(current.name !== undefined ? (current as CloudItem) : null)
  const [info, setInfo] = useState(() => window.innerWidth >= 1100 && localStorage.getItem('pp-cloud-info') !== '0')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [hi, setHi] = useState(false)
  const account = accounts?.find(a => a.id === item?.account_id)
  const go = (d: number) => setIndex(Math.max(0, Math.min(items.length - 1, index + d)))
  const zoomable = !!item && !item.video
  const pz = usePanZoom({ width: item?.width, height: item?.height, enabled: zoomable, onSwipe: go })

  useEffect(() => { const prev = document.activeElement as HTMLElement | null; ref.current?.focus(); return () => prev?.focus?.() }, [])
  useEffect(() => { document.body.classList.add('viewer-open'); return () => document.body.classList.remove('viewer-open') }, [])
  useEffect(() => { localStorage.setItem('pp-cloud-info', info ? '1' : '0') }, [info])
  useEffect(() => {
    pz.reset(); setHi(false); setError('')
    if (current.name !== undefined) { setItem(current as CloudItem); return }
    setItem(null)
    const c = new AbortController()
    clouds.item(current.id, c.signal).then(setItem).catch(e => { if (!c.signal.aborted) setError(errMsg(e)) })
    return () => c.abort()
  }, [current.id]) // eslint-disable-line react-hooks/exhaustive-deps
  // Zoomed past the preview: the original is sharper, when a browser can show it.
  useEffect(() => { if (pz.zoomed && item && !hi && isWebSafe(item.mime) && pz.needsDetail()) setHi(true) }, [pz.zoomed, pz.style.transform]) // eslint-disable-line react-hooks/exhaustive-deps

  const imported = !!item?.import_status
  async function importIt() {
    if (!item) return
    setBusy(true)
    try {
      const r = await clouds.importItem(item.id)
      const next = { ...item, import_status: r.status, imported_asset_id: r.asset_id }
      setItem(next); onImported?.(next); bump(); reloadClouds()
      toast(r.status === 'duplicate' ? 'Already in your library' : 'Imported into your library')
    } catch (e) { setError(errMsg(e)) } finally { setBusy(false) }
  }

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest('input,textarea,select') || document.querySelector('.modal-backdrop, pocket-ask-launcher[open]')) return
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (e.key === 'Escape') { e.preventDefault(); if (pz.zoomed) pz.reset(); else onClose() }
      else if (e.key === 'ArrowRight') go(1)
      else if (e.key === 'ArrowLeft') go(-1)
      else if (e.key === 'i') setInfo(v => !v)
      else if (zoomable && (e.key === '+' || e.key === '=')) pz.zoomBy(1.5)
      else if (zoomable && e.key === '-') pz.zoomBy(1 / 1.5)
      else if (zoomable && e.key === '0') pz.reset()
      else if (zoomable && e.key === '1') pz.zoomActual()
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  })

  const when = item ? cloudWhen(item) : ''
  const place = item ? cloudPlace(item) : ''
  const located = item?.lat != null && item?.lon != null
  const kind = cloudKind(account?.kind || '')
  return createPortal(
    <div ref={ref} className={`viewer cloud-viewer ${info ? 'with-info' : ''}`} role="dialog" aria-modal="true" aria-label={item?.name || 'Photo'} tabIndex={-1}>
      <header className="viewer-bar">
        <button type="button" className="vbtn" aria-label="Close viewer" title="Close (esc)" onClick={onClose}><Icon name="x" size={20} /></button>
        <div className="viewer-title">
          <b className="ellipsis">{item?.name || 'Loading…'}</b>
          <small>{[when ? fmtDate(when) : '', place, account?.name, `${index + 1} of ${items.length}`].filter(Boolean).join(' · ')}</small>
        </div>
        <span className="spacer" />
        {item && !item.video && <PhotoAskButton key={item.id} previewURL={cloudPreview(item.id)} name={item.name}
          context={`Photo: ${item.name}\nSource: ${account?.name || kind.label}\n${item.taken_at ? 'Taken' : 'File date'}: ${when || 'Unknown'}`} onError={setError} />}
        <button type="button" className={`vbtn ${info ? 'on' : ''}`} aria-label="Show photo information" aria-pressed={info} title="Details (i)" onClick={() => setInfo(!info)}><Icon name="info" size={19} /></button>
        {item && <a className="vbtn" href={cloudOriginal(item.id)} download={item.name} aria-label="Download original" title="Download original"><Icon name="download" size={19} /></a>}
        {item && (imported
          ? <span className="vpill done" title="This photo is in your Immich library"><Icon name="check" size={15} />In your library</span>
          : <button type="button" className="vpill accent" disabled={busy || !connection?.connected} onClick={importIt}><Icon name="download" size={15} />{busy ? 'Importing…' : 'Import to library'}</button>)}
      </header>
      {error && <div className="viewer-error" role="alert"><Icon name="alert" size={15} /><span className="grow">{error}</span><button type="button" className="vbtn sm" aria-label="Dismiss" onClick={() => setError('')}><Icon name="x" size={15} /></button></div>}
      <div className="viewer-body">
        <div ref={pz.stage} className={`viewer-stage${pz.zoomed ? ' zoomed' : ''}${pz.dragging ? ' dragging' : ''}`} {...pz.handlers}>
          {index > 0 && <button type="button" className="viewer-nav prev" aria-label="Previous photo" onClick={() => go(-1)}><Icon name="chevron-left" size={26} /></button>}
          {item && (item.video
            ? <video key={item.id} src={cloudOriginal(item.id)} poster={item.has_thumb ? cloudThumb(item.id) : undefined} controls autoPlay playsInline onError={() => setError('This video could not be played here. Download the original instead.')} />
            : <img key={item.id} ref={pz.img} className="pz" src={hi ? cloudOriginal(item.id) : cloudPreview(item.id)} alt={item.name} draggable={false} style={pz.style}
                onError={() => { if (hi) setHi(false); else setError('No preview for this file. The original can still be downloaded.') }} />)}
          {index < items.length - 1 && <button type="button" className="viewer-nav next" aria-label="Next photo" onClick={() => go(1)}><Icon name="chevron-right" size={26} /></button>}
          {zoomable && (
            <div className="viewer-float">
              {pz.zoomed && <button type="button" className="vpill zoom-pct" title="Show actual pixels (1)" onClick={pz.zoomActual}>{pz.percent}%</button>}
              <button type="button" className="vbtn" aria-label={pz.zoomed ? 'Fit photo' : 'Zoom photo'} title={pz.zoomed ? 'Fit (0)' : 'Zoom (click photo, + / −)'} onClick={pz.toggle}><Icon name={pz.zoomed ? 'zoom-out' : 'zoom-in'} size={18} /></button>
            </div>
          )}
        </div>
        {info && item && (
          <aside className="viewer-info" aria-label="Photo details">
            <h2>Details</h2>
            <dl className="info-list">
              <div><Icon name="calendar" size={16} /><dd><b>{when ? fmtDate(when, { weekday: 'short', day: 'numeric', month: 'long', year: 'numeric' }) : 'Unknown date'}</b>{when && <span>{item.taken_at ? fmtTime(when) : 'File date — the photo has no date of its own'}</span>}</dd></div>
              <div><Icon name={item.video ? 'video' : 'image'} size={16} /><dd><b className="ellipsis">{item.name}</b><span>{[bytes(item.size), item.width && item.height ? `${item.width} × ${item.height}` : ''].filter(Boolean).join(' · ')}</span></dd></div>
              {item.camera && <div><Icon name="monitor" size={16} /><dd><b>{item.camera}</b></dd></div>}
              <div><Icon name={kind.icon} size={16} /><dd><b>{account?.name || kind.label}</b><span className="break">{item.path}</span></dd></div>
              {located
                ? <div><Icon name="pin" size={16} /><dd><b>{place || 'Somewhere on the map'}</b><span className="tnum">{coords(item.lat!, item.lon!)}</span></dd></div>
                : <div><Icon name="pin" size={16} /><dd><b>No location</b><span>The file doesn’t say where it was taken.</span></dd></div>}
            </dl>
            {located && <MiniMap lat={item.lat!} lon={item.lon!} label={place} />}
            {item.web_url && <a className="btn sm" href={item.web_url} target="_blank" rel="noreferrer"><Icon name="external" size={14} />Open in {kind.label}</a>}
          </aside>
        )}
      </div>
    </div>, document.body)
}
