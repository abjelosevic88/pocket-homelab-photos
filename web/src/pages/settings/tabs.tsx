import React, { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { api, V1 } from '../../lib/api'
import { useApp } from '../../lib/app-context'
import type { User } from '../../lib/types'
import { SOURCES } from '../../lib/nav'
import { bytes, plural } from '../../lib/photos'
import { Icon } from '../../components/icons'
import { Avatar, Field, Segmented, SettingRow, errMsg, useToast } from '../../components/ui'

export function Section({ title, sub, actions, children }: { title: React.ReactNode; sub?: React.ReactNode; actions?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="set-section">
      <div className="set-section-head">
        <div className="grow"><h3>{title}</h3>{sub && <p>{sub}</p>}</div>
        {actions && <div className="row">{actions}</div>}
      </div>
      <div className="set-section-body">{children}</div>
    </section>
  )
}

export function StatusDot({ status, title }: { status: 'ok' | 'error' | 'off' | 'warn'; title?: string }) {
  return <span className={`set-status ${status}`} title={title} aria-label={title || status} role="img" />
}

export function AppearanceTab() {
  const { themeMode, setThemeMode, density, setDensity, grouping, setGrouping } = useApp()
  return (
    <div className="stack loose">
      <Section title="Appearance">
        <SettingRow title="Theme" help="System follows your device’s light or dark setting.">
          <Segmented label="Theme" value={themeMode} onChange={setThemeMode} options={[
            { value: 'system', label: <span className="row"><Icon name="monitor" size={14} />System</span> },
            { value: 'light', label: <span className="row"><Icon name="sun" size={14} />Light</span> },
            { value: 'dark', label: <span className="row"><Icon name="moon" size={14} />Dark</span> },
          ]} />
        </SettingRow>
        <SettingRow title="Thumbnails" help="Compact fits more photos on the screen.">
          <Segmented label="Thumbnails" value={density} onChange={setDensity} options={[{ value: 'comfortable', label: 'Large' }, { value: 'compact', label: 'Compact' }]} />
        </SettingRow>
        <SettingRow title="Group photos by" help="How the library is divided into sections.">
          <Segmented label="Group photos by" value={grouping} onChange={setGrouping} options={[{ value: 'day', label: 'Day' }, { value: 'month', label: 'Month' }, { value: 'year', label: 'Year' }, { value: 'all', label: 'None' }]} />
        </SettingRow>
      </Section>
      <p className="muted small">These choices are kept in this browser.</p>
    </div>
  )
}

export function LibraryTab() {
  const { connection, checkConnection, stats, albums, bump } = useApp()
  const { toast } = useToast()
  const [mode, setMode] = useState<'key' | 'password'>('key')
  const [form, setForm] = useState({ api_key: '', email: '', password: '' })
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const connect = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true); setErr('')
    try {
      await api.put(`${V1}/connection`, mode === 'key' ? { api_key: form.api_key } : { email: form.email, password: form.password })
      setForm({ api_key: '', email: '', password: '' })
      await checkConnection(); bump(); toast('Your library is connected')
    } catch (e) { setErr(errMsg(e)) } finally { setBusy(false) }
  }
  const disconnect = async () => {
    setBusy(true)
    try { await api.del(`${V1}/connection`); await checkConnection(); toast('Direct connection removed. Pocket Core is used when it has one for you.') } catch (e) { toast(errMsg(e), 'err') } finally { setBusy(false) }
  }
  const c = connection
  const quota = c?.user?.quotaSizeInBytes || 0
  return (
    <div className="stack loose">
      <Section title="Immich" sub="Originals, albums, faces, search and sharing all live in your Immich account. Photos never keeps copies."
        actions={<span className="row small"><StatusDot status={c?.connected ? 'ok' : c ? 'error' : 'off'} />{c?.connected ? 'Connected' : c ? 'Not connected' : 'Checking…'}</span>}>
        {c?.connected ? (
          <div className="stack">
            <div className="lib-account">
              <Avatar name={c.user?.name} email={c.user?.email} size={40} />
              <div className="grow">
                <div className="lib-name">{c.user?.name || c.user?.email}</div>
                <div className="muted small">{c.user?.email} · {c.via === 'core' ? 'connected through Pocket Core' : 'connected directly'}</div>
              </div>
              {c.public_url && <a className="btn sm" href={c.public_url} target="_blank" rel="noreferrer"><Icon name="external" size={14} />Open Immich</a>}
            </div>
            {stats && <div className="set-stats three">
              <div className="set-stat"><Icon name="image" size={16} /><span className="set-stat-n tnum">{stats.images.toLocaleString()}</span><span className="set-stat-l">Photos</span></div>
              <div className="set-stat"><Icon name="video" size={16} /><span className="set-stat-n tnum">{stats.videos.toLocaleString()}</span><span className="set-stat-l">Videos</span></div>
              <div className="set-stat"><Icon name="album" size={16} /><span className="set-stat-n tnum">{albums.length}</span><span className="set-stat-l">Albums</span></div>
            </div>}
            {quota > 0 && <div className="stack tight"><div className="row small"><span className="grow">Storage</span><span className="muted">{bytes(c.user?.quotaUsageInBytes || 0)} of {bytes(quota)}</span></div><div className="bar"><span className="fill" style={{ width: Math.max(2, Math.round(((c.user?.quotaUsageInBytes || 0) / quota) * 100)) + '%' }} /></div></div>}
            {c.via === 'direct' && <div><button type="button" className="btn danger-ghost sm" disabled={busy} onClick={disconnect}><Icon name="x" size={14} />Remove the direct connection</button></div>}
          </div>
        ) : c?.message ? <div className="callout warn"><Icon name="info" size={15} /><span>{c.message}</span></div> : null}
      </Section>

      {c?.server_configured ? (
        <Section title={c.connected ? 'Use a different Immich account' : 'Connect directly'} sub={c.core ? 'When Pocket Core already holds your Immich account, nothing is needed here.' : undefined}>
          <form className="stack" onSubmit={connect}>
            <Segmented label="Sign in with" value={mode} onChange={setMode} options={[{ value: 'key', label: 'API key' }, { value: 'password', label: 'Email & password' }]} />
            {mode === 'key' ? (
              <Field label="Immich API key" help="Create one in Immich → Account settings → API keys. Its permissions decide what Photos can do: include user.read and the asset, album, search, people, memory and shared-link permissions you want.">
                <input type="password" value={form.api_key} onChange={e => setForm({ ...form, api_key: e.target.value })} required autoComplete="off" placeholder="Paste your personal API key" />
              </Field>
            ) : (
              <div className="two-col">
                <Field label="Immich email"><input type="email" value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} required autoComplete="username" /></Field>
                <Field label="Immich password" help="Used once to get a session; only the encrypted session is kept."><input type="password" value={form.password} onChange={e => setForm({ ...form, password: e.target.value })} required autoComplete="current-password" /></Field>
              </div>
            )}
            {err && <div className="callout danger"><Icon name="alert" size={15} /><span>{err}</span></div>}
            <div className="row"><button className="btn primary" disabled={busy}>{busy ? 'Connecting…' : 'Connect Immich'}</button></div>
          </form>
        </Section>
      ) : !c?.connected && c && (
        <div className="callout info"><Icon name="info" size={15} /><span>Use the Immich connection in Pocket Core, or set <code>IMMICH_URL</code> on the Photos server to sign in directly.</span></div>
      )}
      <p className="muted small">For automatic camera backup from your phone, use the Immich app with the same account — the photos show up here.</p>
    </div>
  )
}

