export interface User {
  id: number
  email: string
  name: string
  username?: string
  role: 'admin' | 'user'
}

export interface AuthStatus {
  needs_setup: boolean
  auth_mode: 'local' | 'proxy' | 'none'
  authenticated: boolean
  user: User | null
  version: string
  title?: string
  oidc?: boolean
  oidc_name?: string
  core_configured?: boolean
}

export interface ImmichUser {
  name?: string
  email?: string
  quotaSizeInBytes?: number | null
  quotaUsageInBytes?: number | null
}

/** GET /connection: whose Immich this person reaches, and how. */
export interface Connection {
  connected: boolean
  via?: 'core' | 'direct'
  core?: boolean
  public_url?: string
  server_configured?: boolean
  message?: string
  user?: ImmichUser
}

export interface Exif {
  description?: string
  city?: string | null
  state?: string | null
  country?: string | null
  latitude?: number | null
  longitude?: number | null
  fileSizeInByte?: number
  make?: string | null
  model?: string | null
  lensModel?: string | null
  fNumber?: number | null
  exposureTime?: string | null
  iso?: number | null
  focalLength?: number | null
  exifImageWidth?: number | null
  exifImageHeight?: number | null
  rating?: number | null
}

export interface Asset {
  id: string
  type: 'IMAGE' | 'VIDEO' | string
  originalFileName: string
  originalMimeType?: string
  fileCreatedAt: string
  localDateTime?: string
  isFavorite: boolean
  isTrashed: boolean
  visibility: string
  duration?: string | number | null
  isEdited?: boolean
  width?: number | null
  height?: number | null
  livePhotoVideoId?: string | null
  exifInfo?: Exif
  people?: { id: string; name: string }[]
  thumbhash?: string | null
}

export interface Album {
  id: string
  albumName: string
  description?: string
  assetCount: number
  albumThumbnailAssetId: string | null
  shared?: boolean
  startDate?: string
  endDate?: string
}

export interface Person {
  id: string
  name: string
  birthDate?: string | null
  isHidden?: boolean
}

export interface Memory {
  id: string
  memoryAt: string
  data?: { year?: number; title?: string }
  assets: Asset[]
}

export interface SharedLink {
  id: string
  key: string
  slug?: string | null
  type: 'ALBUM' | 'INDIVIDUAL'
  description?: string | null
  password?: string | null
  expiresAt: string | null
  allowDownload: boolean
  showMetadata: boolean
  album?: Album
  assets?: Asset[]
}

export interface MapMarker {
  id: string
  lat: number
  lon: number
  city: string | null
  state?: string | null
  country: string | null
  /** A photo in a cloud rather than in Immich: its thumbnail, drawn with a hollow ring. */
  cloud?: boolean
  src?: string
}

export interface Stats { images: number; videos: number; total: number }

// ---------- clouds (docs/clouds.md) ----------
export type CloudKind = 'nextcloud' | 'webdav' | 's3' | 'gdrive' | 'onedrive' | 'dropbox'

export interface CloudField { key: string; label: string; secret?: boolean; placeholder?: string; help?: string; optional?: boolean }

/** GET /clouds/providers: what can be connected on this box, and how. */
export interface CloudProvider {
  kind: CloudKind
  name: string
  auth: 'form' | 'oauth' | 'core'
  configured: boolean
  fields: CloudField[]
  help?: string
  setup?: { console: string; console_name: string; steps: string[]; redirect_uri: string; env: string[] } | null
}

export interface CloudCounts { items: number; photos: number; videos: number; located: number; imported: number }

export interface CloudAccount {
  id: number
  kind: CloudKind
  name: string
  root: string
  via?: 'core' | ''
  login?: string
  status: 'idle' | 'scanning' | 'error' | 'reconnect'
  error?: string
  last_scan_at?: string
  next_scan_at?: string
  scan?: { seen: number; indexed: number }
  counts: CloudCounts
  created_at: string
}

export interface CloudItem {
  id: number
  account_id: number
  name: string
  path: string
  mime: string
  size: number
  taken_at?: string
  modified_at?: string
  width?: number
  height?: number
  lat?: number
  lon?: number
  city?: string
  country?: string
  camera?: string
  video: boolean
  duration_ms?: number
  imported_asset_id?: string
  import_status?: '' | 'imported' | 'duplicate'
  has_thumb: boolean
  web_url?: string
}

export interface CloudItemsPage { items: CloudItem[]; next_cursor?: string | null; total: number }

/** GET /clouds/map: every located item (city/country are optional extras). */
export interface CloudMarker { id: number; lat: number; lon: number; account_id: number; city?: string; country?: string }
