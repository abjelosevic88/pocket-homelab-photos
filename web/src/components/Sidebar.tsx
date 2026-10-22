// Left column: New button, the library, sources from the other Pocket apps — the Pocket Calendar sidebar.
import { useState } from 'react'
import { Link, NavLink, useLocation } from 'react-router-dom'
import { useApp } from '../lib/app-context'
import { cloudCounts, cloudKind, cloudStatus } from '../lib/clouds'
import { LIBRARY_NAV, MORE_NAV, SOURCES } from '../lib/nav'
import { bytes } from '../lib/photos'
import { Icon } from './icons'
import { newItems, type NewKind } from './Layout'
import { type Anchor, Menu, rectOf } from './ui'

export function Sidebar({ onNew, onNavigate }: { onNew: (k: NewKind) => void; onNavigate: () => void }) {
  const { status, connection, stats, clouds } = useApp()
  const loc = useLocation()
  const [menu, setMenu] = useState<Anchor | null>(null)
  const title = status?.title || 'Pocket Photos'
  const quota = connection?.user?.quotaSizeInBytes || 0
  const usage = connection?.user?.quotaUsageInBytes || 0
  const active = (to: string) => (to === '/' ? loc.pathname === '/' : loc.pathname === to || loc.pathname.startsWith(to + '/'))
  return (
    <aside className="sidebar" aria-label="Photos">
      <div className="sb-brand">
        <img src="/favicon.svg" alt="" className="sb-logo" />
        <span className="sb-title">{title !== 'Pocket Photos' ? title : <>Pocket <b>Photos</b></>}</span>
        {status?.version && <span className="sb-version" title={`Version ${status.version}`}>{/^\d/.test(status.version) ? 'v' + status.version : status.version}</span>}
      </div>
      <button type="button" className="btn primary create-btn" aria-haspopup="menu" aria-expanded={!!menu} onClick={e => setMenu(menu ? null : rectOf(e.currentTarget))}>
        <Icon name="plus" size={17} strokeWidth={2.2} />New<Icon name="chevron-down" size={15} className="create-caret" />
      </button>
      {menu && <Menu anchor={menu} items={newItems(onNew, !!connection?.connected)} onClose={() => setMenu(null)} width={252} />}

      <nav className="sb-nav" aria-label="Library">
        {LIBRARY_NAV.map(n => (
          <NavLink key={n.to} to={n.to} end={n.to === '/'} onClick={onNavigate} className={`sb-nav-item ${active(n.to) ? 'active' : ''}`}>
            <Icon name={n.icon} size={16} />{n.label}
            {n.to === '/' && !!stats?.total && <span className="sb-count tnum">{stats.total.toLocaleString()}</span>}
          </NavLink>
        ))}
      </nav>

      <section className="sb-sec">
        <h4 className="sb-h"><span className="sb-h-btn">From your apps</span></h4>
        <ul className="cal-list">
          {SOURCES.map(s => (
            <li key={s.id} className="cal-row">
              <NavLink to={`/sources/${s.id}`} onClick={onNavigate} className={`cal-check ${loc.pathname === `/sources/${s.id}` ? 'is-active' : ''}`} title={s.desc}>
                <span className="space-ico"><img src={s.appIcon} alt="" width={20} height={20} /></span>
                <span className="cal-name ellipsis">{s.label}</span>
              </NavLink>
            </li>
          ))}
          {(clouds || []).map(c => (
            <li key={'cloud-' + c.id} className="cal-row">
              <NavLink to={`/sources/cloud/${c.id}`} onClick={onNavigate} className={`cal-check ${loc.pathname === `/sources/cloud/${c.id}` ? 'is-active' : ''} ${c.status === 'scanning' ? 'is-scanning' : ''}`} title={`${cloudKind(c.kind).label} · ${cloudStatus(c)} · ${cloudCounts(c)}`}>
                <span className="space-ico"><Icon name={cloudKind(c.kind).icon} size={16} /></span>
                <span className="cal-name ellipsis">{c.name}</span>
                {c.status === 'scanning' && <span className="sb-scan" aria-label="Scanning" />}
                {(c.status === 'error' || c.status === 'reconnect') && <Icon name="alert" size={13} className="warn-text" title={cloudStatus(c)} />}
              </NavLink>
            </li>
          ))}
        </ul>
      </section>

      <section className="sb-sec">
        <h4 className="sb-h"><span className="sb-h-btn">More</span></h4>
        <nav className="sb-nav tight" aria-label="More">
          {MORE_NAV.map(n => (
            <NavLink key={n.to} to={n.to} onClick={onNavigate} className={`sb-nav-item ${active(n.to) ? 'active' : ''}`}><Icon name={n.icon} size={16} />{n.label}</NavLink>
          ))}
        </nav>
      </section>

      <div className="sb-usage">
        <div className="sb-usage-row">
          <span className={`sb-conn ${connection?.connected ? 'ok' : ''}`} />
          <span className="grow ellipsis" title={connection?.connected ? (connection.via === 'core' ? 'Immich, through Pocket Core' : 'Immich, connected directly') : undefined}>{!connection ? 'Checking your library…' : connection.connected ? 'Immich' : <Link to="/settings/library" onClick={onNavigate}>Connect your library</Link>}</span>
          {quota > 0 && <span className="faint">{bytes(usage)} of {bytes(quota)}</span>}
        </div>
        {quota > 0 && <div className="bar"><span className="fill" style={{ width: Math.max(2, Math.round((usage / quota) * 100)) + '%' }} /></div>}
      </div>
      <div className="sb-foot with-usage">
        <Link to="/settings" className="sb-foot-link" onClick={onNavigate}><Icon name="settings" size={15} />Settings</Link>
        <button type="button" className="sb-foot-link" onClick={() => { onNavigate(); window.dispatchEvent(new CustomEvent('pp:shortcuts')) }}><Icon name="keyboard" size={15} />Shortcuts</button>
      </div>
    </aside>
  )
}
