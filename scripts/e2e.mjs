// Browser regression suite and README screenshots, against a fixture library of real photos
// (scripts/fixtures, Unsplash License — see docs/attribution.md). Every API call is answered
// here; no Immich, Pocket Files or Pocket Documents is contacted.
//
//   cd web && npm run build && npm run preview -- --host 127.0.0.1 --port 18194
//   node scripts/e2e.mjs                              # Playwright's own Chromium
//   CDP=http://127.0.0.1:9222 node scripts/e2e.mjs    # or any Chrome with remote debugging
//   SHOTS=0 node scripts/e2e.mjs                      # checks only, screenshots untouched
import { createRequire } from 'node:module'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'

const require = createRequire(new URL('../web/package.json', import.meta.url))
const { chromium } = require('playwright')
const root = new URL('./fixtures/', import.meta.url)
const base = process.env.BASE || 'http://127.0.0.1:18194'
const shots = process.env.SHOTS !== '0'
const version = process.env.VERSION || '0.2.0'

// ---------- the fixture library ----------
const photos = JSON.parse(await fs.readFile(new URL('photos.json', root), 'utf8'))
const peopleFx = JSON.parse(await fs.readFile(new URL('people.json', root), 'utf8'))
const cache = new Map()
const read = async rel => { if (!cache.has(rel)) cache.set(rel, await fs.readFile(new URL(rel, root))); return cache.get(rel) }

