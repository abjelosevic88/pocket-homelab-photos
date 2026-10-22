# Clouds

Photos can index the pictures and videos that live in other clouds — Nextcloud, any WebDAV server, an
S3-compatible bucket, Google Drive, OneDrive and Dropbox — without copying them. Each person connects their
own accounts; nobody else, admins included, can see them. Photos walks the account, reads each photo's date,
camera and GPS position straight from the file (a few kilobytes with range requests, never the whole file
when the cloud offers its own metadata), keeps a small thumbnail, and names the place through your Immich
server's reverse geocoder. You review everything in Photos, see it on the Places map next to your Immich
library, and import only what you pick. The cloud is never written to.

## Providers

| Kind | Sign-in | Metadata | Thumbnails |
| --- | --- | --- | --- |
| `nextcloud` | Pocket Core (your Nextcloud login there), or address + user + app password | EXIF via range reads | Nextcloud previews (HEIC too) |
| `webdav` | address + user + password | EXIF via range reads | made by Photos (JPEG/PNG/GIF/WebP) |
| `s3` | endpoint, region, bucket, prefix, access key, secret | EXIF via range reads | made by Photos |
| `gdrive` | OAuth, `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Drive's image metadata | Drive thumbnails |
| `onedrive` | OAuth, `MICROSOFT_CLIENT_ID` / `MICROSOFT_CLIENT_SECRET` | Graph photo + location facets | Graph thumbnails |
| `dropbox` | OAuth, `DROPBOX_APP_KEY` / `DROPBOX_APP_SECRET` | EXIF via range reads | Dropbox thumbnails (HEIC too) |

OAuth redirect URI for all three: `BASE_URL/api/v1/clouds/oauth/<kind>/callback`. Scopes are read-only
(`drive.readonly`; `Files.Read offline_access User.Read`; Dropbox `files.metadata.read files.content.read`).

## API

All routes need a signed-in person and only ever see that person's accounts; another person's ids answer 404.

| Route | |
| --- | --- |
| `GET /api/v1/clouds/providers` | `[{kind, name, auth: "form"\|"oauth"\|"core", configured, fields: [{key, label, secret?, placeholder?, help?, optional?}], help}]` |
| `GET /api/v1/clouds` | `[Account]` |
| `POST /api/v1/clouds` | form kinds: `{kind, name, root, via?: "core", fields: {…}}` → `Account` (connection probed first; scan starts) |
| `GET /api/v1/clouds/oauth/{kind}/start?json=1[&account=ID]` | `{url}` to send the browser to; `account` reconnects |
| `GET /api/v1/clouds/oauth/{kind}/callback` | provider redirect; answers a redirect to `/settings?tab=sources&cloud=ID` or `&error=…` |
| `PUT /api/v1/clouds/{id}` | `{name?, root?, fields?}` → `Account` |
| `DELETE /api/v1/clouds/{id}` | forgets the account, its index and thumbnails; the cloud is untouched |
| `POST /api/v1/clouds/{id}/scan` | starts a rescan → `Account` (202) |
| `GET /api/v1/clouds/items` | `?account=&cursor=&limit=&filter=all\|new\|imported\|located\|unlocated&type=image\|video&q=&order=desc\|asc` → `{items: [Item], next_cursor, total}` |
| `GET /api/v1/clouds/items/{id}` | `Item` |
| `GET /api/v1/clouds/items/{id}/thumb` | JPEG, about 360 px (404 when the cloud has none for that format) |
| `GET /api/v1/clouds/items/{id}/preview` | a browser-safe image up to about 2048 px (the original when it is already web-safe) |
| `GET /api/v1/clouds/items/{id}/original` | the original file, streamed (Range supported) |
| `POST /api/v1/clouds/items/{id}/import` | copies the original into the person's Immich → `{status: "imported"\|"duplicate", asset_id}` |
| `GET /api/v1/clouds/map[?account=]` | `[{id, lat, lon, account_id, city?, country?}]` for every located item |

```ts
type Account = {
  id: number; kind: 'nextcloud' | 'webdav' | 's3' | 'gdrive' | 'onedrive' | 'dropbox'
  name: string; root: string; via?: 'core' | ''; login?: string   // the account's user/email, never a secret
  status: 'idle' | 'scanning' | 'error' | 'reconnect'; error?: string
  last_scan_at?: string; next_scan_at?: string
  scan?: { seen: number; indexed: number }                          // while scanning
  counts: { items: number; photos: number; videos: number; located: number; imported: number }
  created_at: string
}
type Item = {
  id: number; account_id: number; name: string; path: string; mime: string; size: number
  taken_at?: string; modified_at?: string; width?: number; height?: number
  lat?: number; lon?: number; city?: string; country?: string; camera?: string
  video: boolean; duration_ms?: number
  imported_asset_id?: string; import_status?: '' | 'imported' | 'duplicate'
  has_thumb: boolean; web_url?: string
}
```

Accounts rescan by themselves every `CLOUD_SCAN_INTERVAL` (6 hours); unchanged files (same etag, size and time) are not
read again, and OneDrive and Dropbox only report what changed since the last scan. Two accounts are scanned at a time,
four files per account at once.

**Nextcloud** goes through Pocket Core when the box has one: Photos asks Core for the Nextcloud login Core keeps for the
person (the same one Calendar, Notes and Contacts use), so nothing is typed in. Without Core — or if Core has no
Nextcloud login for you — connect directly with the Nextcloud address, your user name and an app password.

**Google Photos** cannot be indexed: since 2025 Google's API only lets apps see photos they uploaded themselves, or
ones you hand over in a picker each time. Export them with Google Takeout into Pocket Files instead.

**What is read.** For Drive and OneDrive the date, camera and position come from the cloud's own metadata. Everything
else is read from the file: EXIF from JPEG, HEIC/HEIF/AVIF, TIFF and DNG/RAW, and the QuickTime/MP4 creation time,
duration and location (including Apple's `com.apple.quicktime.location.ISO6709`). The reads are range requests of
64 KiB blocks — a 300 MB video usually takes two or three. Servers without range support are read whole only up to
64 MB.

**Thumbnails** come from the cloud when it renders them (Nextcloud previews, Drive, OneDrive and Dropbox cover HEIC
and RAW); otherwise Photos renders JPEG, PNG, GIF and WebP itself, upright according to EXIF. They are cached in
`DATA_DIR/cloud-thumbs`. HEIC on a plain WebDAV server or in an S3 bucket has no thumbnail; it can still be opened
and imported.

**Place names** come from your Immich server's reverse geocoder (`/map/reverse-geocode`, the `map.search`
permission), cached per square kilometre — no outside service is asked.
