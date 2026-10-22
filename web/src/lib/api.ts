// Minimal fetch wrapper for the JSON API, plus the Immich pass-through and the clouds.
import type { CloudAccount, CloudItem, CloudItemsPage, CloudMarker, CloudProvider } from './types'
export class ApiError extends Error {
  status: number
  data: Record<string, unknown>
  constructor(status: number, message: string, data: Record<string, unknown> = {}) {
    super(message)
    this.status = status
    this.data = data
  }
}

async function request<T>(method: string, url: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const headers: Record<string, string> = { 'X-Pocket-Source': 'web' }
  const init: RequestInit = { method, headers, credentials: 'same-origin', signal }
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json'
    init.body = JSON.stringify(body)
  }
  const res = await fetch(url, init)
  if (res.status === 401 && !url.includes('/auth/')) window.dispatchEvent(new CustomEvent('pp:unauthorized'))
  if (!res.ok) {
    let msg = res.statusText || `Request failed (${res.status})`
    let data: Record<string, unknown> = {}
    try {
      data = await res.json()
      // Immich answers { message: string | string[] }, Photos { error }
      const m = data.message
      msg = (data.error as string) || (Array.isArray(m) ? m.join(', ') : (m as string)) || msg
    } catch {}
    if (data.code === 'connection_unavailable') window.dispatchEvent(new CustomEvent('pp:connection-unavailable', { detail: msg }))
    throw new ApiError(res.status, msg, data)
  }
  if (res.status === 204) return undefined as T
  const text = await res.text()
  return (text ? JSON.parse(text) : undefined) as T
}

export const api = {
  get: <T>(url: string, signal?: AbortSignal) => request<T>('GET', url, undefined, signal),
  post: <T>(url: string, body?: unknown, signal?: AbortSignal) => request<T>('POST', url, body, signal),
  put: <T>(url: string, body?: unknown) => request<T>('PUT', url, body),
  patch: <T>(url: string, body?: unknown) => request<T>('PATCH', url, body),
  del: <T>(url: string, body?: unknown) => request<T>('DELETE', url, body),
}

export const V1 = '/api/v1'
/** The person's own Immich, through Photos (it adds their key server-side). */
export const IMMICH = V1 + '/immich'

export const immich = {
  get: <T>(path: string, signal?: AbortSignal) => api.get<T>(IMMICH + path, signal),
  post: <T>(path: string, body?: unknown, signal?: AbortSignal) => api.post<T>(IMMICH + path, body, signal),
  put: <T>(path: string, body?: unknown) => api.put<T>(IMMICH + path, body),
  patch: <T>(path: string, body?: unknown) => api.patch<T>(IMMICH + path, body),
  del: <T>(path: string, body?: unknown) => api.del<T>(IMMICH + path, body),
}

export const qs = (o: Record<string, string | number | boolean | undefined | null>) => {
  const p = new URLSearchParams()
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null && v !== '' && v !== false) p.set(k, String(v))
  const s = p.toString()
  return s ? '?' + s : ''
}

export const isAbort = (e: unknown) => (e as Error)?.name === 'AbortError'

// ---------- clouds: Nextcloud, WebDAV, S3, Google Drive, OneDrive, Dropbox (docs/clouds.md) ----------

const CLOUDS = V1 + '/clouds'
export type CloudFilter = 'all' | 'new' | 'imported' | 'located' | 'unlocated'

export const clouds = {
  providers: (signal?: AbortSignal) => api.get<CloudProvider[]>(`${CLOUDS}/providers`, signal),
  list: (signal?: AbortSignal) => api.get<CloudAccount[]>(CLOUDS, signal),
  create: (body: { kind: string; name: string; root: string; via?: 'core'; fields: Record<string, string> }) => api.post<CloudAccount>(CLOUDS, body),
  update: (id: number, body: { name?: string; root?: string; fields?: Record<string, string> }) => api.put<CloudAccount>(`${CLOUDS}/${id}`, body),
  remove: (id: number) => api.del<void>(`${CLOUDS}/${id}`),
  scan: (id: number) => api.post<CloudAccount>(`${CLOUDS}/${id}/scan`),
  oauthStart: (kind: string, account?: number) => api.get<{ url: string }>(`${CLOUDS}/oauth/${kind}/start` + qs({ json: 1, account })),
  items: (p: { account?: number; cursor?: string | null; limit?: number; filter?: CloudFilter; type?: 'image' | 'video' | ''; q?: string; order?: 'desc' | 'asc' }, signal?: AbortSignal) =>
    api.get<CloudItemsPage>(`${CLOUDS}/items` + qs({ ...p, filter: p.filter === 'all' ? undefined : p.filter }), signal),
  item: (id: number, signal?: AbortSignal) => api.get<CloudItem>(`${CLOUDS}/items/${id}`, signal),
  importItem: (id: number) => api.post<{ status: 'imported' | 'duplicate'; asset_id?: string }>(`${CLOUDS}/items/${id}/import`),
  map: (account?: number, signal?: AbortSignal) => api.get<CloudMarker[]>(`${CLOUDS}/map` + qs({ account }), signal),
}
export const cloudThumb = (id: number) => `${CLOUDS}/items/${id}/thumb`
export const cloudPreview = (id: number) => `${CLOUDS}/items/${id}/preview`
export const cloudOriginal = (id: number) => `${CLOUDS}/items/${id}/original`
