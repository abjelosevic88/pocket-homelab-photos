import { AskButton } from '../components/AskButton'
import { useEffect, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { Icon } from '../components/icons'
import { ShortcutsSheet } from '../components/ShortcutsSheet'
import { Tabs, useIsMobile } from '../components/ui'
import { AboutTab, AccountTab, AppearanceTab, LibraryTab, SourcesTab } from './settings/tabs'

type TabId = 'appearance' | 'library' | 'sources' | 'account' | 'about'

const TABS: { id: TabId; label: string; icon: string; sub: string }[] = [
  { id: 'appearance', label: 'Appearance', icon: 'palette', sub: 'Light or dark, thumbnail size and how photos are grouped.' },
  { id: 'library', label: 'Your photo library', icon: 'images', sub: 'The Immich account your photos, albums and faces live in.' },
  { id: 'sources', label: 'Sources', icon: 'layers', sub: 'Your clouds, Pocket Files and Pocket Documents — read only, with your own access.' },
  { id: 'account', label: 'Account', icon: 'user', sub: 'Who you are signed in as.' },
  { id: 'about', label: 'About', icon: 'info', sub: 'Version, the Pocket Core link and where everything is kept.' },
]

export default function Settings() {
  const { tab: raw } = useParams()
  const navigate = useNavigate()
  const mobile = useIsMobile()
  const tab: TabId = TABS.find(t => t.id === raw)?.id || 'appearance'
  const current = TABS.find(t => t.id === tab)!
  const go = (id: TabId) => navigate(`/settings/${id}`, { replace: true })
  // /settings?tab=sources&cloud=7 (where a cloud's sign-in page sends the browser back) → /settings/sources?cloud=7
  const [sp] = useSearchParams()
  useEffect(() => {
    const t = sp.get('tab')
    if (!raw && t && TABS.some(x => x.id === t)) { const rest = new URLSearchParams(sp); rest.delete('tab'); navigate(`/settings/${t}${rest.size ? '?' + rest : ''}`, { replace: true }) }
  }, [raw, sp, navigate])

  const [shortcuts, setShortcuts] = useState(false)
  useEffect(() => { document.querySelector('.set-content')?.scrollTo({ top: 0 }) }, [tab])
  useEffect(() => {
    const open = () => setShortcuts(true)
    window.addEventListener('pp:shortcuts', open)
    return () => window.removeEventListener('pp:shortcuts', open)
  }, [])

  return (
    <div className="set-page">
      <header className="set-header">
        <button type="button" className="btn ghost icon-only" aria-label="Back to your photos" title="Back to your photos" onClick={() => navigate('/')}><Icon name="chevron-left" size={18} /></button>
        <img src="/favicon.svg" alt="" width={24} height={24} className="set-logo" />
        <h1>Settings</h1>
        <span style={{ flex: 1 }} />
        <AskButton />
      </header>
      {mobile && <div className="set-tabs-mobile"><Tabs tabs={TABS.map(t => ({ id: t.id, label: t.label, icon: t.icon }))} value={tab} onChange={go} /></div>}
      <div className="set-body">
        {!mobile && (
          <nav className="set-nav" aria-label="Settings sections">
            {TABS.map(t => (
              <button key={t.id} type="button" className={`set-nav-item ${t.id === tab ? 'active' : ''}`} aria-current={t.id === tab ? 'page' : undefined} onClick={() => go(t.id)}>
                <Icon name={t.icon} size={16} />{t.label}
              </button>
            ))}
          </nav>
        )}
        <main className="set-content">
          <div className="set-inner" key={tab}>
            <div className="set-title">
              <h2>{current.label}</h2>
              <p>{current.sub}</p>
            </div>
            {tab === 'appearance' && <AppearanceTab />}
            {tab === 'library' && <LibraryTab />}
            {tab === 'sources' && <SourcesTab />}
            {tab === 'account' && <AccountTab />}
            {tab === 'about' && <AboutTab />}
          </div>
        </main>
      </div>
      {shortcuts && <ShortcutsSheet onClose={() => setShortcuts(false)} />}
    </div>
  )
}
