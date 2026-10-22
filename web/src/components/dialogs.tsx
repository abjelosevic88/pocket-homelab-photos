// Album picker and the sharing-link dialog.
import { useState } from 'react'
import { immich } from '../lib/api'
import { useApp } from '../lib/app-context'
import { plural, thumb } from '../lib/photos'
import type { Album, SharedLink } from '../lib/types'
import { Icon } from './icons'
import { Select } from './Select'
import { CopyField, Field, Modal, Switch, errMsg, useToast } from './ui'

/** The address recipients open: the share page on the public Immich. */
export function shareURL(publicURL: string | undefined, s: Pick<SharedLink, 'key' | 'slug'>) {
  return publicURL ? publicURL.replace(/\/$/, '') + '/share/' + (s.slug || s.key) : ''
}

export function AlbumPicker({ ids, onClose, onDone }: { ids: string[]; onClose: () => void; onDone: () => void }) {
  const { albums, bump } = useApp()
  const { toast } = useToast()
  const [busy, setBusy] = useState(false)
  const [name, setName] = useState('')
  const add = async (a: Album) => {
    setBusy(true)
    try {
      const r = await immich.put<{ id: string; success: boolean; error?: string }[]>(`/albums/${a.id}/assets`, { ids })
      if (r?.some(x => !x.success && x.error !== 'duplicate')) throw new Error('Some photos could not be added. Check the album’s permissions.')
      toast(`Added ${plural(ids.length, 'item')} to “${a.albumName}”`)
      bump(); onDone()
    } catch (e) { toast(errMsg(e), 'err') } finally { setBusy(false) }
  }
  const create = async () => {
    if (!name.trim()) return
    setBusy(true)
    try {
      const a = await immich.post<Album>('/albums', { albumName: name.trim(), assetIds: ids })
      toast(`Created “${a.albumName}”`)
      bump(); onDone()
    } catch (e) { toast(errMsg(e), 'err') } finally { setBusy(false) }
  }
  return (
    <Modal title="Add to album" onClose={onClose} size="sm">
      <div className="stack">
        <ul className="album-pick">
          {albums.map(a => (
            <li key={a.id}><button type="button" className="album-pick-row" disabled={busy} onClick={() => add(a)} aria-label={a.albumName}>
              {a.albumThumbnailAssetId ? <img src={thumb(a.albumThumbnailAssetId)} alt="" /> : <span className="album-pick-ph"><Icon name="album" size={16} /></span>}
              <span className="grow"><span className="ellipsis album-pick-name">{a.albumName}</span><span className="muted xsmall">{plural(a.assetCount, 'item')}</span></span>
            </button></li>
          ))}
          {!albums.length && <li className="muted small">No albums yet.</li>}
        </ul>
        <form className="row" onSubmit={e => { e.preventDefault(); create() }}>
          <input value={name} onChange={e => setName(e.target.value)} placeholder="New album name" aria-label="New album name" maxLength={200} />
          <button className="btn" disabled={busy || !name.trim()}><Icon name="plus" size={15} />Create</button>
        </form>
      </div>
    </Modal>
  )
}

const EXPIRY = [
  { value: 1, label: 'In 24 hours' }, { value: 7, label: 'In 7 days' }, { value: 30, label: 'In 30 days' }, { value: 0, label: 'Never' },
]

export function ShareDialog({ albumId, ids, onClose }: { albumId?: string; ids?: string[]; onClose: () => void }) {
  const { connection, bump } = useApp()
  const [label, setLabel] = useState('')
  const [days, setDays] = useState(7)
  const [password, setPassword] = useState('')
  const [allowDownload, setAllowDownload] = useState(true)
  const [showMetadata, setShowMetadata] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [url, setUrl] = useState('')
  const create = async () => {
    if (!connection?.public_url) { setErr('Set IMMICH_PUBLIC_URL on the server so recipients can open the link.'); return }
    setBusy(true); setErr('')
    try {
      const v = await immich.post<SharedLink>('/shared-links', {
        type: albumId ? 'ALBUM' : 'INDIVIDUAL', ...(albumId ? { albumId } : { assetIds: ids }),
        description: label, password: password || null, expiresAt: days ? new Date(Date.now() + days * 86400000).toISOString() : null,
        allowDownload, allowUpload: false, showMetadata,
      })
      setUrl(shareURL(connection.public_url, v)); bump()
    } catch (e) { setErr(errMsg(e)) } finally { setBusy(false) }
  }
  return (
    <Modal title={albumId ? 'Share this album' : `Share ${plural(ids?.length || 0, 'item')}`} onClose={onClose} footer={url ? <button className="btn primary" onClick={onClose}>Done</button> : <>
      <button className="btn" onClick={onClose}>Cancel</button>
      <button className="btn primary" disabled={busy} onClick={create}>{busy ? 'Creating…' : 'Create link'}</button>
    </>}>
      {url ? (
        <div className="stack">
          <div className="callout success"><Icon name="check-circle" size={15} /><span>The link is ready. Anyone with it can open these photos on your Immich.</span></div>
          <CopyField value={url} label="Share link" />
          <a href={url} target="_blank" rel="noreferrer" className="small">Open the shared page <Icon name="external" size={12} className="inline-ico" /></a>
        </div>
      ) : (
        <div className="stack">
          <p className="muted small">Recipients open the link on your Immich server{connection?.public_url ? <> at <code>{connection.public_url.replace(/^https?:\/\//, '')}</code></> : null}.</p>
          <Field label="Label"><input value={label} onChange={e => setLabel(e.target.value)} placeholder="A weekend to remember" /></Field>
          <div className="two-col">
            <Field label="Expires" group><Select value={days} options={EXPIRY} onChange={setDays} label="Expires" /></Field>
            <Field label="Password (optional)"><input type="password" value={password} onChange={e => setPassword(e.target.value)} autoComplete="new-password" /></Field>
          </div>
          <div className="switch-line"><span className="grow">Allow downloads</span><Switch checked={allowDownload} onChange={setAllowDownload} label="Allow downloads" /></div>
          <div className="switch-line"><span className="grow">Include photo details and locations</span><Switch checked={showMetadata} onChange={setShowMetadata} label="Include photo details and locations" /></div>
          {err && <div className="callout danger"><Icon name="alert" size={15} /><span>{err}</span></div>}
        </div>
      )}
    </Modal>
  )
}