const uuid = (kind, n) => `${kind}0000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const CAMERAS = [
  { make: 'Apple', model: 'iPhone 15 Pro', lensModel: 'back triple camera 6.765mm f/1.78', fNumber: 1.8, focalLength: 6.8, iso: 64, exposureTime: '1/1250' },
  { make: 'FUJIFILM', model: 'X-T5', lensModel: 'XF16-55mmF2.8 R LM WR', fNumber: 5.6, focalLength: 23, iso: 160, exposureTime: '1/500' },
  { make: 'SONY', model: 'ILCE-7M4', lensModel: 'FE 24-70mm F2.8 GM II', fNumber: 8, focalLength: 35, iso: 100, exposureTime: '1/320' },
]
const people = peopleFx.map((p, i) => ({ id: uuid('b', i + 1), name: p.name, slug: p.slug, birthDate: null, isHidden: false }))
const wall = t => t.slice(0, 19) + '.000Z' // the local time it was taken, as Immich's localDateTime
let assets = photos
  .slice()
  .sort((a, b) => wall(b.takenAt).localeCompare(wall(a.takenAt)))
  .map((p, i) => ({
    id: uuid('a', i + 1),
    file: p.file,
    type: p.video ? 'VIDEO' : 'IMAGE',
    duration: p.video ? p.duration : '0:00:00.00000',
    originalFileName: (p.video ? 'MVI_' : 'IMG_') + (4100 + i * 7) + (p.video ? '.MOV' : '.JPG'),
    fileCreatedAt: new Date(p.takenAt).toISOString(),
    localDateTime: wall(p.takenAt),
    createdAt: new Date(Date.parse(p.takenAt) + 36e5).toISOString(),
    isFavorite: !!p.favorite,
    isTrashed: false,
    visibility: 'timeline',
    width: p.width * 4,
    height: p.height * 4,
    thumbhash: null,
    livePhotoVideoId: null,
    people: p.people.map(n => people.find(x => x.name === n)).filter(Boolean).map(({ id, name }) => ({ id, name })),
    albums: [...p.albums],
    exifInfo: {
      description: p.title, city: p.city, state: null, country: p.country, latitude: p.lat, longitude: p.lon,
      fileSizeInByte: 2_400_000 + i * 131_071, exifImageWidth: p.width * 4, exifImageHeight: p.height * 4, rating: null,
      ...CAMERAS[i % CAMERAS.length],
    },
  }))
let albums = [...new Set(photos.flatMap(p => p.albums))].map((name, i) => ({ id: uuid('c', i + 1), albumName: name, description: '', shared: name === 'Norway 2026' }))
const albumDto = a => {
  const list = assets.filter(x => !x.isTrashed && x.albums.includes(a.albumName))
  const dates = list.map(x => x.localDateTime).sort()
  return { ...a, assetCount: list.length, albumThumbnailAssetId: list[0]?.id ?? null, startDate: dates[0], endDate: dates.at(-1) }
}
let shares = [{ id: uuid('d', 1), key: 'k7Hq2vNw9', slug: null, type: 'ALBUM', description: 'Norway, for the family', password: null, expiresAt: new Date(Date.now() + 20 * 864e5).toISOString(), allowDownload: true, showMetadata: false }]
const today = new Date()
const md = today.toISOString().slice(5, 10)
const memoryAssets = assets.filter(a => a.localDateTime.slice(5, 10) === md && a.localDateTime.slice(0, 4) < String(today.getFullYear()))
const dto = a => { const { file, albums: _a, createdAt: _c, ...rest } = a; return rest }

const pick = (file, i) => { const p = photos.find(x => x.file === file); return p && { name: p.title + '.jpg', path: '/' + file, file, mime: 'image/jpeg', size: 2_100_000 + i * 310_000, modified: p.takenAt } }
const sourceFiles = [
  { name: 'Phone backup', path: '/Phone backup', is_dir: true },
  { name: 'Scans', path: '/Scans', is_dir: true },
  ...photos.filter(p => !p.video).slice(-8).map((p, i) => pick(p.file, i)),
]
const documents = photos.filter(p => !p.video).slice(0, 2).map((p, i) => ({ id: 41 + i, title: ['Grandma’s garden, 1987', 'Wedding day, 1992'][i], original_name: `scan-00${41 + i}.jpg`, file: p.file, mime: 'image/jpeg', size: 940_000 + i * 270_000, created: ['1987-06-14', '1992-09-05'][i] }))

// ---------- clouds: a Nextcloud (through Pocket Core) and a Google Drive, indexed in place ----------
const PLACES = [
  ['Vienna', 'Austria', 48.2082, 16.3738], ['Budapest', 'Hungary', 47.4979, 19.0402], ['Ljubljana', 'Slovenia', 46.0569, 14.5058],
  ['Dubrovnik', 'Croatia', 42.6507, 18.0944], ['Mostar', 'Bosnia and Herzegovina', 43.3438, 17.8078], ['Rome', 'Italy', 41.9028, 12.4964],
  ['Prague', 'Czechia', 50.0755, 14.4378], ['Athens', 'Greece', 37.9838, 23.7275],
]
const OTHER_CLOUD = 9 // someone else's account: always 404
const ago = h => new Date(Date.now() - h * 36e5).toISOString()
let cloudAccounts = [
  { id: 1, kind: 'nextcloud', name: 'Nextcloud', root: '/Photos', via: 'core', login: 'ana', status: 'idle', last_scan_at: ago(2), created_at: ago(400) },
  { id: 2, kind: 'gdrive', name: 'Ana’s Drive', root: '', via: '', login: 'ana@example.com', status: 'idle', last_scan_at: ago(5), created_at: ago(300) },
]
const stills = photos.filter(p => !p.video)
let cloudItems = [
  ...stills.slice(0, 14).map((p, i) => ({ account_id: 1, p, i, folder: '/Photos/Archive' })),
  ...stills.slice(14, 22).map((p, i) => ({ account_id: 2, p, i: i + 14, folder: '/Camera uploads' })),
].map(({ account_id, p, i, folder }) => {
  const place = i % 4 === 3 ? null : PLACES[i % PLACES.length]
  const taken = new Date(Date.parse(p.takenAt) - (account_id === 1 ? 2 : 1) * 365 * 864e5).toISOString()
  return {
    id: 501 + i, account_id, file: p.file, name: `IMG_${2200 + i * 3}.JPG`, path: `${folder}/${taken.slice(0, 4)}/IMG_${2200 + i * 3}.JPG`, mime: 'image/jpeg',
    size: 3_100_000 + i * 97_000, taken_at: i % 7 === 6 ? undefined : taken, modified_at: taken, width: p.width * 4, height: p.height * 4,
    ...(place ? { lat: place[2] + (i % 3) * 0.004, lon: place[3] - (i % 2) * 0.003, city: place[0], country: place[1] } : {}),
    camera: CAMERAS[i % CAMERAS.length].make + ' ' + CAMERAS[i % CAMERAS.length].model, video: false,
    import_status: account_id === 1 && [2, 5, 9].includes(i) ? 'imported' : '', imported_asset_id: account_id === 1 && [2, 5, 9].includes(i) ? uuid('e', 9) : undefined,
    has_thumb: true, ...(account_id === 2 ? { web_url: 'https://drive.google.com/file/d/fixture' + i + '/view' } : {}),
  }
})
// A cloud video uses a JPEG poster even when its provider cannot preview the original.
Object.assign(cloudItems[13], { video: true, mime: 'video/mp4', name: 'Cloud video.mp4', duration_ms: 12000 })
const cloudPublic = i => { const { file, ...rest } = i; return rest }
const cloudDto = a => {
  const list = cloudItems.filter(i => i.account_id === a.id)
  return { ...a, counts: { items: list.length, photos: list.filter(i => !i.video).length, videos: list.filter(i => i.video).length, located: list.filter(i => i.lat != null).length, imported: list.filter(i => i.import_status).length } }
}
let cloudPolls = 0
const CLOUD_PROVIDERS = [
  { kind: 'nextcloud', name: 'Nextcloud', auth: 'core', configured: true, fields: [{ key: 'url', label: 'Nextcloud address', placeholder: 'https://cloud.example.com' }, { key: 'username', label: 'User name' }, { key: 'password', label: 'App password', secret: true, help: 'Nextcloud → Settings → Security → Devices & sessions' }] },
  { kind: 'webdav', name: 'WebDAV', auth: 'form', configured: true, fields: [{ key: 'url', label: 'Address', placeholder: 'https://dav.example.com/photos' }, { key: 'username', label: 'User name' }, { key: 'password', label: 'Password', secret: true }] },
  { kind: 's3', name: 'S3 bucket', auth: 'form', configured: true, fields: [{ key: 'endpoint', label: 'Endpoint', placeholder: 'https://s3.eu-central-003.backblazeb2.com' }, { key: 'region', label: 'Region', optional: true }, { key: 'bucket', label: 'Bucket' }, { key: 'access_key', label: 'Access key' }, { key: 'secret_key', label: 'Secret key', secret: true }] },
  { kind: 'gdrive', name: 'Google Drive', auth: 'oauth', configured: true, fields: [] },
  { kind: 'onedrive', name: 'OneDrive', auth: 'oauth', configured: false, fields: [], help: 'Not set up on this box yet: an admin sets MICROSOFT_CLIENT_ID and MICROSOFT_CLIENT_SECRET.', setup: { console: 'https://entra.microsoft.com/', console_name: 'Microsoft Entra admin center', redirect_uri: 'https://photos.example.com/api/v1/clouds/oauth/onedrive/callback', env: ['MICROSOFT_CLIENT_ID', 'MICROSOFT_CLIENT_SECRET'], steps: ['New registration.', 'Add the redirect URI.', 'Create a client secret.', 'Set the ID and secret.'] } },
  { kind: 'dropbox', name: 'Dropbox', auth: 'oauth', configured: false, fields: [], help: 'Not set up on this box yet: an admin sets DROPBOX_APP_KEY and DROPBOX_APP_SECRET.' },
]

const calls = []
const errors = []

// ---------- the API ----------
async function handle(route) {
  const req = route.request()
  const u = new URL(req.url())
  const p = u.pathname.replace('/api/v1', '')
  const method = req.method()
  let body
  try { body = req.postDataJSON() } catch {}
  calls.push({ p, method, body })
  const json = (data, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) })
  const image = async rel => route.fulfill({ status: 200, contentType: 'image/jpeg', body: await read(rel) })
  const none = () => route.fulfill({ status: 404, contentType: 'application/json', body: '{"message":"Not found"}' })
  const byId = id => assets.find(a => a.id === id)
  let m

  // images
  if ((m = /^\/immich\/assets\/([\w-]+)\/(thumbnail|original)$/.exec(p))) { const a = byId(m[1]); return a ? image('photos/' + a.file) : none() }
  if ((m = /^\/immich\/people\/([\w-]+)\/thumbnail$/.exec(p))) { const x = people.find(y => y.id === m[1]); return x ? image(`faces/${x.slug}.jpg`) : none() }
  if (/\/video\/playback$/.test(p)) return none()
  if (p === '/sources/files/fs/thumb' || p === '/sources/files/fs/raw') { const f = sourceFiles.find(x => x.path === u.searchParams.get('path')); return f?.file ? image('photos/' + f.file) : none() }
  if ((m = /^\/sources\/documents\/documents\/(\d+)\/(thumb|download)$/.exec(p))) { const d = documents.find(x => x.id === +m[1]); return d ? image('photos/' + d.file) : none() }

  // Photos itself
  if (p === '/auth/status') return json({ needs_setup: false, auth_mode: 'local', authenticated: true, version, title: 'Pocket Photos', core_configured: true, oidc: true, oidc_name: 'Pocket Core', user: { id: 1, name: 'Ana Petrović', email: 'ana@example.com', username: 'ana', role: 'admin' } })
  if (p === '/connection') return json({ connected: true, via: 'core', core: true, public_url: 'https://immich.example.com', server_configured: true, user: { name: 'Ana Petrović', email: 'ana@example.com', quotaSizeInBytes: 500 * 1024 ** 3, quotaUsageInBytes: 86.4 * 1024 ** 3 } })
  if (p === '/client-error') return json({})

  // Immich
  if (p === '/immich/assets/statistics') { const live = assets.filter(a => !a.isTrashed && a.visibility === 'timeline'); return json({ images: live.filter(a => a.type === 'IMAGE').length, videos: live.filter(a => a.type === 'VIDEO').length, total: live.length }) }
  if (p === '/immich/timeline/buckets') {
    const buckets = new Map()
    for (const a of assets.filter(a => !a.isTrashed && a.visibility === 'timeline')) {
      const timeBucket = a.localDateTime.slice(0, 7) + '-01T00:00:00.000Z'
      buckets.set(timeBucket, (buckets.get(timeBucket) || 0) + 1)
    }
    return json([...buckets].map(([timeBucket, count]) => ({ timeBucket, count })).sort((a, b) => b.timeBucket.localeCompare(a.timeBucket)))
  }
  if (p === '/immich/search/metadata' || p === '/immich/search/smart') {
    // Immich rejects legacy page pagination when structured filters are present.
    if (p === '/immich/search/smart' && body?.filter && 'page' in body) return json({ message: 'Deprecated field page cannot be combined with filter' }, 400)
    const f = body?.filter || {}
    let items = assets.filter(a => (f.trashedAt && 'ne' in f.trashedAt ? a.isTrashed : !a.isTrashed))
    if (f.takenAt?.lt) items = items.filter(a => a.fileCreatedAt < f.takenAt.lt)
    if (f.takenAt?.gte) items = items.filter(a => a.fileCreatedAt >= f.takenAt.gte)
    if (f.takenAt?.lte) items = items.filter(a => a.fileCreatedAt <= f.takenAt.lte)
    if (f.visibility) items = items.filter(a => a.visibility === f.visibility.eq)
    if (f.isFavorite) items = items.filter(a => a.isFavorite === f.isFavorite.eq)
    if (f.type) items = items.filter(a => a.type === f.type.eq)
    if (f.albumIds) { const al = albums.find(x => x.id === f.albumIds.any[0]); items = items.filter(a => al && a.albums.includes(al.albumName)) }
    if (f.personIds) items = items.filter(a => a.people.some(x => f.personIds.any.includes(x.id)))
    if (f.city) items = items.filter(a => a.exifInfo.city === f.city.eq)
    if (f.originalFileName) { const s = f.originalFileName.like.replaceAll('%', '').toLowerCase(); items = items.filter(a => a.originalFileName.toLowerCase().includes(s)) }
    if (p.endsWith('/smart')) {
      const words = String(body.query || '').toLowerCase().split(/\s+/).filter(Boolean)
      items = items.filter(a => words.some(w => `${a.exifInfo.description} ${a.exifInfo.city} ${a.exifInfo.country} ${a.albums.join(' ')}`.toLowerCase().includes(w)))
    } else {
      const field = body?.orderBy?.field === 'createdAt' ? 'createdAt' : 'localDateTime'
      items = items.slice().sort((a, b) => (body?.orderBy?.direction === 'asc' ? 1 : -1) * a[field].localeCompare(b[field]))
    }
    return json({ assets: { items: items.map(dto), nextCursor: null, nextPage: null, total: items.length }, albums: { items: [] } })
  }
  if (/^\/immich\/assets\/[\w-]+\/edits$/.test(p)) return json({ edits: [] })
  if ((m = /^\/immich\/assets\/([\w-]+)$/.exec(p))) {
    const a = byId(m[1])
    if (!a) return none()
    if (method === 'PUT') {
      if (body.description !== undefined) a.exifInfo.description = body.description
      if (body.rating !== undefined) a.exifInfo.rating = body.rating
      for (const k of ['isFavorite', 'visibility']) if (body[k] !== undefined) a[k] = body[k]
    }
    return json(dto(a))
  }
  if (p === '/immich/assets' && method === 'POST') return json({ id: uuid('e', 1), status: 'created' }, 201)
  if (p === '/immich/assets' && body?.ids) {
    for (const a of assets.filter(x => body.ids.includes(x.id))) {
      if (method === 'DELETE') { if (body.force) assets = assets.filter(x => x !== a); else a.isTrashed = true }
      else for (const k of ['isFavorite', 'visibility']) if (body[k] !== undefined) a[k] = body[k]
    }
    return route.fulfill({ status: 204 })
  }
  if (p === '/immich/trash/restore/assets') { assets.filter(a => body.ids.includes(a.id)).forEach(a => { a.isTrashed = false }); return json({ count: body.ids.length }) }
  if (p === '/immich/download/archive') return route.fulfill({ status: 200, contentType: 'application/zip', body: Buffer.from('PK\x05\x06' + '\0'.repeat(18), 'binary') })
  if (p === '/immich/albums' && method === 'POST') {
    const a = { id: uuid('c', albums.length + 1), albumName: body.albumName, description: body.description || '', shared: false }
    albums.push(a)
    for (const x of assets.filter(y => (body.assetIds || []).includes(y.id))) x.albums.push(a.albumName)
    return json(albumDto(a), 201)
  }
  if (p === '/immich/albums') return json(albums.map(albumDto))
  if ((m = /^\/immich\/albums\/([\w-]+)\/assets$/.exec(p))) {
    const al = albums.find(x => x.id === m[1])
    for (const x of assets.filter(y => body.ids.includes(y.id))) x.albums = method === 'PUT' ? [...new Set([...x.albums, al.albumName])] : x.albums.filter(n => n !== al.albumName)
    return json(body.ids.map(id => ({ id, success: true })))
  }
  if ((m = /^\/immich\/albums\/([\w-]+)$/.exec(p))) {
    const al = albums.find(x => x.id === m[1])
    if (!al) return none()
    if (method === 'DELETE') { albums = albums.filter(x => x !== al); return route.fulfill({ status: 204 }) }
    if (method === 'PATCH') { for (const x of assets) x.albums = x.albums.map(n => (n === al.albumName ? body.albumName : n)); al.albumName = body.albumName }
    return json(albumDto(al))
  }
  if (p === '/immich/people') return json({ people: people.map(({ slug, ...x }) => x), hasNextPage: false, total: people.length, hidden: 0 })
  if ((m = /^\/immich\/people\/([\w-]+)$/.exec(p))) {
    const x = people.find(y => y.id === m[1])
    if (!x) return none()
    if (method === 'PUT') { x.name = body.name; for (const a of assets) for (const q of a.people) if (q.id === x.id) q.name = body.name }
    const { slug, ...rest } = x
    return json(rest)
  }
  if (p === '/immich/memories') return json(memoryAssets.length ? [{ id: uuid('f', 1), type: 'on_this_day', memoryAt: today.toISOString(), data: { year: Number(memoryAssets[0].localDateTime.slice(0, 4)) }, assets: memoryAssets.map(dto) }] : [])
  if (p === '/immich/map/markers') return json(assets.filter(a => !a.isTrashed).map(a => ({ id: a.id, lat: a.exifInfo.latitude, lon: a.exifInfo.longitude, city: a.exifInfo.city, state: null, country: a.exifInfo.country })))
  if (p === '/immich/shared-links') {
    if (method === 'POST') { const s = { id: uuid('d', shares.length + 1), key: 'fixture' + shares.length, slug: null, ...body }; shares.push(s); return json(s, 201) }
    return json(shares.map(s => (s.type === 'ALBUM' ? { ...s, album: albumDto(albums.find(a => a.albumName === 'Norway 2026') || albums[0]) } : { ...s, assets: assets.filter(a => (s.assetIds || []).includes(a.id)).map(dto) })))
  }
  if ((m = /^\/immich\/shared-links\/([\w-]+)$/.exec(p))) { shares = shares.filter(s => s.id !== m[1]); return route.fulfill({ status: 204 }) }

  // clouds (docs/clouds.md)
  if ((m = /^\/clouds\/items\/(\d+)\/(thumb|preview|original)$/.exec(p))) { const i = cloudItems.find(x => x.id === +m[1]); return i ? image('photos/' + i.file) : none() }
  if (p === '/clouds/providers') return json(CLOUD_PROVIDERS)
  if (p === '/clouds' && method === 'GET') {
    // a scan finishes after a couple of polls
    for (const a of cloudAccounts) if (a.status === 'scanning' && ++cloudPolls > 2) { a.status = 'idle'; a.scan = undefined; a.last_scan_at = new Date().toISOString(); cloudPolls = 0 }
    return json(cloudAccounts.map(cloudDto))
  }
  if (p === '/clouds' && method === 'POST') {
    if (body.via === 'core') return json({ error: 'Pocket Core has no Nextcloud login for you yet — add it in Core, or connect directly' }, 400)
    const a = { id: 10 + cloudAccounts.length, kind: body.kind, name: body.name, root: body.root || '', via: '', login: body.fields?.username || '', status: 'scanning', scan: { seen: 0, indexed: 0 }, created_at: new Date().toISOString() }
    cloudAccounts.push(a)
    return json(cloudDto(a), 201)
  }
  if ((m = /^\/clouds\/oauth\/(\w+)\/start$/.exec(p))) return json({ url: base + '/settings?tab=sources&cloud=2' }) // where the callback sends the browser back
  if ((m = /^\/clouds\/(\d+)(\/scan)?$/.exec(p))) {
    const a = cloudAccounts.find(x => x.id === +m[1])
    if (!a) return json({ error: 'not found' }, 404)
    if (m[2]) { a.status = 'scanning'; a.scan = { seen: 1200, indexed: 860 }; cloudPolls = 0; return json(cloudDto(a), 202) }
    if (method === 'DELETE') { cloudAccounts = cloudAccounts.filter(x => x !== a); cloudItems = cloudItems.filter(i => i.account_id !== a.id); return route.fulfill({ status: 204 }) }
    if (method === 'PUT') Object.assign(a, { name: body.name ?? a.name, root: body.root ?? a.root })
    return json(cloudDto(a))
  }
  if (p === '/clouds/items' || p === '/clouds/timeline') {
    const q = u.searchParams, acc = Number(q.get('account') || 0)
    if (acc && !cloudAccounts.some(a => a.id === acc)) return json({ error: 'not found' }, 404)
    let list = cloudItems.filter(i => !acc || i.account_id === acc)
    const f = q.get('filter') || 'all'
    if (f === 'new') list = list.filter(i => !i.import_status)
    if (f === 'imported') list = list.filter(i => i.import_status)
    if (f === 'located') list = list.filter(i => i.lat != null)
    if (f === 'unlocated') list = list.filter(i => i.lat == null)
    if (q.get('type') === 'video') list = list.filter(i => i.video)
    if (q.get('type') === 'image') list = list.filter(i => !i.video)
    const s = (q.get('q') || '').toLowerCase()
    if (s) list = list.filter(i => `${i.name} ${i.path} ${i.city || ''} ${i.country || ''}`.toLowerCase().includes(s))
    if (p === '/clouds/timeline') {
      const buckets = new Map()
      for (const i of list) { const month = (i.taken_at || i.modified_at).slice(0, 7); buckets.set(month, (buckets.get(month) || 0) + 1) }
      return json([...buckets].sort(([a], [b]) => b.localeCompare(a)).map(([timeBucket, count]) => ({ timeBucket, count })))
    }
    const date = q.get('date')
    if (date) list = list.filter(i => (i.taken_at || i.modified_at).slice(0, date.length) <= date)
    list = list.slice().sort((a, b) => (b.taken_at || b.modified_at).localeCompare(a.taken_at || a.modified_at))
    const from = Number(q.get('cursor') || 0), size = Math.min(Number(q.get('limit') || 100), 6) // the fixture server pages by 6
    return json({ items: list.slice(from, from + size).map(cloudPublic), next_cursor: from + size < list.length ? String(from + size) : null, total: list.length })
  }
  if ((m = /^\/clouds\/items\/(\d+)\/import$/.exec(p))) {
    const i = cloudItems.find(x => x.id === +m[1])
    if (!i) return none()
    const status = i.import_status ? 'duplicate' : 'imported'
    i.import_status = status; i.imported_asset_id = uuid('e', 3)
    return json({ status, asset_id: i.imported_asset_id })
  }
  if ((m = /^\/clouds\/items\/(\d+)$/.exec(p))) { const i = cloudItems.find(x => x.id === +m[1]); return i ? json(cloudPublic(i)) : none() }
  if (p === '/clouds/map') {
    const acc = Number(u.searchParams.get('account') || 0)
    return json(cloudItems.filter(i => i.lat != null && (!acc || i.account_id === acc)).map(i => ({ id: i.id, lat: i.lat, lon: i.lon, account_id: i.account_id, city: i.city, country: i.country })))
  }

  // Pocket Files and Pocket Documents, through Core
  if (p === '/sources/files/spaces') return json([{ id: 'home', name: 'My files' }, { id: 'mount:media', name: 'Family media' }])
  if (p === '/sources/files/fs/list' || p === '/sources/files/fs/search') return json({ entries: (u.searchParams.get('path') || '/') === '/' ? sourceFiles.map(({ file, ...f }) => f) : [] })
  if (p === '/sources/documents/documents') return json({ count: documents.length, results: documents.map(({ file, ...d }) => d) })
  if (p.endsWith('/import')) return json({ id: uuid('e', 2), status: 'created' })
  return json({})
}

// ---------- the run ----------
const browser = process.env.CDP ? await chromium.connectOverCDP(process.env.CDP) : await chromium.launch({ headless: true })
const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: 1, colorScheme: 'light', timezoneId: 'Europe/Sarajevo' })
await context.route('**/api/v1/**', handle)
// Exercise the shared launcher with a test Core frame capturing the photo handoff.
const askWidget = await fs.readFile(new URL('../third_party/pocket-core/sdk/ask-widget.js', import.meta.url), 'utf8')
await context.route('**/pocket-ask.js', route => route.fulfill({ contentType: 'application/javascript', body: '(()=>{const config={app:"photos",core:"https://core.photos.test"};' + askWidget + '})();' }))
await context.route('https://core.photos.test/ask*', route => route.fulfill({ contentType: 'text/html', body: `<html><body><textarea aria-label="Your question"></textarea><script>
const origin=JSON.parse(decodeURIComponent(location.hash.slice(1))).origin;
window.addEventListener('message',e=>{if(e.source===parent&&e.origin===origin&&e.data.type==='pocket-ask-context'){window.received=e.data;document.querySelector('textarea').value=e.data.prompt||'';}});
parent.postMessage({type:'pocket-ask-ready'},origin);
</script></body></html>` }))

// Headless Chrome in a container rarely has the system UI fonts the app asks for and falls back to
// a face without bold; Open Sans (in zenika/alpine-chrome) is the closest stand-in for the screenshots.
await context.addInitScript(() => {
  // the README shows the library by month; the app's own default is by day
  if (!localStorage.getItem('pp-grouping')) localStorage.setItem('pp-grouping', 'month')
})
await context.addInitScript(() => document.addEventListener('DOMContentLoaded', () => {
  const s = document.createElement('style')
  s.textContent = ':root { --font: "Inter", -apple-system, "Segoe UI", Roboto, "Open Sans", Arial, sans-serif; }'
  document.head.appendChild(s)
}))
const out = new URL('../docs/screenshots/', import.meta.url)
await fs.mkdir(out, { recursive: true })
/** Wait until every image on screen has loaded. */
const settle = page => page.waitForFunction(() => [...document.images].filter(i => { const r = i.getBoundingClientRect(); return r.bottom > 0 && r.top < innerHeight && r.width > 0 }).every(i => i.complete && i.naturalWidth > 0), null, { timeout: 10000 }).catch(() => {})
const shot = async (page, name) => { if (!shots) return; await settle(page); await page.waitForTimeout(400); await page.screenshot({ path: new URL(name, out).pathname }) }

try {
  const page = await context.newPage()
  page.setDefaultTimeout(8000)
  page.on('pageerror', e => errors.push(e.message))
  const btn = name => page.getByRole('button', { name, exact: true })
  const openTile = async a => { await page.locator('.tile-open').nth(assets.filter(x => !x.isTrashed).indexOf(a)).click(); await page.locator('.viewer').waitFor() }

  // library and the shared shell
  await page.goto(base + '/')
  await page.locator('.tile').first().waitFor()
  assert.equal(await page.locator('.tile').count(), photos.length)
  assert.match(await page.locator('.sb-title').innerText(), /Pocket\s*Photos/)
  assert.equal(await page.locator('.sb-version').innerText(), 'v' + version)
  assert.equal(await page.locator('.topbar [aria-label="Settings"]').count(), 0, 'no settings gear in the top bar')
  await shot(page, 'library.png')
  // The timeline covers the full library and jumps directly to old dates.
  await page.locator('.timeline-year-jump').first().waitFor()
  const railLayout = await page.evaluate(() => {
    const rail = document.querySelector('.photo-timeline').getBoundingClientRect()
    return { right: rail.right, bottom: rail.bottom, width: innerWidth, height: innerHeight,
      nested: !!document.querySelector('.content .photo-timeline'),
      photosScrollbar: getComputedStyle(document.querySelector('.content')).scrollbarWidth,
      datesScrollbar: getComputedStyle(document.querySelector('.timeline-years')).scrollbarWidth }
  })
  assert.equal(railLayout.nested, false, 'timeline sits outside the photo scroller')
  assert.equal(railLayout.right, railLayout.width, 'timeline is flush with the right edge')
  assert.equal(railLayout.bottom, railLayout.height, 'timeline fills the available height')
  assert.equal(railLayout.photosScrollbar, 'none')
  assert.equal(railLayout.datesScrollbar, 'none')

  const years = [...new Set(assets.map(a => a.localDateTime.slice(0, 4)))].sort().reverse()
  assert.equal(await page.locator('.timeline-year-jump').count(), years.length)
  const oldYear = years.at(-1)
  // A slow date request must not unmount the grid, collapse the page or move the rail.
  let releaseDate, dateStarted
  const blockedDate = new Promise(resolve => { releaseDate = resolve })
  const dateRequest = new Promise(resolve => { dateStarted = resolve })
  const holdDate = async route => {
    if (route.request().postDataJSON()?.filter?.takenAt) { dateStarted(); await blockedDate }
    await route.fallback()
  }
  await page.route('**/immich/search/metadata', holdDate)
  await page.locator('.content').evaluate(el => { el.scrollTop = 260 })
  await page.waitForTimeout(100)
  const beforeDate = await page.evaluate(() => {
    window.keptPhotoGrid = document.querySelector('.photo-groups')
    return { scroll: document.querySelector('.content').scrollTop, rail: document.querySelector('.photo-timeline').getBoundingClientRect().top }
  })
  await page.getByRole('button', { name: new RegExp(`^Jump to ${oldYear},`) }).click()
  await dateRequest
  await page.waitForTimeout(150)
  assert.equal(await page.locator('.tile').count(), photos.length, 'keep current photos visible while dates load')
  assert.equal(await page.evaluate(() => window.keptPhotoGrid === document.querySelector('.photo-groups')), true, 'keep the existing grid mounted')
  assert.equal(await page.locator('.gallery-results').getAttribute('aria-busy'), 'true')
  const duringDate = await page.evaluate(() => ({ scroll: document.querySelector('.content').scrollTop, rail: document.querySelector('.photo-timeline').getBoundingClientRect().top }))
  assert.ok(Math.abs(duringDate.scroll - beforeDate.scroll) < 2, 'defer scrolling until the replacement is ready')
  assert.ok(Math.abs(duringDate.rail - beforeDate.rail) < 2, 'timeline does not jump during loading')
  releaseDate()

  await page.waitForURL(u => u.searchParams.get('date') === oldYear)
  await page.waitForFunction(year => [...document.querySelectorAll('[data-photo-month]')].length > 0 && [...document.querySelectorAll('[data-photo-month]')].every(el => el.dataset.photoMonth.slice(0, 4) <= year), oldYear)
  await page.unroute('**/immich/search/metadata', holdDate)
  assert.equal(await page.locator('.content').evaluate(el => el.scrollTop), 0)
  await page.locator(`#timeline-${oldYear} .timeline-month`).first().click()
  await page.waitForURL(u => /^\d{4}-\d{2}$/.test(u.searchParams.get('date') || ''))
  await page.getByRole('button', { name: 'Latest', exact: true }).click()
  await page.waitForURL(u => !u.searchParams.has('date'))
  await page.waitForFunction(n => document.querySelectorAll('.tile').length === n, photos.length)

  await page.goto(base + '/albums')
  await page.locator('.card-tile').first().waitFor()
  await shot(page, 'albums.png')
  await page.goto(base + '/')
  await page.locator('.tile').first().waitFor()

  const askPhoto = async expectedPath => {
    const title = await page.locator('.viewer-title b').innerText()
    const before = calls.filter(c => c.method === 'POST' && c.p.includes('ask')).length
    await btn('Ask AI about this photo').click()
    const frame = page.frameLocator('pocket-ask-launcher iframe')
    await frame.getByLabel('Your question').waitFor()
    await page.waitForFunction(() => document.querySelector('pocket-ask-launcher')?.hasAttribute('open'))
    const child = page.frames().find(f => f.url().startsWith('https://core.photos.test/ask'))
    await child.waitForFunction(() => !!window.received?.source.image)
    const data = await child.evaluate(() => window.received)
    assert.equal(data.source.app, 'photos')
    assert.ok(new URL(data.source.url).pathname.includes(expectedPath))
    assert.ok(data.source.image.data_url.startsWith('data:image/jpeg;base64,'))
    assert.ok(data.source.image.data_url.length > 1000 && data.source.image.data_url.length < 2800000)
    assert.equal(await frame.getByLabel('Your question').inputValue(), 'Describe this photo and explain any visible text.')
    assert.equal(calls.filter(c => c.method === 'POST' && c.p.includes('ask')).length, before, 'opening Ask never sends a question')
    await page.getByRole('button', { name: 'Close Pocket Ask', exact: true }).focus()
    await page.keyboard.press('ArrowRight')
    assert.equal(await page.locator('.viewer-title b').innerText(), title, 'Ask captures navigation keys')
    await page.keyboard.press('Escape')
    assert.equal(await page.locator('.viewer').count(), 1, 'Escape closes Ask without closing the photo')
    await page.waitForFunction(() => !document.querySelector('pocket-ask-launcher')?.hasAttribute('open'))
    assert.equal(await page.locator('pocket-ask-launcher').getAttribute('open'), null)
  }

  // viewer: details, description, favorite, next, close
  const first = assets.find(a => a.type === 'IMAGE' && !a.isFavorite)
  await openTile(first)
  await askPhoto('/immich/assets/' + first.id + '/thumbnail')
  if (!(await page.locator('.viewer-info').isVisible())) await btn('Show photo information').click()
  await page.getByLabel('Description', { exact: true }).fill('A wonderful walk')
  await btn('Save description').click()
  await btn('Add to favorites').click()
  await page.waitForTimeout(200)
  assert.equal(first.isFavorite, true)
  assert.equal(first.exifInfo.description, 'A wonderful walk')
  await page.keyboard.press('ArrowRight')
  await page.locator('.viewer-title small').filter({ hasText: `${assets.indexOf(first) + 2} of` }).waitFor()
  await btn('Close viewer').click()
  first.exifInfo.description = photos.find(p => p.file === first.file).title
  first.isFavorite = false

  // a portrait photo fits the stage instead of filling it (and the Ask launcher stays out of the way)
  const tall = assets.find(a => a.type === 'IMAGE' && a.height > a.width)
  await openTile(tall)
  await page.locator('.viewer-stage img').evaluate(i => i.decode())
  const fit = await page.evaluate(() => {
    const s = document.querySelector('.viewer-stage').getBoundingClientRect(), i = document.querySelector('.viewer-stage img').getBoundingClientRect()
    return { s: [s.top, s.bottom, s.left, s.right], i: [i.top, i.bottom, i.left, i.right], ask: getComputedStyle(document.querySelector('pocket-ask-launcher') || document.body).display }
  })
  assert.ok(fit.i[0] >= fit.s[0] - 1 && fit.i[1] <= fit.s[1] + 1 && fit.i[2] >= fit.s[2] - 1 && fit.i[3] <= fit.s[3] + 1, `portrait photo overflows the viewer: ${JSON.stringify(fit)}`)
  await btn('Close viewer').click()

  // zoom: one click keeps the spot under the cursor, drag pans without opening gaps, ctrl+wheel and keys zoom,
  // Escape first returns to fit, another click fits again
  const wide = assets.find(a => a.type === 'IMAGE' && a.width > a.height)
  await openTile(wide)
  if (await page.locator('.viewer-info').isVisible()) await btn('Show photo information').click()
  const img = page.locator('.viewer-stage img')
  await img.evaluate(i => i.decode())
  const geom = () => page.evaluate(() => {
    const st = document.querySelector('.viewer-stage').getBoundingClientRect(), im = document.querySelector('.viewer-stage img')
    const r = im.getBoundingClientRect(), ar = im.naturalWidth / im.naturalHeight
    const cw = Math.min(r.width, r.height * ar), ch = cw / ar
    const c = { left: r.left + (r.width - cw) / 2, top: r.top + (r.height - ch) / 2, width: cw, height: ch }
    return { st: { left: st.left, top: st.top, right: st.right, bottom: st.bottom }, r: { left: r.left, top: r.top, width: r.width, height: r.height }, c, t: im.style.transform }
  })
  const settleZoom = () => page.waitForTimeout(400)
  await settleZoom() // settle the details-panel resize before measuring/clicking
  let g0 = await geom()
  const px = g0.c.left + g0.c.width * 0.25, py = g0.c.top + g0.c.height * 0.3
  const frac = g => [(px - g.r.left) / g.r.width, (py - g.r.top) / g.r.height]
  const f0 = frac(g0)
  await page.mouse.click(px, py)
  await page.locator('.viewer-stage.zoomed').waitFor()
  await settleZoom()
  let g1 = await geom()
  assert.ok(g1.r.width > g0.r.width * 1.4, 'one click zooms in')
  const f1 = frac(g1)
  assert.ok(Math.abs(f1[0] - f0[0]) < 0.01 && Math.abs(f1[1] - f0[1]) < 0.01, `the clicked spot stays under the cursor: ${f0} → ${f1}`)
  await page.locator('.zoom-pct').waitFor()
  // pan far to the right: the photo's left edge stops at the stage's left edge
  await page.mouse.move(px, py); await page.mouse.down(); await page.mouse.move(px + 3000, py + 3000, { steps: 8 }); await page.mouse.up()
  let g2 = await geom()
  const covers = (g, a, b, lo, hi) => g.c[b] > g.st[hi] - g.st[lo] + 1 ? g.c[a] <= g.st[lo] + 1 && g.c[a] + g.c[b] >= g.st[hi] - 1 : true
  assert.ok(covers(g2, 'left', 'width', 'left', 'right') && covers(g2, 'top', 'height', 'top', 'bottom'), `no gap after panning: ${JSON.stringify(g2)}`)
  assert.ok(Math.abs(g2.c.left - g2.st.left) < 2, 'panned to the left edge')
  // Escape fits instead of closing
  await page.keyboard.press('Escape')
  await settleZoom()
  assert.equal(await page.locator('.viewer-stage.zoomed').count(), 0)
  assert.equal(await page.locator('.viewer').count(), 1, 'Escape while zoomed keeps the viewer open')
  // keys and ctrl+wheel
  await page.keyboard.press('+'); await page.locator('.viewer-stage.zoomed').waitFor(); await settleZoom()
  const sKey = (await geom()).r.width
  await page.mouse.move(g0.c.left + g0.c.width / 2, g0.c.top + g0.c.height / 2)
  await page.keyboard.down('Control'); await page.mouse.wheel(0, -200); await page.keyboard.up('Control')
  await page.waitForTimeout(100)
  assert.ok((await geom()).r.width > sKey * 1.2, 'ctrl+wheel zooms in')
  await page.keyboard.press('0'); await settleZoom()
  assert.equal(await page.locator('.viewer-stage.zoomed').count(), 0)
  // One click in, one click out; double-clicking must not undo the first click.
  await page.mouse.click(px, py); await page.locator('.viewer-stage.zoomed').waitFor(); await settleZoom()
  await page.mouse.click(px, py); await settleZoom()
  assert.equal(await page.locator('.viewer-stage.zoomed').count(), 0, 'second click fits again')
  await page.mouse.dblclick(px, py); await settleZoom()
  assert.equal(await page.locator('.viewer-stage.zoomed').count(), 1, 'double-click keeps the first zoom')
  await btn('Fit photo').click(); await settleZoom()
  assert.equal(await page.locator('.viewer-stage.zoomed').count(), 0, 'zoom control does not also toggle the stage')
  // Real touch events: a tap zooms, a drag pans, and lifting pinch fingers is not a tap.
  const touchSession = await page.context().newCDPSession(page)
  const touch = (type, points) => touchSession.send('Input.dispatchTouchEvent', { type, touchPoints: points.map(([id, x, y]) => ({ id, x, y })) })
  await touch('touchStart', [[1, px, py]]); await touch('touchEnd', []); await settleZoom()
  assert.equal(await page.locator('.viewer-stage.zoomed').count(), 1, 'single tap zooms')
  await touch('touchStart', [[1, px, py]]); await touch('touchEnd', []); await settleZoom()
  assert.equal(await page.locator('.viewer-stage.zoomed').count(), 0, 'another tap fits')
  await touch('touchStart', [[1, px, py], [2, px + 100, py]])
  await touch('touchMove', [[1, px - 30, py], [2, px + 160, py]])
  await touch('touchEnd', [[2, px + 160, py]])
  await touch('touchEnd', []); await settleZoom()
  assert.equal(await page.locator('.viewer-stage.zoomed').count(), 1, 'pinch release preserves zoom')
  await touchSession.detach()
  await page.keyboard.press('0'); await settleZoom()

  g0 = await geom()
  await btn('Close viewer').click()

  // the viewer screenshot: a Norway photo with its details
  const hero = assets.find(a => a.albums.includes('Norway 2026') && a.type === 'IMAGE') || assets[0]
  await page.goto(base + '/')
  await page.locator('.tile').first().waitFor()
  await openTile(hero)
  if (!(await page.locator('.viewer-info').isVisible())) await btn('Show photo information').click()
  await shot(page, 'viewer.png')
  await btn('Close viewer').click()

  // select → add to an album
  await btn('Select').click()
  await page.locator('.tile-check').nth(1).click()
  await page.locator('.tile-check').nth(2).click()
  await btn('Add to album').click()
  const added = page.waitForRequest(r => /\/albums\/[\w-]+\/assets$/.test(new URL(r.url()).pathname) && r.method() === 'PUT')
  await btn('Lisbon').click()
  await added
  assert.ok(calls.some(c => /\/albums\/[\w-]+\/assets$/.test(c.p) && c.method === 'PUT' && c.body.ids.length === 2))

  // select → share with a password
  await btn('Select').click()
  await page.locator('.tile-check').first().click()
  await btn('Share selected photos').click()
  await page.getByLabel('Password (optional)').fill('test-only-password')
  await btn('Create link').click()
  await page.getByLabel('Share link').waitFor()
  const made = shares.at(-1)
  assert.equal(made.showMetadata, false)
  assert.equal(made.password, 'test-only-password')
  assert.ok(made.expiresAt)
  await btn('Done').click()

  // search from the palette
  await page.keyboard.press('Escape')
  await page.keyboard.press('/')
  await page.getByLabel('Search photos').fill('beach')
  // wait for the request itself: the previous grid's tiles are still on screen right after navigating
  const searched = page.waitForRequest(r => r.url().includes('/immich/search/smart') && r.postDataJSON()?.query === 'beach')
  await page.keyboard.press('Enter')
  await page.waitForURL(/\/search\?q=beach/)
  await searched
  await page.locator('.tile').first().waitFor()
  assert.ok(calls.some(c => c.p === '/immich/search/smart' && c.body.query === 'beach'))
  assert.ok(calls.filter(c => c.p === '/immich/search/smart').every(c => !('page' in c.body)), 'smart search uses structured filters without deprecated pagination')

  // albums, people, memories, places, sharing
  await page.goto(base + '/albums')
  await page.locator('.card-tile').first().waitFor()
  assert.equal(await page.locator('.card-tile').count(), albums.length)
  await page.locator('.card-tile').filter({ hasText: 'Iceland' }).click()
  await page.locator('.crumb-cur').filter({ hasText: 'Iceland' }).waitFor()
  await page.locator('.tile').first().waitFor()
  assert.equal(await page.locator('.tile').count(), photos.filter(p => p.albums.includes('Iceland')).length)
  await page.goto(base + '/people')
  await page.locator('.person').first().waitFor()
  assert.equal(await page.locator('.person').count(), people.length)
  await shot(page, 'people.png')
  await page.goto(base + '/memories')
  if (memoryAssets.length) { await page.locator('.memory').first().waitFor(); await shot(page, 'memories.png') }
  await page.goto(base + '/places')
  await page.locator('.map-pin').first().waitFor()
  // the library's own places first; the clouds' photos come back on below
  const cloudChip = page.getByRole('button', { name: 'Clouds', exact: true })
  await cloudChip.waitFor()
  if ((await cloudChip.getAttribute('aria-pressed')) === 'true') await cloudChip.click()
  await page.waitForFunction(() => !document.querySelector('.map-pin.cloud'))
  const map = page.locator('.photo-map')
  const fitted = await map.getAttribute('viewBox')
  await page.getByRole('button', { name: 'Zoom in', exact: true }).click()
  assert.ok(Number((await map.getAttribute('viewBox')).split(' ')[2]) < Number(fitted.split(' ')[2]))
  await page.getByRole('button', { name: 'Fit photos', exact: true }).click()
  assert.equal(await map.getAttribute('viewBox'), fitted)
  const rect = await map.boundingBox()
  await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2)
  await page.mouse.wheel(0, -250)
  await page.waitForTimeout(150)
  assert.notEqual(await map.getAttribute('viewBox'), fitted)
  const beforePan = await map.getAttribute('viewBox')
  await page.mouse.down()
  await page.mouse.move(rect.x + rect.width / 2 + 70, rect.y + rect.height / 2 + 30, { steps: 8 })
  await page.mouse.up()
  assert.notEqual(await map.getAttribute('viewBox'), beforePan)
  await page.getByRole('button', { name: 'Fit photos', exact: true }).click()
  const totalOnMap = await page.locator('.map-count').evaluateAll(nodes => nodes.reduce((sum, n) => sum + Number(n.textContent.replaceAll(',', '')), 0))
  assert.equal(totalOnMap, assets.filter(a => !a.isTrashed && a.exifInfo.latitude != null).length)
  await page.locator('.map-pin').first().press('Enter')
  await page.locator('.place-pick').waitFor()
  await shot(page, 'places.png')
  await page.getByRole('button', { name: 'View photos', exact: true }).click()
  await page.locator('.viewer').waitFor()
  await btn('Close viewer').click()
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(base + '/')
  await page.getByRole('button', { name: 'Timeline', exact: true }).click()
  await page.locator('.photo-timeline.mobile-open').waitFor()
  await page.getByRole('button', { name: 'Close timeline', exact: true }).click()
  assert.equal(await page.locator('.photo-timeline').isVisible(), false)
  await page.setViewportSize({ width: 1440, height: 960 })

  await page.goto(base + '/sharing')
  await page.locator('.share-row').first().waitFor()
  assert.equal(await page.locator('.share-row').count(), shares.length)

  // imports from Pocket Files and Pocket Documents
  await page.goto(base + '/sources/files')
  await page.locator('.source-item').first().waitFor()
  for (const i of [0, 1, 3]) await page.locator('.source-check input').nth(i).check()
  await shot(page, 'sources.png')
  await btn('Import to library').click()
  await page.locator('.import-row').nth(2).waitFor()
  await page.locator('.import-bar').waitFor({ state: 'detached' })
  assert.equal(calls.filter(c => c.p === '/sources/files/import').length, 3)
  await page.getByRole('tab', { name: /Pocket Documents/ }).click()
  await page.locator('.source-item').first().waitFor()
  await page.locator('.source-check input').first().check()
  await btn('Import to library').click()
  await page.locator('.import-bar').waitFor({ state: 'detached' })
  assert.ok(calls.some(c => c.p === '/sources/documents/import' && c.body.id === documents[0].id))

  // clouds: cards next to the apps, a review page with filters and endless scroll, import, the lightbox, the map
  const ncItems = cloudItems.filter(i => i.account_id === 1)
  assert.ok(await page.getByRole('tab', { name: /Ana’s Drive/ }).isVisible(), 'cloud accounts sit next to the apps')
  assert.ok(await page.getByRole('button', { name: /Add a cloud/ }).isVisible())
  assert.ok(await page.locator('.sidebar .cal-name').filter({ hasText: 'Ana’s Drive' }).isVisible(), 'clouds are listed in the sidebar')
  const waitCloudCount = async count => page.waitForFunction(n => {
    if (document.querySelectorAll('.cloud-tile').length === n) return true
    const content = document.querySelector('.content')
    if (content) content.scrollTop = content.scrollHeight
    return false
  }, count)
  const pages0 = calls.filter(c => c.p === '/clouds/items').length
  await page.getByRole('tab', { name: /^Nextcloud/ }).click()
  await page.waitForURL(/\/sources\/cloud\/1$/)
  await waitCloudCount(ncItems.length)
  assert.ok(calls.filter(c => c.p === '/clouds/items').length - pages0 >= 3, 'endless scroll fetched the following pages')
  assert.equal(await page.locator('.cloud-tile.in-library').count(), ncItems.filter(i => i.import_status).length)
  assert.equal(await page.locator('.cloud-tile .tile-pin').count(), ncItems.filter(i => i.lat != null).length)
  // The cloud rail aggregates all pages and jumps directly to dates in this account.
  const cloudTimeline = page.locator('.photo-timeline')
  await cloudTimeline.locator('.timeline-year-jump').first().waitFor()
  assert.equal(await cloudTimeline.locator('.timeline-heading > span').textContent(), String(ncItems.length))
  const cloudOldMonth = ncItems.map(i => (i.taken_at || i.modified_at).slice(0, 7)).sort()[0]
  const cloudOldYear = cloudOldMonth.slice(0, 4)
  await cloudTimeline.getByRole('button', { name: new RegExp(`^Jump to ${cloudOldYear},`) }).click()
  await page.waitForURL(u => u.searchParams.get('date') === cloudOldYear)
  const cloudMonthName = new Date(Number(cloudOldYear), Number(cloudOldMonth.slice(5)) - 1, 1).toLocaleDateString('en', { month: 'long' })
  await cloudTimeline.getByRole('button', { name: new RegExp(`^Jump to ${cloudMonthName} ${cloudOldYear},`) }).click()
  await page.waitForURL(u => u.searchParams.get('date') === cloudOldMonth)
  await page.waitForFunction(month => document.querySelector('[data-cloud-month]')?.getAttribute('data-cloud-month') === month, cloudOldMonth)
  await cloudTimeline.getByRole('button', { name: 'Latest', exact: true }).click()
  await page.waitForURL(u => !u.searchParams.has('date'))
  await waitCloudCount(ncItems.length)
  await page.locator('.content').evaluate(el => el.scrollTo({ top: 0, behavior: 'instant' }))
  await page.screenshot({ path: '/tmp/pocket-cloud-timeline-desktop.png' })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole('button', { name: 'Timeline', exact: true }).click()
  assert.ok(await page.locator('.photo-timeline.mobile-open').isVisible())
  await page.screenshot({ path: '/tmp/pocket-cloud-timeline-mobile.png' })
  await page.getByRole('button', { name: 'Close timeline', exact: true }).click()
  await page.setViewportSize({ width: 1440, height: 960 })
  for (const x of await page.locator('.toast-x').all()) await x.click().catch(() => {})
  await page.waitForFunction(() => !document.querySelector('.toasts .toast-x'))
  await page.mouse.move(5, 300) // no hover state on a tile
  await shot(page, 'clouds.png')
  const filtered = page.waitForRequest(r => r.url().includes('/clouds/items') && new URL(r.url()).searchParams.get('filter') === 'new')
  await page.getByRole('radio', { name: 'Not in library', exact: true }).click()
  await filtered
  await waitCloudCount(ncItems.filter(i => !i.import_status).length)
  assert.equal(await page.locator('.cloud-tile.in-library').count(), 0)
  await page.waitForFunction(n => document.querySelector('.photo-timeline .timeline-heading > span')?.textContent === String(n), ncItems.filter(i => !i.import_status).length)
  await page.getByRole('radio', { name: 'With location', exact: true }).click()
  await waitCloudCount(ncItems.filter(i => i.lat != null).length)
  await page.getByRole('radio', { name: 'All', exact: true }).click()
  await waitCloudCount(ncItems.length)
  // Video tiles load real image previews and the player reuses the cached poster.
  const cloudVideo = ncItems.find(i => i.video)
  const videoTile = page.getByRole('button', { name: `Open ${cloudVideo.name}`, exact: true })
  await videoTile.scrollIntoViewIfNeeded()
  await videoTile.locator('img.loaded').waitFor()
  assert.ok(await videoTile.locator('img').evaluate(img => img.naturalWidth > 0))
  await videoTile.click()
  assert.ok((await page.locator('.cloud-viewer video').getAttribute('poster')).endsWith(`/clouds/items/${cloudVideo.id}/thumb`))
  await page.keyboard.press('Escape')
  // A failed preview leaves an icon and filename, never an empty tile.
  const failedTile = page.locator('.cloud-tile').first().locator('.tile-open')
  await failedTile.scrollIntoViewIfNeeded()
  await failedTile.locator('img').evaluate(img => { img.src = 'data:image/jpeg;base64,invalid' })
  await failedTile.locator('img.broken').waitFor({ state: 'attached' })
  assert.equal(await failedTile.locator('img').evaluate(img => getComputedStyle(img).opacity), '0')
  assert.ok(await failedTile.locator('.tile-nothumb small').isVisible())
  // select two that are not in the library yet and import them
  const fresh = page.locator('.cloud-tile:not(.in-library) .tile-check')
  await fresh.nth(0).click(); await fresh.nth(1).click()
  const imports0 = calls.filter(c => /^\/clouds\/items\/\d+\/import$/.test(c.p)).length
  await btn('Import to library').click()
  await page.locator('.import-row').nth(1).waitFor()
  await page.locator('.import-bar').waitFor({ state: 'detached' })
  assert.equal(calls.filter(c => /^\/clouds\/items\/\d+\/import$/.test(c.p)).length - imports0, 2)
  await page.waitForFunction(n => document.querySelectorAll('.cloud-tile.in-library').length === n, ncItems.filter(i => i.import_status).length)
  // the lightbox names the place
  const located = ncItems.find(i => i.lat != null && i.taken_at)
  await page.getByRole('button', { name: `Open ${located.name}`, exact: true }).click()
  await page.locator('.cloud-viewer').waitFor()
  await page.locator('.cloud-viewer .viewer-stage img').evaluate(img => img.decode())
  await settleZoom()
  await page.locator('.cloud-viewer .viewer-stage img').click()
  await page.locator('.cloud-viewer .viewer-stage.zoomed').waitFor(); await settleZoom()
  await page.locator('.cloud-viewer .viewer-stage img').click(); await settleZoom()
  assert.equal(await page.locator('.cloud-viewer .viewer-stage.zoomed').count(), 0, 'cloud photos also toggle on one click')
  await askPhoto('/clouds/items/' + located.id + '/preview')
  await page.setViewportSize({ width: 390, height: 844 })
  await askPhoto('/clouds/items/' + located.id + '/preview')
  assert.ok(await page.locator('.viewer-bar').evaluate(el => el.scrollWidth <= innerWidth), 'photo Ask fits on mobile')
  await page.setViewportSize({ width: 1440, height: 960 })
  if (!(await page.locator('.cloud-viewer .viewer-info').isVisible())) await btn('Show photo information').click()
  await page.locator('.cloud-viewer .viewer-info').getByText(`${located.city}, ${located.country}`, { exact: true }).waitFor()
  assert.ok(await page.locator('.cloud-viewer .mini-map').isVisible(), 'a small map shows where it was taken')
  await page.keyboard.press('ArrowRight')
  await page.locator('.cloud-viewer .viewer-title small').filter({ hasText: /^.* · 2 of|· \d+ of/ }).first().waitFor()
  await page.keyboard.press('Escape')
  await page.locator('.cloud-viewer').waitFor({ state: 'detached' })
  // the account's own map
  await page.getByRole('tab', { name: 'Map', exact: true }).click()
  assert.equal(await page.locator('.photo-timeline').count(), 0, 'cloud map has no timeline rail')
  await page.locator('.map-pin.cloud').first().waitFor()
  await page.getByRole('tab', { name: 'Photos', exact: true }).click()
  // rescan: the status follows the polling until the scan is done
  await btn('Rescan').click()
  await page.locator('.cloud-scan').waitFor()
  cloudPolls = -100 // keep the scan running while exercising its review action
  // Show what's found must escape an empty search and the map, then reveal the grid.
  const cloudSearch = page.getByRole('textbox', { name: 'Search this cloud' })
  await cloudSearch.fill('no-photo-has-this-name')
  await cloudSearch.press('Enter')
  await page.waitForFunction(() => document.querySelector('.cloud-results-start')?.getAttribute('aria-busy') === 'false')
  await page.getByRole('tab', { name: 'Map', exact: true }).click()
  await page.getByRole('button', { name: 'Show what’s found', exact: true }).click()
  await page.locator('.cloud-updated').waitFor()
  assert.equal(await page.getByRole('tab', { name: 'Photos', exact: true }).getAttribute('aria-selected'), 'true')
  assert.equal(await cloudSearch.inputValue(), '')
  assert.ok(await page.locator('.cloud-tile').count() > 0)
  assert.equal(await page.locator('.cloud-results-start').evaluate(el => document.activeElement === el), true)
  await page.waitForFunction(() => {
    const results = document.querySelector('.cloud-results-start').getBoundingClientRect()
    const scroller = document.querySelector('.content')
    const content = scroller.getBoundingClientRect()
    return results.top >= content.top && results.bottom < content.bottom && scroller.scrollTop > 0
  })
  // Clicking again with unchanged data still reports an update, without blanking the grid.
  const unchangedTile = await page.locator('.cloud-tile').first().elementHandle()
  let releaseFound
  const foundGate = new Promise(resolve => { releaseFound = resolve })
  const holdFound = async route => { if (!new URL(route.request().url()).searchParams.get('cursor')) await foundGate; await route.fallback() }
  await page.route('**/api/v1/clouds/items?*', holdFound)
  await page.getByRole('button', { name: 'Show what’s found', exact: true }).click()
  await page.locator('.cloud-scan').getByRole('button', { name: 'Loading…', exact: true }).waitFor()
  assert.equal(await unchangedTile.evaluate(el => el.isConnected), true)
  releaseFound()
  await page.locator('.cloud-updated').waitFor()
  await page.unroute('**/api/v1/clouds/items?*', holdFound)
  // An empty scan still answers the click; failed refreshes remain retryable.
  const noFound = route => route.fulfill({ json: { items: [], total: 0, next_cursor: null } })
  await page.route('**/api/v1/clouds/items?*', noFound)
  await page.getByRole('button', { name: 'Show what’s found', exact: true }).click()
  await page.getByText('Updated · 0 items found so far', { exact: true }).waitFor()
  await page.unroute('**/api/v1/clouds/items?*', noFound)
  const failedFound = route => route.fulfill({ status: 503, json: { error: 'Cloud is temporarily unavailable' } })
  await page.route('**/api/v1/clouds/items?*', failedFound)
  await page.getByRole('button', { name: 'Show what’s found', exact: true }).click()
  await page.getByText('Cloud is temporarily unavailable', { exact: true }).waitFor()
  assert.equal(await page.locator('.cloud-updated').count(), 0, 'failed refresh does not claim success')
  await page.unroute('**/api/v1/clouds/items?*', failedFound)
  await page.getByRole('button', { name: 'Show what’s found', exact: true }).click()
  await page.locator('.cloud-updated').waitFor()
  assert.ok(await page.locator('.cloud-tile').count() > 0)
  cloudPolls = 2
  await page.locator('.cloud-scan').waitFor({ state: 'detached', timeout: 20000 })
  // phones: the review page fits
  await page.setViewportSize({ width: 390, height: 844 })
  await page.waitForTimeout(200)
  assert.equal(await page.locator('.content').evaluate(e => e.scrollWidth > e.clientWidth + 1), false, 'the cloud page overflows at 390px')
  await page.setViewportSize({ width: 1440, height: 960 })
  // someone else's cloud is just "not connected"
  await page.goto(base + `/sources/cloud/${OTHER_CLOUD}`)
  await page.getByText('This cloud isn’t connected').waitFor()

  // settings: the list, adding WebDAV with a form, Nextcloud through Core (refused → direct form), Google Drive by OAuth
  await page.goto(base + '/settings/sources')
  await page.locator('.cloud-row').first().waitFor()
  assert.equal(await page.locator('.cloud-row').count(), cloudAccounts.length)
  assert.ok(await page.locator('.cloud-row').filter({ hasText: 'via Pocket Core' }).isVisible())
  await page.getByRole('button', { name: 'Add a cloud', exact: true }).click()
  await page.locator('.provider').first().waitFor()
  assert.equal(await page.locator('.provider').count(), CLOUD_PROVIDERS.length)
  assert.equal(await page.locator('.provider.needs-setup').count(), CLOUD_PROVIDERS.filter(x => !x.configured).length, 'unconfigured providers say they need setup')
  // a cloud that needs setup opens its steps with a copyable redirect URI, and nothing to connect
  await page.locator('.provider.needs-setup').first().click()
  await page.locator('.copy-box code').filter({ hasText: '/api/v1/clouds/oauth/onedrive/callback' }).waitFor()
  assert.ok((await page.locator('.setup-steps li').count()) >= 3)
  assert.equal(await page.getByRole('button', { name: 'Connect', exact: true }).count(), 0)
  await page.getByRole('button', { name: 'Other clouds' }).click()
  await page.locator('.provider').filter({ hasText: 'WebDAV' }).click()
  await page.getByLabel('Name', { exact: true }).fill('Family NAS')
  await page.getByLabel('Address', { exact: true }).fill('https://nas.example.com/dav/photos')
  await page.getByLabel('User name', { exact: true }).fill('ana')
  await page.getByLabel('Password', { exact: true }).fill('test-only-password')
  await page.getByLabel('Folder (optional)').fill('/Phone')
  const created = page.waitForRequest(r => r.method() === 'POST' && new URL(r.url()).pathname === '/api/v1/clouds')
  await btn('Connect').click()
  const sent = (await created).postDataJSON()
  assert.deepEqual(sent, { kind: 'webdav', name: 'Family NAS', root: '/Phone', fields: { url: 'https://nas.example.com/dav/photos', username: 'ana', password: 'test-only-password' } })
  await page.locator('.cloud-row').filter({ hasText: 'Family NAS' }).waitFor()
  await page.getByRole('button', { name: 'Add a cloud', exact: true }).click()
  await page.locator('.provider').filter({ hasText: 'Nextcloud' }).click()
  await page.locator('.via-core').waitFor()
  assert.equal(await page.getByLabel('App password').count(), 0, 'Pocket Core is the default: nothing to type')
  const viaCore = page.waitForRequest(r => r.method() === 'POST' && new URL(r.url()).pathname === '/api/v1/clouds')
  await btn('Connect').click()
  assert.equal((await viaCore).postDataJSON().via, 'core')
  await page.locator('.add-cloud .callout.danger').filter({ hasText: 'Pocket Core has no Nextcloud login' }).waitFor()
  await page.locator('.add-cloud .callout.danger').getByRole('button', { name: 'Connect directly instead' }).click()
  await page.getByLabel('App password').waitFor()
  await btn('Other clouds').click()
  await page.locator('.provider').filter({ hasText: 'Google Drive' }).click()
  await btn('Continue to Google Drive').click()
  await page.waitForURL(u => u.pathname === '/settings/sources' && !u.searchParams.has('cloud'))
  await page.locator('.toasts').filter({ hasText: 'Connected' }).waitFor()

  // Places: the clouds' photos come back as hollow markers; a cloud place opens the cloud lightbox
  await page.goto(base + '/places')
  await page.locator('.map-pin').first().waitFor()
  await page.getByRole('button', { name: 'Clouds', exact: true }).click()
  await page.locator('.map-pin.cloud').first().waitFor()
  await page.getByRole('button', { name: 'Fit photos', exact: true }).click()
  await page.locator('.map-pin.cloud').first().press('Enter')
  await page.locator('.place-strip button.cloud').first().waitFor()
  await shot(page, 'clouds-map.png')
  await page.locator('.place-strip button.cloud').first().click()
  await page.locator('.cloud-viewer').waitFor()
  await btn('Close viewer').click()

  // upload through the New menu's file input
  await page.goto(base + '/')
  await page.locator('.tile').first().waitFor()
  await page.locator('input[type=file]').setInputFiles({ name: 'fixture.jpg', mimeType: 'image/jpeg', buffer: await read('photos/' + photos[0].file) })
  await page.locator('.upload-item small').filter({ hasText: 'Uploaded' }).waitFor()
  await btn('Close uploads').click()

  // layouts: nothing overflows, the phone drawer reaches the other pages
  for (const width of [1440, 1024, 768, 390, 320]) {
    await page.setViewportSize({ width, height: width < 768 ? 844 : 960 })
    await page.goto(base + '/')
    await page.locator('.tile').first().waitFor()
    await page.waitForTimeout(150)
    assert.equal(await page.locator('.content').evaluate(e => e.scrollWidth > e.clientWidth + 1), false, `content overflows at ${width}px`)
    if (width === 390) await shot(page, 'phone-library.png')
    if (width < 768) {
      assert.ok(await page.locator('.fab').isVisible(), 'phones get the New button')
      await page.getByRole('button', { name: 'Show the sidebar' }).click()
      await page.locator('.sidebar-wrap.open').waitFor()
      await page.locator('.sidebar').getByRole('link', { name: 'Pocket Files' }).click()
      await page.locator('.source-item').first().waitFor()
      assert.equal(await page.locator('.content').evaluate(e => e.scrollWidth > e.clientWidth + 1), false, `sources overflow at ${width}px`)
    }
  }
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(base + '/')
  await page.locator('.tile').first().waitFor()
  await openTile(hero)
  if (await page.locator('.viewer-info').isVisible()) await btn('Show photo information').click()
  await shot(page, 'phone-viewer.png')
  await btn('Close viewer').click()

  // dark, chosen in Settings
  await page.setViewportSize({ width: 1440, height: 960 })
  await page.goto(base + '/settings/appearance')
  await page.locator('.set-page').waitFor()
  await page.getByRole('radio', { name: 'Dark' }).click()
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'dark')
  await page.goto(base + '/')
  await page.locator('.tile').first().waitFor()
  await shot(page, 'library-dark.png')

  // Core revocation updates an already-open tab, without reloading an unchanged grid.
  let revoked = false
  await page.route('**/api/v1/connection', route => revoked
    ? route.fulfill({ json: { connected: false, core: true, server_configured: true, message: 'Immich access disabled in Pocket Core' } })
    : route.fallback())
  const stableTile = await page.locator('.tile').first().elementHandle()
  const refreshed = page.waitForResponse(r => r.url().endsWith('/api/v1/connection'))
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await refreshed
  await page.waitForTimeout(100)
  assert.equal(await stableTile.evaluate(el => el.isConnected), true, 'unchanged status keeps the grid mounted')
  await page.goto(base + '/settings/library')
  await page.getByText('connected through Pocket Core', { exact: false }).waitFor()
  revoked = true
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await page.getByText('Not connected', { exact: true }).waitFor()
  assert.equal(await page.locator('.lib-account').count(), 0, 'revocation clears account details')
  assert.equal(await page.locator('.set-stats').count(), 0, 'revocation clears library counts')
  await page.getByText('Immich access disabled in Pocket Core').waitFor()
  revoked = false
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await page.getByText('Connected', { exact: true }).waitFor()
  await page.goto(base + '/')
  await page.locator('.tile').first().waitFor()
  const denyLibraryRequest = route => route.fulfill({ status: 409, json: { code: 'connection_unavailable', error: 'Immich access disabled in Pocket Core' } })
  await page.route('**/api/v1/immich/search/metadata', denyLibraryRequest)
  await page.locator('.timeline-year-jump').last().click()
  await page.locator('.connect-card').waitFor()
  assert.equal(await page.locator('.tile').count(), 0, 'an access refusal immediately removes the library')
  await page.unroute('**/api/v1/immich/search/metadata', denyLibraryRequest)
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await page.locator('.tile').first().waitFor()
  await page.clock.install()
  await page.goto(base + '/')
  await page.locator('.tile').first().waitFor()
  revoked = true
  await page.clock.fastForward(16000)
  await page.locator('.connect-card').waitFor()
  assert.equal(await page.locator('.tile').count(), 0, 'periodic check removes the revoked library')
  console.log('PASS: Core revocation on focus and while open; account/counts cleared; unchanged checks preserve grid')

  assert.deepEqual(errors, [])
  console.log(`PASS: ${photos.length}-photo library, viewer details/description/favorite/navigation, portrait fit, zoom to the pointer + pan + keys + ctrl-wheel, add to album, protected sharing link, palette search, albums/people/memories/places/sharing, map zoom/pan/counts/viewer, timeline year/month jumps and mobile toggle, Files + Documents imports, clouds (cards, filters + endless scroll, import, lightbox place, account map, rescan polling, add WebDAV / Nextcloud via Core / Drive OAuth, someone else's 404, Places markers), upload tray, theme from Settings, five widths with the phone drawer.`)
} finally {
  await context.close()
  if (!process.env.CDP) await browser.close()
}
// a CDP connection keeps Node alive; the shared browser itself stays up
process.exit(process.exitCode ?? 0)
