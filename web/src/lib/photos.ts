// Small helpers for assets: image URLs, dates, sizes, durations.
import { IMMICH } from './api'
import type { Asset } from './types'

/** Thumbnail ("thumbnail" ≈ 250px, "preview" ≈ 1440px) of an asset, edits applied. */
export function thumb(a: Asset | string, size: 'thumbnail' | 'preview' | 'fullsize' = 'thumbnail', edited = true) {
  const id = typeof a === 'string' ? a : a.id
  const c = typeof a === 'string' ? '' : '&c=' + encodeURIComponent(a.thumbhash || '')
  return `${IMMICH}/assets/${id}/thumbnail?size=${size}&edited=${edited}${c}`
}
export const original = (id: string) => `${IMMICH}/assets/${id}/original`
export const playback = (id: string) => `${IMMICH}/assets/${id}/video/playback`
export const faceThumb = (personId: string) => `${IMMICH}/people/${personId}/thumbnail`

export function bytes(n: number) {
  if (!n) return '0 B'
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), 4)
  return (n / 1024 ** i).toFixed(i ? 1 : 0) + ' ' + ['B', 'KB', 'MB', 'GB', 'TB'][i]
}

/** When it was taken, in the place it was taken (Immich's localDateTime). */
export const takenAt = (a: Asset) => a.localDateTime || a.fileCreatedAt

export function fmtDate(s: string | undefined | null, opts: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'long', year: 'numeric' }) {
  if (!s) return 'Unknown date'
  const d = new Date(s)
  return isNaN(+d) ? 'Unknown date' : d.toLocaleDateString(undefined, { timeZone: 'UTC', ...opts })
}
export const fmtTime = (s: string) => new Date(s).toLocaleTimeString(undefined, { timeZone: 'UTC', hour: '2-digit', minute: '2-digit' })

/** "0:01:23.456" or milliseconds → "1:23". */
export function fmtDuration(d: Asset['duration']): string {
  if (d == null || d === '') return ''
  let secs: number
  if (typeof d === 'number') secs = d / 1000
  else {
    const m = /^(\d+):(\d+):(\d+(?:\.\d+)?)$/.exec(d)
    if (!m) return ''
    secs = +m[1] * 3600 + +m[2] * 60 + +m[3]
  }
  secs = Math.round(secs)
  if (!secs) return ''
  const h = Math.floor(secs / 3600), m = Math.floor(secs / 60) % 60, s = secs % 60
  return (h ? `${h}:${String(m).padStart(2, '0')}` : String(m)) + ':' + String(s).padStart(2, '0')
}

export type Grouping = 'all' | 'day' | 'month' | 'year'

export function groupLabel(key: string, g: Grouping) {
  if (g === 'all' || key === 'Unknown date') return key
  if (g === 'year') return key
  if (g === 'month') return fmtDate(key + '-01T12:00:00Z', { month: 'long', year: 'numeric' })
  return fmtDate(key + 'T12:00:00Z', { weekday: 'short', day: 'numeric', month: 'long', year: 'numeric' })
}

export function groupAssets(assets: Asset[], g: Grouping): [string, Asset[]][] {
  const out = new Map<string, Asset[]>()
  for (const a of assets) {
    const raw = takenAt(a)
    const key = g === 'all' ? 'All photos' : raw?.slice(0, g === 'year' ? 4 : g === 'month' ? 7 : 10) || 'Unknown date'
    const list = out.get(key)
    if (list) list.push(a)
    else out.set(key, [a])
  }
  return [...out.entries()]
}

export const plural = (n: number, one: string, many = one + 's') => `${n.toLocaleString()} ${n === 1 ? one : many}`

export function placeName(c: { city?: string | null; state?: string | null; country?: string | null }) {
  return [c.city, c.country].filter(Boolean).join(', ')
}
