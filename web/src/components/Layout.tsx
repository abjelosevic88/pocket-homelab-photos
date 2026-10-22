// The app shell: sidebar, top bar, search palette, shortcuts — the Pocket Calendar layout.
import React, { createContext, useContext, useEffect, useRef, useState } from 'react'
import { Link, Outlet, useLocation, useNavigate } from 'react-router-dom'
import { api, immich, V1 } from '../lib/api'
import { useApp } from '../lib/app-context'
import { cloudKind } from '../lib/clouds'
import { LIBRARY_NAV, MORE_NAV, SECTION_TITLE } from '../lib/nav'
import type { Album } from '../lib/types'
import { ACCEPT, useUploads } from '../lib/uploads'
import { CommandPalette, type PaletteCommand } from './CommandPalette'
import { ErrorBoundary } from './ErrorBoundary'
import { Icon } from './icons'
import { ShortcutsSheet } from './ShortcutsSheet'
import { Sidebar } from './Sidebar'
import { type Anchor, Avatar, Menu, type MenuItem, MenuButton, modalOpen, Prompt, rectOf, useIsMobile, useMediaQuery, useToast } from './ui'
import { AskButton } from './AskButton'

const SIDEBAR_KEY = 'pp-sidebar'

export type NewKind = 'upload' | 'album' | 'files' | 'documents' | 'cloud'

/** The New menu: the same everywhere (sidebar button, phone button). */
export function newItems(run: (k: NewKind) => void, connected: boolean): MenuItem[] {
  return [
    { label: 'Upload photos…', icon: 'upload', hint: 'U', disabled: !connected, onSelect: () => run('upload') },
    { label: 'New album', icon: 'album', hint: 'N', disabled: !connected, onSelect: () => run('album') },
    'sep',
    { heading: 'Import from your apps' },
    { label: 'From Pocket Files', icon: 'folder', onSelect: () => run('files') },
    { label: 'From Pocket Documents', icon: 'file', onSelect: () => run('documents') },
    { label: 'Add a cloud…', icon: 'cloud-plus', onSelect: () => run('cloud') },
  ]
}

/** Pages put their own title (an album's name) into the top bar. */
const TitleCtx = createContext<(t: React.ReactNode | null) => void>(() => {})
export function usePageTitle(t: React.ReactNode | null, deps: unknown[]) {
  const set = useContext(TitleCtx)
  useEffect(() => { set(t); return () => set(null) }, deps) // eslint-disable-line react-hooks/exhaustive-deps
}