export function SourcesTab() {
  return (
    <div className="stack loose">
      <Section title="Where else your photos are" sub="Pocket Core decides what Photos may read, with your own permissions. Manage it in Core → Apps acting for me.">
        <div className="set-list">
          {SOURCES.map(s => (
            <div key={s.id} className="set-list-row">
              <span className="acct-ico"><Icon name={s.icon} size={18} /></span>
              <div className="grow"><div className="acct-name">{s.label}</div><div className="muted small">{s.desc} Read only.</div></div>
              <Link className="btn sm" to={`/sources/${s.id}`}>Browse</Link>
            </div>
          ))}
        </div>
      </Section>
      <Section title="How importing works">
        <ul className="set-bullets">
          <li>You pick the photos; Photos copies those originals into your Immich. Nothing syncs in the background.</li>
          <li>The files in Pocket Files and Pocket Documents are never changed, moved or deleted.</li>
          <li>Immich recognises duplicates, so importing the same photo twice does no harm.</li>
          <li>A copy in your library stays yours even if access to the source is taken away later.</li>
        </ul>
      </Section>
    </div>
  )
}

export function AccountTab() {
  const { user, status, setUser } = useApp()
  const { toast } = useToast()
  const navigate = useNavigate()
  const [f, setF] = useState({ name: user?.name || '', email: user?.email || '' })
  const [pw, setPw] = useState({ current: '', next: '', confirm: '' })
  const [busy, setBusy] = useState(false)
  useEffect(() => { if (user) setF({ name: user.name, email: user.email }) }, [user])
  if (!user) return null
  const dirty = f.name !== user.name || f.email !== user.email

  const save = async () => {
    setBusy(true)
    try { const u = await api.put<User>(`${V1}/auth/me`, f); setUser(u); toast('Profile saved') } catch (e) { toast(errMsg(e), 'err') } finally { setBusy(false) }
  }
  const changePw = async () => {
    if (pw.next !== pw.confirm) { toast('The new passwords don’t match', 'err'); return }
    setBusy(true)
    try { await api.put(`${V1}/auth/me`, { current_password: pw.current, new_password: pw.next }); setPw({ current: '', next: '', confirm: '' }); toast('Password changed') } catch (e) { toast(errMsg(e), 'err') } finally { setBusy(false) }
  }
  const signOut = async () => { await api.post(`${V1}/auth/logout`).catch(() => {}); setUser(null); navigate('/login') }

  return (
    <div className="stack loose">
      <Section title="You">
        <div className="set-profile">
          <Avatar name={user.name} email={user.email} size={52} />
          <div className="grow stack">
            <div className="two-col">
              <Field label="Name"><input value={f.name} onChange={e => setF({ ...f, name: e.target.value })} autoComplete="name" /></Field>
              <Field label="Email"><input type="email" value={f.email} onChange={e => setF({ ...f, email: e.target.value })} autoComplete="email" /></Field>
            </div>
            <div className="row"><button className="btn primary" disabled={!dirty || busy} onClick={save}>Save</button>{user.role === 'admin' && <span className="badge accent">Admin</span>}</div>
          </div>
        </div>
      </Section>

      {status?.auth_mode === 'local' && (
        <Section title="Password">
          <form className="stack" onSubmit={e => { e.preventDefault(); changePw() }}>
            <input type="text" autoComplete="username" value={user.email} readOnly hidden />
            <Field label="Current password"><input type="password" value={pw.current} onChange={e => setPw({ ...pw, current: e.target.value })} autoComplete="current-password" /></Field>
            <div className="two-col">
              <Field label="New password" help="At least 8 characters."><input type="password" value={pw.next} onChange={e => setPw({ ...pw, next: e.target.value })} autoComplete="new-password" minLength={8} /></Field>
              <Field label="Repeat new password"><input type="password" value={pw.confirm} onChange={e => setPw({ ...pw, confirm: e.target.value })} autoComplete="new-password" /></Field>
            </div>
            <div className="row"><button className="btn" disabled={busy || pw.next.length < 8 || !pw.confirm}>Change password</button></div>
          </form>
        </Section>
      )}

      <Section title="Session">
        <div className="row">
          {status?.auth_mode === 'local' && <button className="btn danger-ghost" onClick={signOut}><Icon name="log-out" size={15} />Sign out</button>}
          {status?.auth_mode !== 'local' && <span className="muted small">Sign-in is handled by {status?.auth_mode === 'proxy' ? 'the reverse proxy' : 'this box’s setup'}.</span>}
        </div>
      </Section>
    </div>
  )
}

