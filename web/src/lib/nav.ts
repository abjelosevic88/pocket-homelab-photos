// The sections of the app: sidebar entries, palette commands, titles.
export type GalleryView = 'library' | 'favorites' | 'videos' | 'recent' | 'archive' | 'trash' | 'search' | 'album' | 'person' | 'place'

export interface NavItem { to: string; label: string; icon: string; key?: string }

export const LIBRARY_NAV: NavItem[] = [
  { to: '/', label: 'All photos', icon: 'image', key: 'h' },
  { to: '/favorites', label: 'Favorites', icon: 'heart', key: 'f' },
  { to: '/videos', label: 'Videos', icon: 'video', key: 'v' },
  { to: '/memories', label: 'Memories', icon: 'sparkle', key: 'm' },
  { to: '/albums', label: 'Albums', icon: 'album', key: 'a' },
  { to: '/people', label: 'People', icon: 'users', key: 'p' },
  { to: '/places', label: 'Places', icon: 'pin', key: 'o' },
  { to: '/sharing', label: 'Sharing', icon: 'link', key: 's' },
]

export const MORE_NAV: NavItem[] = [
  { to: '/recent', label: 'Recently added', icon: 'clock' },
  { to: '/archive', label: 'Archive', icon: 'archive' },
  { to: '/trash', label: 'Recently deleted', icon: 'trash', key: 't' },
]

export const SOURCES = [
  { id: 'files', label: 'Pocket Files', icon: 'folder', desc: 'Your home folder, shared folders and mounted storage.' },
  { id: 'documents', label: 'Pocket Documents', icon: 'file', desc: 'Images and scanned photos in your document archive.' },
] as const
export type SourceId = (typeof SOURCES)[number]['id']

export const SECTION_TITLE: Record<string, string> = {
  '': 'All photos', favorites: 'Favorites', videos: 'Videos', memories: 'Memories', albums: 'Albums', people: 'People',
  places: 'Places', sharing: 'Sharing', recent: 'Recently added', archive: 'Archive', trash: 'Recently deleted', search: 'Search', sources: 'Sources',
}
