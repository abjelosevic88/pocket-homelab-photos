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
  if (p === '/immich/search/metadata' || p === '/immich/search/smart') {
    const f = body?.filter || {}
    let items = assets.filter(a => (f.trashedAt && 'ne' in f.trashedAt ? a.isTrashed : !a.isTrashed))
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
  await page.goto(base + '/albums')
  await page.locator('.card-tile').first().waitFor()
  await shot(page, 'albums.png')
  await page.goto(base + '/')
  await page.locator('.tile').first().waitFor()

  // viewer: details, description, favorite, next, close
  const first = assets.find(a => a.type === 'IMAGE' && !a.isFavorite)
  await openTile(first)
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

  // zoom: double-click keeps the spot under the cursor, drag pans without opening gaps, ctrl+wheel and keys zoom,
  // Escape first returns to fit, a second double-click fits again
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
  let g0 = await geom()
  const px = g0.c.left + g0.c.width * 0.25, py = g0.c.top + g0.c.height * 0.3
  const frac = g => [(px - g.r.left) / g.r.width, (py - g.r.top) / g.r.height]
  const f0 = frac(g0)
  await page.mouse.dblclick(px, py)
  await page.locator('.viewer-stage.zoomed').waitFor()
  await settleZoom()
  let g1 = await geom()
  assert.ok(g1.r.width > g0.r.width * 1.4, 'double-click zooms in')
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
  // double-click in, double-click out
  await page.mouse.dblclick(px, py); await page.locator('.viewer-stage.zoomed').waitFor(); await settleZoom()
  await page.mouse.dblclick(px, py); await settleZoom()
  assert.equal(await page.locator('.viewer-stage.zoomed').count(), 0, 'second double-click fits again')
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
  await page.locator('.map-pin').first().press('Enter')
  await page.locator('.place-pick').waitFor()
  await shot(page, 'places.png')
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

  assert.deepEqual(errors, [])
  console.log(`PASS: ${photos.length}-photo library, viewer details/description/favorite/navigation, portrait fit, zoom to the pointer + pan + keys + ctrl-wheel, add to album, protected sharing link, palette search, albums/people/memories/places/sharing, Files + Documents imports, upload tray, theme from Settings, five widths with the phone drawer.`)
} finally {
  await context.close()
  if (!process.env.CDP) await browser.close()
}
// a CDP connection keeps Node alive; the shared browser itself stays up
process.exit(process.exitCode ?? 0)
