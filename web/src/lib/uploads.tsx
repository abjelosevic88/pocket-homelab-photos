// Browser uploads into the person's Immich: one at a time, with progress,
// cancel and retry. The tray lives at the bottom right of every page.
import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import { IMMICH } from './api'
import { useApp } from './app-context'
import { bytes } from './photos'
import { Icon } from '../components/icons'

export type UploadState = 'queued' | 'uploading' | 'done' | 'error' | 'duplicate' | 'cancelled'
interface Item { file: File; state: UploadState; progress: number; error?: string }

const Ctx = createContext<{ add: (files: File[]) => void }>({ add: () => {} })
export function useUploads() { return useContext(Ctx) }

export const ACCEPT = 'image/*,video/*,.heic,.heif,.dng,.cr2,.cr3,.nef,.arw,.raf'
const MAX = 20 * 1024 ** 3

export function UploadProvider({ children }: { children: React.ReactNode }) {
  const { bump } = useApp()
  const [items, setItems] = useState<Item[]>([])
  const [minimized, setMinimized] = useState(false)
  const ref = useRef<Item[]>([])
  const running = useRef(false)
  const xhr = useRef<XMLHttpRequest | null>(null)
  const alive = useRef(true)
  useEffect(() => () => { alive.current = false; xhr.current?.abort() }, [])

  const update = (i: number, v: Partial<Item>) => {
    ref.current = ref.current.map((x, j) => (j === i ? { ...x, ...v } : x))
    if (alive.current) setItems(ref.current)
  }

  const run = useCallback(async () => {
    if (running.current) return
    running.current = true
    let changed = false
    while (alive.current) {
      const i = ref.current.findIndex(x => x.state === 'queued')
      if (i < 0) break
      const f = ref.current[i].file
      if (f.size > MAX) { update(i, { state: 'error', error: 'Files must be smaller than 20 GB' }); continue }
      update(i, { state: 'uploading' })
      await new Promise<void>(resolve => {
        const x = new XMLHttpRequest()
        xhr.current = x
        x.open('POST', IMMICH + '/assets')
        x.setRequestHeader('X-Pocket-Source', 'web')
        x.upload.onprogress = e => { if (e.lengthComputable) update(i, { progress: Math.round((e.loaded / e.total) * 100) }) }
        x.onerror = () => { update(i, { state: 'error', error: 'Connection interrupted. Try again.' }); resolve() }
        x.onabort = () => { update(i, { state: 'cancelled' }); resolve() }
        x.onload = () => {
          let v: { status?: string; message?: string | string[]; error?: string } | undefined
          try { v = JSON.parse(x.responseText) } catch {}
          if (x.status >= 200 && x.status < 300) {
            changed = true
            update(i, { state: v?.status === 'duplicate' ? 'duplicate' : 'done', progress: 100 })
          } else update(i, { state: 'error', error: (Array.isArray(v?.message) ? v.message.join(', ') : v?.message) || v?.error || 'Upload failed' })
          resolve()
        }
        const form = new FormData()
        form.append('assetData', f, f.name)
        form.append('fileCreatedAt', new Date(f.lastModified).toISOString())
        form.append('fileModifiedAt', new Date(f.lastModified).toISOString())
        x.send(form)
      })
    }
    running.current = false
    if (changed && alive.current) bump()
  }, [bump])

  const add = useCallback((files: File[]) => {
    if (!files.length) return
    ref.current = [...ref.current, ...files.map(file => ({ file, state: 'queued' as const, progress: 0 }))]
    setItems(ref.current)
    setMinimized(false)
    run()
  }, [run])

  const active = items.some(x => x.state === 'queued' || x.state === 'uploading')
  const finished = items.filter(x => x.state === 'done' || x.state === 'duplicate').length
  const close = () => {
    if (active) {
      ref.current = ref.current.map(x => (x.state === 'queued' ? { ...x, state: 'cancelled' } : x))
      setItems(ref.current)
      xhr.current?.abort()
    } else { ref.current = []; setItems([]) }
  }

  return (
    <Ctx.Provider value={{ add }}>
      {children}
      {items.length > 0 && (
        <aside className="upload-tray" aria-label="Uploads">
          <header className="upload-head">
            {active ? <span className="spinner" /> : <Icon name="check-circle" size={16} className="ok-text" />}
            <b className="grow">{active ? 'Uploading' : 'Uploads'} · {finished}/{items.length}</b>
            <button type="button" className="btn ghost icon-only sm" aria-label="Toggle upload details" title="Toggle upload details" onClick={() => setMinimized(m => !m)}><Icon name={minimized ? 'chevron-up' : 'chevron-down'} size={16} /></button>
            <button type="button" className="btn ghost icon-only sm" aria-label={active ? 'Cancel uploads' : 'Close uploads'} title={active ? 'Cancel uploads' : 'Close uploads'} onClick={close}><Icon name="x" size={16} /></button>
          </header>
          {!minimized && (
            <ul className="upload-items">
              {items.map((x, i) => (
                <li className={`upload-item ${x.state}`} key={i}>
                  <div className="grow">
                    <div className="ellipsis upload-name">{x.file.name}</div>
                    <small className="muted">{bytes(x.file.size)} · {x.state === 'duplicate' ? 'Already in your library' : x.state === 'done' ? 'Uploaded' : x.state === 'uploading' ? x.progress + '%' : x.state === 'queued' ? 'Waiting' : x.state === 'cancelled' ? 'Cancelled' : 'Failed'}</small>
                    {x.error && <div className="upload-error">{x.error}</div>}
                    {x.state === 'uploading' && <div className="bar"><span className="fill" style={{ width: x.progress + '%' }} /></div>}
                  </div>
                  {(x.state === 'error' || x.state === 'cancelled') && <button type="button" className="btn sm" onClick={() => { update(i, { state: 'queued', error: '' }); run() }}>Retry</button>}
                </li>
              ))}
            </ul>
          )}
        </aside>
      )}
    </Ctx.Provider>
  )
}
