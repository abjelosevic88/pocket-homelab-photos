# README screenshots and the browser suite

`scripts/e2e.mjs` drives the built UI in Chromium against a fixture library and writes the
screenshots here. Every API call is answered by the script itself — no Immich, Pocket Files,
Pocket Documents or Pocket Core is contacted, and no private photos are involved.

The fixture library is in `scripts/fixtures/`: 32 real photos (`photos/`, 1024 px, Unsplash
License — photographers credited in `scripts/fixtures/README.md`), described by
`photos.json` (title, date, place, people, albums), and four face crops for People
(`faces/`, listed in `people.json`). The signed-in fixture person is Ana Petrović.

```sh
cd web && npm ci && npm run build
npm run preview -- --host 127.0.0.1 --port 18194 &
cd .. && node scripts/e2e.mjs            # uses Playwright's Chromium (npx playwright install chromium)
```

Without a local Chromium, use any Chrome with remote debugging, for example:

```sh
docker run -d --rm --name pp-chrome --network host --shm-size=1g zenika/alpine-chrome:124 \
  --no-sandbox --headless --disable-gpu --disable-dev-shm-usage --hide-scrollbars \
  --remote-debugging-port=19231 --remote-debugging-address=127.0.0.1 --remote-allow-origins='*' about:blank
CDP=http://127.0.0.1:19231 node scripts/e2e.mjs
docker stop pp-chrome
```

`SHOTS=0` runs the checks without touching the screenshots; `VERSION=x.y.z` sets the version
shown in the sidebar.

| File | What it shows |
| --- | --- |
| `library.png` | All photos, grouped by month, at 1440 px |
| `viewer.png` | The viewer with the details panel |
| `albums.png` | Albums |
| `places.png` | Places: the bundled world map with a place picked |
| `sources.png` | Choosing photos in Pocket Files to import |
| `people.png` | People found by Immich |
| `memories.png` | Memories: one year ago today |
| `library-dark.png` | Dark mode |
| `phone-library.png` | The library on a 390 px phone |
| `phone-viewer.png` | The viewer on a phone |
