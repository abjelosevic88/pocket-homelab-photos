import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { api, immich, V1 } from './api'
import type { Grouping } from './photos'
import type { Album, AuthStatus, Connection, Stats, User } from './types'

export type ThemeMode = 'system' | 'light' | 'dark'
export type Density = 'comfortable' | 'compact'

interface AppState {
  status: AuthStatus | null
  user: User | null
  /** The person's Immich connection; null while it is being checked. */
  connection: Connection | null
  connectionError: string
  stats: Stats | null
  albums: Album[]
  /** Bumps whenever the library changed: pages reload on it. */
  version: number
  bump: () => void
  themeMode: ThemeMode
  theme: 'light' | 'dark'
  setThemeMode: (m: ThemeMode) => void
  density: Density
  setDensity: (d: Density) => void
  grouping: Grouping
  setGrouping: (g: Grouping) => void
  refresh: () => Promise<void>
  checkConnection: () => Promise<void>
  reloadAlbums: () => Promise<void>
  setUser: (u: User | null) => void
}

export const THEME_KEY = 'pp-theme-mode'
const DENSITY_KEY = 'pp-density'
const GROUP_KEY = 'pp-grouping'

/** The stored choice; no choice means: follow the system. */
export function storedThemeMode(): ThemeMode {
  const v = localStorage.getItem(THEME_KEY)
  return v === 'light' || v === 'dark' ? v : 'system'
}
export function applyTheme(theme: 'light' | 'dark') {
  document.documentElement.dataset.theme = theme
  document.querySelectorAll('meta[name="theme-color"]').forEach(m => m.setAttribute('content', theme === 'dark' ? '#111113' : '#ffffff'))
}

const Ctx = createContext<AppState>(null!)
export function useApp() { return useContext(Ctx) }

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<AuthStatus | null>(null)
  const [user, setUser] = useState<User | null>(null)
  const [connection, setConnection] = useState<Connection | null>(null)
  const [connectionError, setConnectionError] = useState('')
  const [stats, setStats] = useState<Stats | null>(null)
  const [albums, setAlbums] = useState<Album[]>([])
  const [version, setVersion] = useState(0)
  const [themeMode, setThemeModeRaw] = useState<ThemeMode>(storedThemeMode)
  const [systemDark, setSystemDark] = useState(() => window.matchMedia('(prefers-color-scheme: dark)').matches)
  const [density, setDensityRaw] = useState<Density>(() => localStorage.getItem(DENSITY_KEY) === 'compact' ? 'compact' : 'comfortable')
  const [grouping, setGroupingRaw] = useState<Grouping>(() => (['all', 'day', 'month', 'year'].includes(localStorage.getItem(GROUP_KEY) || '') ? localStorage.getItem(GROUP_KEY) as Grouping : 'day'))

  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const h = () => setSystemDark(mq.matches)
    mq.addEventListener('change', h)
    return () => mq.removeEventListener('change', h)
  }, [])
  const theme: 'light' | 'dark' = themeMode === 'system' ? (systemDark ? 'dark' : 'light') : themeMode
  useEffect(() => { applyTheme(theme) }, [theme])
  const setThemeMode = useCallback((m: ThemeMode) => { setThemeModeRaw(m); if (m === 'system') localStorage.removeItem(THEME_KEY); else localStorage.setItem(THEME_KEY, m) }, [])
  const setDensity = useCallback((d: Density) => { setDensityRaw(d); localStorage.setItem(DENSITY_KEY, d) }, [])
  const setGrouping = useCallback((g: Grouping) => { setGroupingRaw(g); localStorage.setItem(GROUP_KEY, g) }, [])
  useEffect(() => { if (status?.title) document.title = status.title }, [status?.title])

  const checkConnection = useCallback(async () => {
    setConnectionError('')
    try { setConnection(await api.get<Connection>(`${V1}/connection`)) } catch (e) { setConnectionError((e as Error).message) }
  }, [])
  const reloadAlbums = useCallback(async () => { setAlbums(await immich.get<Album[]>('/albums').catch(() => [] as Album[])) }, [])

  const refresh = useCallback(async () => {
    const st = await api.get<AuthStatus>(`${V1}/auth/status`)
    setStatus(st)
    setUser(st.user)
    if (st.authenticated) await checkConnection()
  }, [checkConnection])

  useEffect(() => { refresh().catch(() => setStatus({ needs_setup: false, auth_mode: 'local', authenticated: false, user: null, version: '', title: 'Pocket Photos' })) }, [refresh])
  useEffect(() => {
    const h = () => { setUser(null); setStatus(s => s ? { ...s, authenticated: false, user: null } : s) }
    window.addEventListener('pp:unauthorized', h)
    return () => window.removeEventListener('pp:unauthorized', h)
  }, [])
  // the counts in the sidebar and the album list follow every change
  useEffect(() => {
    if (!connection?.connected) { setStats(null); setAlbums([]); return }
    immich.get<Stats>('/assets/statistics').then(setStats).catch(() => {})
    reloadAlbums()
  }, [connection, version, reloadAlbums])

  const bump = useCallback(() => setVersion(v => v + 1), [])

  const value = useMemo<AppState>(() => ({
    status, user, connection, connectionError, stats, albums, version, bump, themeMode, theme, setThemeMode, density, setDensity,
    grouping, setGrouping, refresh, checkConnection, reloadAlbums, setUser,
  }), [status, user, connection, connectionError, stats, albums, version, bump, themeMode, theme, setThemeMode, density, setDensity, grouping, setGrouping, refresh, checkConnection, reloadAlbums])
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}
