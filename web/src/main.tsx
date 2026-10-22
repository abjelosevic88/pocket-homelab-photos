import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom'
import './styles/base.css'
import './styles/app.css'
import './styles/settings.css'
import './styles/photos.css'
import { AppProvider, applyTheme, storedThemeMode, useApp } from './lib/app-context'
import { UploadProvider } from './lib/uploads'
import { Loading, ToastProvider } from './components/ui'
import { ErrorBoundary } from './components/ErrorBoundary'
import Layout from './components/Layout'
import Login from './pages/Login'
import Gallery from './pages/Gallery'
import { Albums, Memories, People } from './pages/Collections'
import Places from './pages/Places'
import Sharing from './pages/Sharing'
import Sources from './pages/Sources'
import CloudSource from './pages/CloudSource'
import Settings from './pages/Settings'

function Gate({ children }: { children: React.ReactNode }) {
  const { status, user } = useApp()
  const loc = useLocation()
  if (!status) return <div className="boot"><img src="/favicon.svg" alt="" /><Loading /></div>
  if (status.needs_setup) return <Navigate to="/setup" replace />
  if (!user) return <Navigate to="/login" replace state={{ from: loc.pathname + loc.search }} />
  return <>{children}</>
}

/** The old hash addresses (#view=albums) still open the right page. */
function LegacyHash() {
  const loc = useLocation()
  const h = new URLSearchParams(loc.hash.slice(1))
  const v = h.get('view')
  if (!v) return null
  const id = h.get('id'), name = h.get('name')
  const to = v === 'library' ? '/' : v === 'album' && id ? `/albums/${id}` : v === 'person' && id ? `/people/${id}` : v === 'place' && name ? `/places/${encodeURIComponent(name)}`
    : v === 'settings' ? '/settings' : `/${v}`
  return <Navigate to={to} replace />
}

function App() {
  return (
    <AppProvider>
      <UploadProvider>
        <LegacyHash />
        <Routes>
          <Route path="/login" element={<Login mode="login" />} />
          <Route path="/setup" element={<Login mode="setup" />} />
          <Route path="/settings/:tab?" element={<Gate><ErrorBoundary where="settings"><Settings /></ErrorBoundary></Gate>} />
          <Route element={<Gate><Layout /></Gate>}>
            <Route path="/" element={<Gallery view="library" />} />
            <Route path="/favorites" element={<Gallery view="favorites" />} />
            <Route path="/videos" element={<Gallery view="videos" />} />
            <Route path="/recent" element={<Gallery view="recent" />} />
            <Route path="/archive" element={<Gallery view="archive" />} />
            <Route path="/trash" element={<Gallery view="trash" />} />
            <Route path="/search" element={<Gallery view="search" />} />
            <Route path="/albums" element={<Albums />} />
            <Route path="/albums/:id" element={<Gallery key="album" view="album" />} />
            <Route path="/people" element={<People />} />
            <Route path="/people/:id" element={<Gallery key="person" view="person" />} />
            <Route path="/places" element={<Places />} />
            <Route path="/places/:place" element={<Gallery key="place" view="place" />} />
            <Route path="/memories" element={<Memories />} />
            <Route path="/sharing" element={<Sharing />} />
            <Route path="/sources/cloud/:id" element={<CloudSource key="cloud" />} />
            <Route path="/sources/:source?" element={<Sources />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      </UploadProvider>
    </AppProvider>
  )
}

// Theme before the first paint: the stored choice, else the system's.
{
  const m = storedThemeMode()
  applyTheme(m === 'system' ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : m)
  localStorage.removeItem('photos-theme')
  localStorage.removeItem('photos-density')
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <ErrorBoundary where="app"><ToastProvider><App /></ToastProvider></ErrorBoundary>
    </BrowserRouter>
  </React.StrictMode>,
)
