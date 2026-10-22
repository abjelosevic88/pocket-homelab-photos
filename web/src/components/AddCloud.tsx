// Connect a cloud: pick a provider, then sign in (OAuth) or fill in its address and password (form).
import { useEffect, useState } from 'react'
import { clouds } from '../lib/api'
import { cloudKind } from '../lib/clouds'
import type { CloudAccount, CloudProvider } from '../lib/types'
import { Icon } from './icons'
import { Field, Loading, Modal, errMsg } from './ui'

export function AddCloud({ onClose, onAdded }: { onClose: () => void; onAdded: (a: CloudAccount) => void }) {
  const [providers, setProviders] = useState<CloudProvider[] | null>(null)
  const [error, setError] = useState('')
  const [pick, setPick] = useState<CloudProvider | null>(null)
  const [via, setVia] = useState<'core' | 'form'>('core')
  const [name, setName] = useState('')
  const [root, setRoot] = useState('')
  const [fields, setFields] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    const c = new AbortController()
    clouds.providers(c.signal).then(setProviders).catch(e => { if (!c.signal.aborted) setError(errMsg(e)) })
    return () => c.abort()
  }, [])

  const choose = (p: CloudProvider) => { setPick(p); setName(p.name); setRoot(''); setFields({}); setError(''); setVia(p.auth === 'core' ? 'core' : 'form') }
  const usesForm = pick && (pick.auth === 'form' || (pick.auth === 'core' && via === 'form'))
  const missing = usesForm ? pick!.fields.filter(f => !f.optional && !fields[f.key]?.trim()).map(f => f.label) : []

  async function connect() {
    if (!pick) return
    setBusy(true); setError('')
    try {
      if (pick.auth === 'oauth') {
        const { url } = await clouds.oauthStart(pick.kind)
        window.location.href = url
        return
      }
      const a = await clouds.create({ kind: pick.kind, name: name.trim() || pick.name, root: root.trim(), ...(pick.auth === 'core' && via === 'core' ? { via: 'core' as const, fields: {} } : { fields }) })
      onAdded(a)
    } catch (e) { setError(errMsg(e)) } finally { setBusy(false) }
  }

  return (
    <Modal size="lg" title={pick ? `Connect ${pick.name}` : 'Add a cloud'} onClose={onClose} className="add-cloud" footer={pick ? <>
      <button type="button" className="btn ghost" disabled={busy} onClick={() => setPick(null)}><Icon name="chevron-left" size={15} />Other clouds</button>
      <span className="spacer" />
      <button type="button" className="btn primary" disabled={busy || missing.length > 0} title={missing.length ? 'Still needed: ' + missing.join(', ') : undefined} onClick={connect}>
        {pick.auth === 'oauth' ? <><Icon name="external" size={15} />{busy ? 'Opening…' : `Continue to ${pick.name}`}</> : busy ? 'Connecting…' : 'Connect'}
      </button>
    </> : undefined}>
      {!pick && <>
        <p className="muted small add-cloud-lead">Photos indexes what is there — dates, cameras and places — and keeps a small thumbnail. Nothing is copied until you import it, and the cloud is only ever read.</p>
        {!providers && !error && <Loading label="Asking which clouds this box can use…" />}
        {providers && (
          <div className="provider-grid" role="list">
            {providers.map(p => (
              <button key={p.kind} type="button" role="listitem" className="provider" disabled={!p.configured} onClick={() => choose(p)} aria-label={`${p.name}${p.configured ? '' : ' (not set up on this box)'}`}>
                <span className="source-ico"><Icon name={cloudKind(p.kind).icon} size={20} /></span>
                <span className="grow">
                  <b>{p.name}</b>
                  <small>{!p.configured ? (p.help || 'Not set up on this box yet.') : p.auth === 'oauth' ? 'Sign in with your account.' : p.auth === 'core' ? 'Your Nextcloud from Pocket Core, or an app password.' : 'Address and password.'}</small>
                </span>
                {p.configured && <Icon name="chevron-right" size={16} className="faint" />}
              </button>
            ))}
          </div>
        )}
      </>}

      {pick && (
        <form className="stack" onSubmit={e => { e.preventDefault(); if (!missing.length) connect() }}>
          {pick.help && pick.auth !== 'oauth' && <p className="muted small">{pick.help}</p>}
          {pick.auth === 'oauth' && <p className="muted small">You sign in on {pick.name}’s own page and allow read-only access. Photos keeps only the permission it is given there, sealed on this server; you can remove it any time. {pick.help}</p>}
          {pick.auth === 'core' && via === 'core' && (
            <div className="via-core">
              <span className="source-ico"><Icon name="shield" size={18} /></span>
              <div className="grow"><b>Use my Nextcloud from Pocket Core</b><div className="muted small">The same Nextcloud login your other Pocket apps use. Nothing to type here.</div></div>
              <button type="button" className="btn ghost sm" onClick={() => { setVia('form'); setError('') }}>Connect directly instead</button>
            </div>
          )}
          {pick.auth === 'core' && via === 'form' && (
            <div className="row small"><span className="muted grow">Connecting with the Nextcloud address, your user name and an app password.</span><button type="button" className="btn ghost sm" onClick={() => { setVia('core'); setError('') }}>Use Pocket Core instead</button></div>
          )}
          {pick.auth !== 'oauth' && <>
            <Field label="Name"><input value={name} onChange={e => setName(e.target.value)} placeholder={pick.name} autoComplete="off" /></Field>
            {usesForm && pick.fields.map(f => (
              <Field key={f.key} label={f.label + (f.optional ? ' (optional)' : '')} help={f.help}>
                <input type={f.secret ? 'password' : 'text'} value={fields[f.key] || ''} placeholder={f.placeholder} autoComplete={f.secret ? 'new-password' : 'off'} spellCheck={false}
                  onChange={e => setFields(v => ({ ...v, [f.key]: e.target.value }))} />
              </Field>
            ))}
            <Field label="Folder (optional)" help="Only photos below this folder; empty = everything.">
              <input value={root} onChange={e => setRoot(e.target.value)} placeholder="/Photos" autoComplete="off" spellCheck={false} />
            </Field>
          </>}
          {error && <div className="callout danger"><Icon name="alert" size={15} /><span className="grow">{error}</span>
            {pick.auth === 'core' && via === 'core' && <button type="button" className="btn sm" onClick={() => { setVia('form'); setError('') }}>Connect directly instead</button>}</div>}
          <button type="submit" hidden />
        </form>
      )}
      {!pick && error && <div className="callout danger"><Icon name="alert" size={15} /><span>{error}</span></div>}
    </Modal>
  )
}
