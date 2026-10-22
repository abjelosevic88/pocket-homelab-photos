// What each kind of cloud is called and drawn as, and small helpers for accounts and items.
import { fmtDate, plural } from './photos'
import type { CloudAccount, CloudItem, CloudKind } from './types'

export const CLOUD_KINDS: Record<CloudKind, { label: string; icon: string }> = {
  nextcloud: { label: 'Nextcloud', icon: 'nextcloud' },
  webdav: { label: 'WebDAV', icon: 'server' },
  s3: { label: 'S3 bucket', icon: 'bucket' },
  gdrive: { label: 'Google Drive', icon: 'drive' },
  onedrive: { label: 'OneDrive', icon: 'cloud' },
  dropbox: { label: 'Dropbox', icon: 'dropbox' },
}
export const cloudKind = (k: string) => CLOUD_KINDS[k as CloudKind] || { label: 'Cloud', icon: 'cloud' }

/** "2 hours ago", "yesterday", "on 3 March" — when the last scan finished. */
export function ago(s?: string): string {
  if (!s) return ''
  const t = Date.parse(s)
  if (isNaN(t)) return ''
  const m = Math.round((Date.now() - t) / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m} min ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${plural(h, 'hour')} ago`
  const d = Math.round(h / 24)
  if (d === 1) return 'yesterday'
  if (d < 7) return `${d} days ago`
  return 'on ' + fmtDate(s, { day: 'numeric', month: 'short', year: 'numeric' })
}

/** One line about where an account stands. */
export function cloudStatus(a: CloudAccount): string {
  if (a.status === 'scanning') return a.scan ? `Scanning… ${a.scan.seen.toLocaleString()} found, ${a.scan.indexed.toLocaleString()} read` : 'Scanning…'
  if (a.status === 'reconnect') return 'Sign in again to keep it up to date'
  if (a.status === 'error') return a.error || 'The last scan failed'
  return a.last_scan_at ? `Scanned ${ago(a.last_scan_at)}` : 'Not scanned yet'
}

export function cloudCounts(a: CloudAccount): string {
  const c = a.counts || { items: 0, photos: 0, videos: 0, located: 0, imported: 0 }
  if (!c.items) return a.status === 'scanning' ? 'Looking for photos…' : 'No photos yet'
  return [plural(c.photos, 'photo'), c.videos ? plural(c.videos, 'video') : '', c.located ? `${c.located.toLocaleString()} with a place` : ''].filter(Boolean).join(' · ')
}

/** When it was taken, else when the file last changed. */
export const cloudWhen = (i: CloudItem) => i.taken_at || i.modified_at || ''

export function groupCloud(items: CloudItem[]): [string, CloudItem[]][] {
  const out = new Map<string, CloudItem[]>()
  for (const i of items) {
    const k = cloudWhen(i).slice(0, 7) || 'Unknown date'
    const list = out.get(k)
    if (list) list.push(i)
    else out.set(k, [i])
  }
  return [...out.entries()]
}

export const cloudPlace = (i: { city?: string; country?: string }) => [i.city, i.country].filter(Boolean).join(', ')
export const coords = (lat: number, lon: number) => `${Math.abs(lat).toFixed(4)}° ${lat >= 0 ? 'N' : 'S'}, ${Math.abs(lon).toFixed(4)}° ${lon >= 0 ? 'E' : 'W'}`
export const isWebSafe = (mime: string) => /^image\/(jpeg|png|webp|gif|avif)$/.test(mime)
