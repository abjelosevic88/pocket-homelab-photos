// Connect a cloud: pick a provider, then sign in (OAuth) or fill in its address and password (form).
import { useEffect, useState } from 'react'
import { clouds } from '../lib/api'
import { cloudKind } from '../lib/clouds'
import type { CloudAccount, CloudProvider } from '../lib/types'
import { Icon } from './icons'
import { Field, Loading, Modal, errMsg, useToast } from './ui'

export function AddCloud({ onClose, onAdded }: { onClose: () => void; onAdded: (a: CloudAccount) => void }) {
  const [providers, setProviders] = useState<CloudProvider[] | null>(null)
  const [error, setError] = useState('')
  const [pick, setPick] = useState<CloudProvider | null>(null)
  const [via, setVia] = useState<'core' | 'form'>('core')
  const [name, setName] = useState('')
  const [root, setRoot] = useState('')
  const [fields, setFields] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const { toast } = useToast()

  useEffect(() => {
    const c = new AbortController()
    clouds.providers(c.signal).then(setProviders).catch(e => { if (!c.signal.aborted) setError(errMsg(e)) })
    return () => c.abort()
  }, [])

  const choose = (p: CloudProvider) => { setPick(p); setName(p.name); setRoot(''); setFields({}); setError(''); setVia(p.auth === 'core' ? 'core' : 'form') }
  const setup = pick && !pick.configured ? pick.setup : null
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
    <Modal size="lg" title={setup ? `Set up ${pick!.name}` : pick ? `Connect ${pick.name}` : 'Add a cloud'} onClose={onClose} className="add-cloud" footer={pick ? <>
      <button type="button" className="btn ghost" disabled={busy} onClick={() => setPick(null)}><Icon name="chevron-left" size={15} />Other clouds</button>
      <span className="spacer" />
      {setup ? <a className="btn primary" href={setup.console} target="_blank" rel="noreferrer"><Icon name="external" size={15} />Open {setup.console_name}</a> :
      <button type="button" className="btn primary" disabled={busy || missing.length > 0} title={missing.length ? 'Still needed: ' + missing.join(', ') : undefined} onClick={connect}>
        {pick.auth === 'oauth' ? <><Icon name="external" size={15} />{busy ? 'Opening…' : `Continue to ${pick.name}`}</> : busy ? 'Connecting…' : 'Connect'}
      </button>}
    </> : undefined}>
      {!pick && <>
        <p className="muted small add-cloud-lead">Photos indexes what is there — dates, cameras and places — and keeps a small thumbnail. Nothing is copied until you import it, and the cloud is only ever read.</p>
        {!providers && !error && <Loading label="Asking which clouds this box can use…" />}
        {providers && (
          <div className="provider-grid" role="list">
            {providers.map(p => (
              <button key={p.kind} type="button" role="listitem" className={`provider${p.configured ? '' : ' needs-setup'}`} onClick={() => choose(p)} aria-label={`${p.name}${p.configured ? '' : ' (needs a one-time setup on this box)'}`}>
                <span className="source-ico"><Icon name={cloudKind(p.kind).icon} size={20} /></span>
                <span className="grow">
                  <b>{p.name}{!p.configured && <span className="badge">Setup needed</span>}</b>
                  <small>{!p.configured ? 'A one-time app registration by whoever runs this box.' : subtitle(p)}</small>
                </span>
                <Icon name="chevron-right" size={16} className="faint" />
              </button>
            ))}
          </div>
        )}
      </>}

      {setup && (
        <div className="stack cloud-setup">
          <p className="muted small">{pick!.name} lets an app in only once it is registered with {pick!.name} itself. Whoever runs this box does it once; after that everyone here signs in with their own account and allows read-only access.</p>
          <ol className="setup-steps">{setup.steps.map((st, i) => <li key={i}>{st}</li>)}</ol>
          <div className="field"><span className="label">Redirect URI</span>
            <div className="copy-box"><code>{setup.redirect_uri}</code>
              <button type="button" className="btn sm" onClick={() => navigator.clipboard?.writeText(setup.redirect_uri).then(() => toast('Copied'), () => toast('Copy it by hand', 'err'))}><Icon name="copy" size={14} />Copy</button></div>
          </div>
          <div className="field"><span className="label">Settings for Pocket Photos</span>
            <div className="env-list">{setup.env.map(e => <code key={e}>{e}</code>)}</div>
          </div>
        </div>
      )}
      {pick && !setup && (
        <form className="stack" onSubmit={e => { e.preventDefault(); if (!missing.length) connect() }}>
          {pick.auth === 'oauth' && <p className="muted small">You sign in on {pick.name}’s own page and allow read-only access. Photos keeps only the permission it is given there, sealed on this server; you can remove it any time.</p>}
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

function subtitle(p: CloudProvider) {
  switch (p.kind) {
    case 'nextcloud': return p.auth === 'core' ? 'Through Pocket Core, or with an app password.' : 'Address, user name and app password.'
    case 'webdav': return 'Address, user name and password.'
    case 's3': return 'Endpoint, bucket and an access key.'
    default: return 'Sign in with your account.'
  }
}
