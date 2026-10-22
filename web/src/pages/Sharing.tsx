// Links to photos and albums that are open to people outside the box.
import { useEffect, useState } from 'react'
import { immich, isAbort } from '../lib/api'
import { useApp } from '../lib/app-context'
import { fmtDate, plural, thumb } from '../lib/photos'
import type { SharedLink } from '../lib/types'
import { shareURL } from '../components/dialogs'
import { Icon } from '../components/icons'
import { NeedsLibrary } from '../components/Library'
import { Confirm, Empty, Loading, PageHeader, copyText, errMsg, useToast } from '../components/ui'

export default function Sharing() {
  return <NeedsLibrary><SharingInner /></NeedsLibrary>
}

function SharingInner() {
  const { connection, version, bump } = useApp()
  const { toast } = useToast()
  const [links, setLinks] = useState<SharedLink[] | null>(null)
  const [error, setError] = useState('')
  const [revoke, setRevoke] = useState<SharedLink | null>(null)
  useEffect(() => {
    const c = new AbortController()
    immich.get<SharedLink[]>('/shared-links', c.signal).then(setLinks).catch(e => { if (!isAbort(e)) setError(errMsg(e)) })
    return () => c.abort()
  }, [version])
  return (
    <div className="page">
      <PageHeader title="Sharing" sub="Links you made for people outside this box. They open on your Immich." />
      {error && <div className="callout danger"><Icon name="alert" size={15} /><span>{error}</span></div>}
      {!links && !error && <Loading />}
      {links && !links.length && <Empty icon="link" title="Keep a moment, share a story">Select photos or open an album and choose Share to make a link.</Empty>}
      {!!links?.length && (
        <div className="share-list">
          {links.map(s => {
            const url = shareURL(connection?.public_url, s)
            const cover = s.album?.albumThumbnailAssetId || s.assets?.[0]?.id
            const expired = s.expiresAt && new Date(s.expiresAt) < new Date()
            return (
              <div className="share-row" key={s.id}>
                <span className="share-cover">{cover ? <img src={thumb(cover)} alt="" loading="lazy" /> : <Icon name="link" size={18} />}</span>
                <div className="grow">
                  <div className="share-name ellipsis">{s.description || s.album?.albumName || (s.assets?.length ? plural(s.assets.length, 'photo') : 'Shared photos')}</div>
                  <div className="share-meta">
                    <span className={expired ? 'danger-text' : ''}>{s.expiresAt ? (expired ? 'Expired ' : 'Until ') + fmtDate(s.expiresAt, { day: 'numeric', month: 'short', year: 'numeric' }) : 'No expiry'}</span>
                    {s.password && <span><Icon name="lock" size={12} className="inline-ico" />Password</span>}
                    <span>{s.allowDownload ? 'Downloads on' : 'View only'}</span>
                    {s.showMetadata && <span>With details</span>}
                  </div>
                </div>
                {url && <a className="btn ghost icon-only sm" href={url} target="_blank" rel="noreferrer" aria-label="Open shared page" title="Open"><Icon name="external" size={16} /></a>}
                <button type="button" className="btn ghost icon-only sm" disabled={!url} aria-label="Copy link" title="Copy link" onClick={async () => toast(await copyText(url) ? 'Link copied' : 'Could not copy')}><Icon name="copy" size={16} /></button>
                <button type="button" className="btn ghost icon-only sm" aria-label="Revoke shared link" title="Revoke" onClick={() => setRevoke(s)}><Icon name="trash" size={16} /></button>
              </div>
            )
          })}
        </div>
      )}
      {revoke && <Confirm title="Revoke this link?" message="Anyone who has it loses access right away." confirmLabel="Revoke link" onCancel={() => setRevoke(null)} onConfirm={async () => {
        try { await immich.del('/shared-links/' + revoke.id); setRevoke(null); bump(); toast('Link revoked') } catch (e) { toast(errMsg(e), 'err') }
      }} />}
    </div>
  )
}