export default function Layout() {
  const { connection, bump, clouds } = useApp()
  const { add } = useUploads()
  const { toast } = useToast()
  const navigate = useNavigate()
  const loc = useLocation()
  const mobile = useIsMobile()
  const narrow = useMediaQuery('(max-width: 1099px)')
  const drawer = mobile || narrow
  const [sidebarOpen, setSidebarOpen] = useState(() => !drawer && localStorage.getItem(SIDEBAR_KEY) !== '0')
  useEffect(() => { setSidebarOpen(!drawer && localStorage.getItem(SIDEBAR_KEY) !== '0') }, [drawer])
  const drawerOpenedAt = useRef(0)
  const toggleSidebar = () => setSidebarOpen(o => { drawerOpenedAt.current = performance.now(); const n = !o; if (!drawer) localStorage.setItem(SIDEBAR_KEY, n ? '1' : '0'); return n })
  const closeDrawer = () => { if (drawer) setSidebarOpen(false) }
  useEffect(() => { closeDrawer() }, [loc.pathname, loc.search]) // eslint-disable-line react-hooks/exhaustive-deps

  const [title, setTitle] = useState<React.ReactNode | null>(null)
  const [palette, setPalette] = useState(false)
  const [shortcuts, setShortcuts] = useState(false)
  const [newAlbum, setNewAlbum] = useState(false)
  const [fabMenu, setFabMenu] = useState<Anchor | null>(null)
  const [dragging, setDragging] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)
  const connected = !!connection?.connected

  const run = (k: NewKind) => {
    closeDrawer()
    if (k === 'upload') fileInput.current?.click()
    else if (k === 'album') setNewAlbum(true)
    else if (k === 'cloud') navigate('/settings/sources?add=1')
    else navigate(`/sources/${k}`)
  }
  const runRef = useRef(run)
  runRef.current = run

  useEffect(() => {
    const open = () => setShortcuts(true)
    window.addEventListener('pp:shortcuts', open)
    return () => window.removeEventListener('pp:shortcuts', open)
  }, [])
  useEffect(() => {
    const keys = Object.fromEntries([...LIBRARY_NAV, ...MORE_NAV].filter(n => n.key).map(n => [n.key!, n.to]))
    const h = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPalette(p => !p); return }
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (t?.closest?.('input, textarea, select, [contenteditable="true"]') || modalOpen() || document.querySelector('.menu, .popover, .select-pop')) return
      if (keys[e.key]) { e.preventDefault(); navigate(keys[e.key]); return }
      switch (e.key) {
        case '/': e.preventDefault(); setPalette(true); break
        case '?': e.preventDefault(); setShortcuts(true); break
        case 'u': if (connected) { e.preventDefault(); runRef.current('upload') } break
        case 'n': if (connected) { e.preventDefault(); runRef.current('album') } break
        case ',': e.preventDefault(); navigate('/settings'); break
        case '[': e.preventDefault(); toggleSidebar(); break
      }
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }) // eslint-disable-line react-hooks/exhaustive-deps

  const commands: PaletteCommand[] = [
    ...(connected ? [
      { id: 'upload', label: 'Upload photos', icon: 'upload', hint: 'U', keywords: 'add', run: () => run('upload') },
      { id: 'album', label: 'New album', icon: 'album', hint: 'N', keywords: 'create', run: () => run('album') },
    ] : []),
    ...[...LIBRARY_NAV, ...MORE_NAV].map(n => ({ id: n.to, label: n.label, icon: n.icon, hint: n.key?.toUpperCase(), run: () => navigate(n.to) })),
    { id: 'files', label: 'Import from Pocket Files', icon: 'folder', keywords: 'sources import', run: () => navigate('/sources/files') },
    { id: 'documents', label: 'Import from Pocket Documents', icon: 'file', keywords: 'sources import', run: () => navigate('/sources/documents') },
    ...(clouds || []).map(c => ({ id: 'cloud-' + c.id, label: `Photos in ${c.name}`, icon: cloudKind(c.kind).icon, keywords: 'cloud sources review ' + cloudKind(c.kind).label, run: () => navigate(`/sources/cloud/${c.id}`) })),
    { id: 'add-cloud', label: 'Add a cloud', icon: 'cloud-plus', keywords: 'nextcloud webdav s3 google drive onedrive dropbox connect', run: () => run('cloud') },
    { id: 'settings', label: 'Settings', icon: 'settings', hint: ',', run: () => navigate('/settings') },
    { id: 'library', label: 'Your Immich connection', icon: 'link', keywords: 'connect api key', run: () => navigate('/settings/library') },
    { id: 'shortcuts', label: 'Keyboard shortcuts', icon: 'keyboard', hint: '?', run: () => setShortcuts(true) },
  ]

  const onDrop = (e: React.DragEvent) => {
    setDragging(false)
    if (!e.dataTransfer.files.length) return
    e.preventDefault()
    if (!connected) { toast('Connect your library before uploading', 'err'); return }
    add(Array.from(e.dataTransfer.files))
  }

  return (
    <TitleCtx.Provider value={setTitle}>
      <div className={`app ${sidebarOpen ? 'with-sidebar' : 'no-sidebar'} ${mobile ? 'is-mobile' : ''} ${drawer ? 'drawer-mode' : ''}`}
        onDragOver={e => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDragging(true) } }}
        onDragLeave={e => { if (e.currentTarget === e.target) setDragging(false) }}
        onDrop={onDrop}>
        {drawer && sidebarOpen && <div className="drawer-backdrop" onClick={e => { if (e.timeStamp - drawerOpenedAt.current > 400) setSidebarOpen(false) }} />}
        <div className={`sidebar-wrap ${sidebarOpen ? 'open' : ''}`}>
          <Sidebar onNew={run} onNavigate={closeDrawer} />
        </div>
        <div className="main">
          <TopBar title={title} onMenu={toggleSidebar} onPalette={() => setPalette(true)} mobile={mobile} compact={narrow} sidebarOpen={sidebarOpen} />
          <div className="content-region">
          <main className="content">
            <div className="content-inner">
              <ErrorBoundary key={loc.pathname.split('/')[1] || 'library'} where={loc.pathname}><Outlet /></ErrorBoundary>
            </div>
          </main>
          <div id="timeline-dock" className="timeline-dock" />
          </div>
        </div>
        {dragging && connected && <div className="drop-hint" aria-hidden="true"><Icon name="upload" size={28} /><b>Drop to upload to your library</b></div>}
        {mobile && <button type="button" className="fab" aria-label="New" title="New" aria-haspopup="menu" aria-expanded={!!fabMenu} onClick={e => setFabMenu(fabMenu ? null : rectOf(e.currentTarget))}><Icon name="plus" size={26} strokeWidth={2.2} /></button>}
        {fabMenu && <Menu anchor={fabMenu} align="right" width={250} items={newItems(run, connected)} onClose={() => setFabMenu(null)} />}
        <input ref={fileInput} type="file" accept={ACCEPT} multiple hidden aria-label="Choose photos to upload" onChange={e => { add(Array.from(e.target.files || [])); e.target.value = '' }} />
        {palette && <CommandPalette onClose={() => setPalette(false)} commands={commands} />}
        {shortcuts && <ShortcutsSheet onClose={() => setShortcuts(false)} />}
        {newAlbum && <Prompt title="New album" label="Album name" placeholder="A weekend to remember" button="Create album" onClose={() => setNewAlbum(false)} onDone={async name => {
          try {
            const a = await immich.post<Album>('/albums', { albumName: name, assetIds: [] })
            setNewAlbum(false); bump(); navigate(`/albums/${a.id}`)
          } catch (e) { toast((e as Error).message, 'err') }
        }} />}
      </div>
    </TitleCtx.Provider>
  )
}