export function AboutTab() {
  const { status, stats, connection } = useApp()
  const rows: [string, React.ReactNode][] = [
    ['Version', <code key="v">{status?.version || 'dev'}</code>],
    ['Sign-in', status?.auth_mode || ''],
    ['Library', connection?.connected ? `Immich (${connection.via === 'core' ? 'through Pocket Core' : 'direct'})` : 'not connected'],
    ['In your library', stats ? `${plural(stats.images, 'photo')}, ${plural(stats.videos, 'video')}` : '—'],
  ]
  return (
    <div className="stack loose">
      <div className="set-about-hero">
        <img src="/favicon.svg" alt="" width={48} height={48} />
        <div>
          <h3>Pocket Photos</h3>
          <p className="muted small">Your photos, together — Immich, Pocket Files and Pocket Documents in one library. Part of the Pocket apps.</p>
        </div>
      </div>
      <Section title="Pocket Core">
        <div className="row">
          <StatusDot status={status?.core_configured ? 'ok' : 'off'} />
          <span>{status?.core_configured ? 'Connected — sign-in, your Immich account and the other Pocket apps come from Core' : 'Not configured on this box'}</span>
        </div>
      </Section>
      <Section title="This server">
        <dl className="set-dl">{rows.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>
      </Section>
      <Section title="Where things are kept">
        <ul className="set-bullets">
          <li>Originals, albums, faces, search and shared links live in Immich — back it up on its own.</li>
          <li>Photos keeps only accounts and encrypted Immich connections in its own small database.</li>
          <li>Uploads in the browser run while the page is open. For background camera backup use the Immich app.</li>
        </ul>
      </Section>
      <div className="row wrap">
        <button className="btn" onClick={() => window.dispatchEvent(new CustomEvent('pp:shortcuts'))}><Icon name="keyboard" size={15} />Keyboard shortcuts</button>
        <a className="btn" href="https://github.com/abjelosevic88/pocket-homelab-photos" target="_blank" rel="noreferrer"><Icon name="external" size={15} />Project on GitHub</a>
      </div>
    </div>
  )
}
