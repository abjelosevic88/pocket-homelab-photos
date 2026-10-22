// The row of places photos can come from: Pocket Files, Pocket Documents, each connected cloud, and "Add a cloud".
import { useNavigate } from 'react-router-dom'
import { useApp } from '../lib/app-context'
import { cloudCounts, cloudKind, cloudStatus } from '../lib/clouds'
import { SOURCES } from '../lib/nav'
import { Icon } from './icons'
import { Spinner } from './ui'

export function SourceSwitch({ active, disabled }: { active: string; disabled?: boolean }) {
  const navigate = useNavigate()
  const { clouds } = useApp()
  return (
    <div className="source-switch" role="tablist" aria-label="Source">
      {SOURCES.map(s => (
        <button key={s.id} type="button" role="tab" aria-selected={s.id === active} disabled={disabled} className={`source-tab ${s.id === active ? 'active' : ''}`} onClick={() => navigate(`/sources/${s.id}`)}>
          <span className="source-ico"><Icon name={s.icon} size={18} /></span>
          <span className="grow"><b>{s.label}</b><small>{s.desc}</small></span>
        </button>
      ))}
      {(clouds || []).map(c => {
        const id = 'cloud-' + c.id
        return (
          <button key={id} type="button" role="tab" aria-selected={id === active} disabled={disabled} className={`source-tab cloud ${id === active ? 'active' : ''} ${c.status}`} onClick={() => navigate(`/sources/cloud/${c.id}`)}>
            <span className="source-ico"><Icon name={cloudKind(c.kind).icon} size={18} /></span>
            <span className="grow">
              <b className="ellipsis">{c.name}</b>
              <small className="ellipsis">{c.status === 'idle' ? cloudCounts(c) : cloudStatus(c)}</small>
            </span>
            {c.status === 'scanning' && <Spinner size={13} />}
            {(c.status === 'error' || c.status === 'reconnect') && <Icon name="alert" size={15} className="warn-text" />}
          </button>
        )
      })}
      <button type="button" className="source-tab add" disabled={disabled} onClick={() => navigate('/settings/sources?add=1')}>
        <span className="source-ico"><Icon name="cloud-plus" size={18} /></span>
        <span className="grow"><b>Add a cloud</b><small>Nextcloud, WebDAV, S3, Google Drive, OneDrive or Dropbox.</small></span>
      </button>
    </div>
  )
}
