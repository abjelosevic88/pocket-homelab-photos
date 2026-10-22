// Pages that need the person's Immich show this until it is connected.
import React from 'react'
import { useNavigate } from 'react-router-dom'
import { useApp } from '../lib/app-context'
import { Icon } from './icons'
import { Loading } from './ui'

export function NeedsLibrary({ children }: { children: React.ReactNode }) {
  const { connection, connectionError, checkConnection } = useApp()
  const navigate = useNavigate()
  if (connectionError) return <div className="callout danger"><Icon name="alert" size={15} /><span className="grow">{connectionError}</span><button type="button" className="btn sm" onClick={checkConnection}>Try again</button></div>
  if (!connection) return <Loading label="Opening your library…" />
  if (connection.connected) return <>{children}</>
  return (
    <div className="connect-card">
      <div className="connect-ico"><Icon name="images" size={26} /></div>
      <h2>Your moments start here</h2>
      <p className="muted">Connect your Immich library to browse, organize and rediscover your photos. You can bring in photos from Pocket Files and Pocket Documents too.</p>
      {connection.message && <p className="faint small">{connection.message}</p>}
      <div className="row">
        <button type="button" className="btn primary" onClick={() => navigate('/settings/library')}><Icon name="link" size={15} />Connect your library</button>
        <button type="button" className="btn" onClick={() => navigate('/sources/files')}>Browse your files</button>
      </div>
    </div>
  )
}