function TopBar({ title, onMenu, onPalette, mobile, compact, sidebarOpen }: { title: React.ReactNode | null; onMenu: () => void; onPalette: () => void; mobile: boolean; compact: boolean; sidebarOpen: boolean }) {
  const { user, themeMode, setThemeMode, status, setUser } = useApp()
  const navigate = useNavigate()
  const loc = useLocation()
  const signOut = async () => { await api.post(`${V1}/auth/logout`).catch(() => {}); setUser(null); navigate('/login') }
  const avatarMenu = (): MenuItem[] => [
    { heading: user?.name || user?.email || '' },
    { label: 'Account', icon: 'user', onSelect: () => navigate('/settings/account') },
    { label: 'Settings', icon: 'settings', onSelect: () => navigate('/settings'), hint: ',' },
    { label: 'Keyboard shortcuts', icon: 'keyboard', onSelect: () => window.dispatchEvent(new CustomEvent('pp:shortcuts')), hint: '?' },
    'sep',
    { heading: 'Appearance' },
    { label: 'System', checked: themeMode === 'system', onSelect: () => setThemeMode('system') },
    { label: 'Light', checked: themeMode === 'light', onSelect: () => setThemeMode('light') },
    { label: 'Dark', checked: themeMode === 'dark', onSelect: () => setThemeMode('dark') },
    ...(status?.auth_mode === 'local' ? ['sep' as const, { label: 'Sign out', icon: 'log-out', onSelect: signOut }] : []),
  ]
  const section = loc.pathname.split('/')[1] || ''
  return (
    <header className="topbar">
      <button type="button" className="btn ghost icon-only" onClick={onMenu} aria-label={sidebarOpen ? 'Hide the sidebar' : 'Show the sidebar'} title="Menu ([)"><Icon name={mobile || compact ? 'menu' : 'sidebar'} size={18} /></button>
      <h1 className="range-title">{title ?? <span className="ellipsis">{SECTION_TITLE[section] || 'Photos'}</span>}</h1>
      <span className="spacer" />
      <button type="button" className="btn ghost icon-only" onClick={onPalette} aria-label="Search" title="Search (⌘K or /)"><Icon name="search" size={18} /></button>
      {mobile && <AskButton />}
      <MenuButton label="Account" className="avatar-btn" align="right" width={220} items={avatarMenu}>
        <Avatar name={user?.name} email={user?.email} size={30} />
      </MenuButton>
    </header>
  )
}

/** "Albums › Norway 2026" in the top bar. */
export function Crumb({ to, parent, children }: { to: string; parent: string; children: React.ReactNode }) {
  return <>
    <Link to={to} className="crumb">{parent}</Link>
    <Icon name="chevron-right" size={16} className="crumb-sep" />
    <span className="ellipsis crumb-cur">{children}</span>
  </>
}
