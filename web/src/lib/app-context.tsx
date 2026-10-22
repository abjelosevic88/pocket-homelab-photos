import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { api, clouds as cloudApi, immich, V1 } from './api'
import type { Grouping } from './photos'
import type { Album, AuthStatus, CloudAccount, Connection, Stats, User } from './types'

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
  /** The person's connected clouds; null until loaded (and [] when this server has none). */
  clouds: CloudAccount[] | null
  reloadClouds: () => Promise<void>
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
  const connectionCheck = useRef<AbortController | null>(null)
  const connectionGeneration = useRef(0)
  const [stats, setStats] = useState<Stats | null>(null)
  const [albums, setAlbums] = useState<Album[]>([])
  const [version, setVersion] = useState(0)
  const [clouds, setClouds] = useState<CloudAccount[] | null>(null)
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
    connectionCheck.current?.abort()
    const controller = new AbortController()
    connectionCheck.current = controller
    try {
      const next = await api.get<Connection>(`${V1}/connection`, controller.signal)
      if (controller.signal.aborted) return
      if (!next.connected) connectionGeneration.current++
      setConnectionError('')
      // A background status check must not reload the library or flash its grid.
      setConnection(current => JSON.stringify(current) === JSON.stringify(next) ? current : next)
    } catch (e) {
      if (controller.signal.aborted) return
      connectionGeneration.current++
      setConnection({ connected: false })
      setConnectionError((e as Error).message)
    }
  }, [])
  const reloadAlbums = useCallback(async () => {
    const generation = connectionGeneration.current
    const next = await immich.get<Album[]>('/albums').catch(() => [] as Album[])
    if (generation === connectionGeneration.current) setAlbums(next)
  }, [])

  const refresh = useCallback(async () => {
    const st = await api.get<AuthStatus>(`${V1}/auth/status`)
    setStatus(st)
    setUser(st.user)
    if (st.authenticated) await checkConnection()
  }, [checkConnection])

  useEffect(() => { refresh().catch(() => setStatus({ needs_setup: false, auth_mode: 'local', authenticated: false, user: null, version: '', title: 'Pocket Photos' })) }, [refresh])
  useEffect(() => {
    const h = () => { connectionCheck.current?.abort(); connectionGeneration.current++; setConnection(null); setUser(null); setStatus(s => s ? { ...s, authenticated: false, user: null } : s) }
    window.addEventListener('pp:unauthorized', h)
    return () => window.removeEventListener('pp:unauthorized', h)
  }, [])
  useEffect(() => {
    if (!user) return
    const refreshVisible = () => { if (document.visibilityState === 'visible') void checkConnection() }
    const unavailable = (event: Event) => {
      connectionCheck.current?.abort()
      connectionGeneration.current++
      setConnection(current => ({ connected: false, core: current?.core, server_configured: current?.server_configured, message: (event as CustomEvent<string>).detail }))
      setStats(null)
      setAlbums([])
    }
    window.addEventListener('focus', refreshVisible)
    document.addEventListener('visibilitychange', refreshVisible)
    window.addEventListener('pp:connection-unavailable', unavailable)
    const timer = window.setInterval(refreshVisible, 15000)
    return () => {
      connectionCheck.current?.abort()
      window.clearInterval(timer)
      window.removeEventListener('focus', refreshVisible)
      document.removeEventListener('visibilitychange', refreshVisible)
      window.removeEventListener('pp:connection-unavailable', unavailable)
    }
  }, [user, checkConnection])
  // the counts in the sidebar and the album list follow every change
  useEffect(() => {
    if (!connection?.connected) { setStats(null); setAlbums([]); return }
    let cancelled = false
    const generation = connectionGeneration.current
    immich.get<Stats>('/assets/statistics').then(next => {
      if (!cancelled && generation === connectionGeneration.current) setStats(next)
    }).catch(() => {})
    reloadAlbums()
    return () => { cancelled = true }
  }, [connection, version, reloadAlbums])

  const bump = useCallback(() => setVersion(v => v + 1), [])

  // Clouds: loaded once signed in, then every 3 seconds while one of them is scanning.
  const reloadClouds = useCallback(async () => {
    try { setClouds(await cloudApi.list()) } catch { setClouds(c => c ?? []) }
  }, [])
  const signedIn = !!user
  useEffect(() => { if (signedIn) reloadClouds(); else setClouds(null) }, [signedIn, reloadClouds])
  const scanning = !!clouds?.some(c => c.status === 'scanning')
  useEffect(() => {
    if (!scanning) return
    const t = setInterval(reloadClouds, 3000)
    return () => clearInterval(t)
  }, [scanning, reloadClouds])

  const value = useMemo<AppState>(() => ({
    status, user, connection, connectionError, stats, albums, version, bump, themeMode, theme, setThemeMode, density, setDensity,
    grouping, setGrouping, refresh, checkConnection, reloadAlbums, setUser, clouds, reloadClouds,
  }), [status, user, connection, connectionError, stats, albums, version, bump, themeMode, theme, setThemeMode, density, setDensity, grouping, setGrouping, refresh, checkConnection, reloadAlbums, clouds, reloadClouds])
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}
