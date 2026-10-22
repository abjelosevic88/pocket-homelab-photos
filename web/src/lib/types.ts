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
}

export interface Stats { images: number; videos: number; total: number }
