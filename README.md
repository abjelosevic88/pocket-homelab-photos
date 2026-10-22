<p align="center"><img src="web/public/favicon.svg" width="72" alt=""></p>
<h1 align="center">Pocket Photos</h1>
<p align="center">The photos of a household in one private place: a library that feels like Apple Photos or Google Photos, albums, people, memories and places, on top of the Immich server you already run — and the pictures sitting in Pocket Files and Pocket Documents, one tap away from the library.<br>One Go binary, one SQLite file, one volume.</p>

Pocket Photos is the everyday face of an [Immich](https://immich.app) server. Immich keeps doing what it is
good at — storing originals, phone backup, face recognition, smart search — and Pocket Photos gives everyone
on the box a calm, fast app in the same design as the other Pocket apps, signed in with Pocket Core. Each
person brings their own Immich library (an API key, a password, or the credentials Core already holds for
them); nobody — admins included — can browse somebody else's. Photos that ended up in a shared folder or
were scanned into the document archive can be picked and copied into the library without touching the
originals.

<p align="center"><img src="docs/screenshots/library.png" width="900" alt="All photos grouped by month: autumn in Sarajevo, a trip to Norway"></p>

<table>
  <tr>
    <td width="50%"><img src="docs/screenshots/viewer.png" alt="The viewer with the details panel: date, camera, place and rating"></td>
    <td width="50%"><img src="docs/screenshots/albums.png" alt="Albums: Autumn at home, Norway 2026, Iceland, Summer by the sea, Lisbon, New York at Christmas"></td>
  </tr>
  <tr>
    <td align="center"><sub>Swipe through, read the camera's details, add a description and stars.</sub></td>
    <td align="center"><sub>Albums for the trips and the seasons, shared with a link.</sub></td>
  </tr>
  <tr>
    <td width="50%"><img src="docs/screenshots/places.png" alt="Places: every photo with a location on a built-in world map"></td>
    <td width="50%"><img src="docs/screenshots/sources.png" alt="Picking photos in Pocket Files to import into the library"></td>
  </tr>
  <tr>
    <td align="center"><sub>Every place on a map that ships with the app — no tiles from anyone.</sub></td>
    <td align="center"><sub>Pick photos in Pocket Files or Pocket Documents; the originals stay put.</sub></td>
  </tr>
  <tr>
    <td width="50%"><img src="docs/screenshots/people.png" alt="People recognised by Immich"></td>
    <td width="50%"><img src="docs/screenshots/memories.png" alt="A memory from one year ago today"></td>
  </tr>
  <tr>
    <td align="center"><sub>People Immich recognised, named in place.</sub></td>
    <td align="center"><sub>On this day, a year ago.</sub></td>
  </tr>
</table>

<p align="center">
  <img src="docs/screenshots/phone-library.png" width="240" alt="The library on a phone">&nbsp;&nbsp;
  <img src="docs/screenshots/phone-viewer.png" width="240" alt="The viewer on a phone">&nbsp;&nbsp;
  <img src="docs/screenshots/library-dark.png" width="420" alt="Dark mode">
</p>

All screenshots use the fixture library — real photographs from Unsplash, made-up people and trips.
[How to refresh them](docs/screenshots/README.md).

## What it does

**The library**
- Every photo and video grouped by day, month or year, newest or oldest first, a denser or roomier grid,
  endless scrolling; favorites, videos, recently added, archive and recently deleted with restore.
- Search the way Immich searches: in plain words ("dog on the beach"), by file name or by the text in the
  picture, filtered by type and dates.
- A full-screen viewer with swipe and keys, zoom, slideshow, videos and Live Photos, the camera's details and
  a map; descriptions and star ratings; crop, rotate and mirror without losing the original; download.

**Albums, people, memories, places**
- Create, rename and delete albums, add and remove a selection; deleting an album keeps its photos.
- People recognised by Immich, named in place; *On this day* memories; every photo with a location on a world
  map that ships with the app — no map tiles fetched from anyone.
- Sharing links with an expiry, a password, and download and metadata switches; revoke them any time.

**Getting photos in**
- Upload photos and videos by drag and drop with progress, cancel, retry and duplicate reporting; download a
  selection as a zip.
- Browse your home and shared folders in [Pocket Files](https://github.com/abjelosevic88/pocket-homelab-files)
  and the images in [Pocket Documents](https://github.com/abjelosevic88/pocket-homelab-documents), preview
  them and import the ones you pick. The source files stay where they are; Immich spots duplicates.
- Phone camera backup stays with the Immich mobile app, against the same server.

**With the other Pocket apps** (through [Pocket Core](https://github.com/abjelosevic88/pocket-homelab-core))
- Sign in with Pocket Core, and use the Immich credentials Core already keeps for you.
- Uses only `files:read` and `documents:read`; Core decides per person, and the source app checks folder,
  share and document access on every read.

## Run it

```sh
docker run -d --name pocket-photos -p 8080:8080 -v ./data:/data \
  -e BASE_URL=https://photos.example.com -e TZ=Europe/Berlin \
  -e IMMICH_URL=http://immich-server:2283 -e IMMICH_PUBLIC_URL=https://immich.example.com \
  ghcr.io/abjelosevic88/pocket-homelab-photos:latest
```

Open it, create the first account (or set `ADMIN_EMAIL` / `ADMIN_PASSWORD`) and connect your Immich library
under **Settings → Your photo library**. See [docker-compose.yml](docker-compose.yml),
[configuration](docs/configuration.md) and the [API](docs/api.md). Put it behind HTTPS and set
`SECURE_COOKIES=true`. `IMMICH_PUBLIC_URL` is where sharing links open, so recipients need to reach it.

On a Pocket Box, set `CORE_URL` and `CORE_REGISTRATION_KEY`: the app registers itself, people sign in with
Pocket Core, and Pocket Files and Pocket Documents appear under *Sources* with nothing to configure.

Immich 3.3 is the tested API target (structured search filters and the non-destructive edits API). Immich
remains the system of record for originals, albums, faces, sharing and trash — back it up on its own.
Pocket Photos' `./data` holds only accounts and each person's sealed Immich connection;
`pocket-photos backup` writes a consistent copy of the database.

## Build

```sh
make web build      # React UI into web/dist, then the Go binary that embeds it
make run            # no login, on :8080, against IMMICH_URL (default http://localhost:2283)
make test           # Go tests + type-check the UI
make e2e            # browser suite + screenshots against the fixture library (no Immich needed)
```

Go 1.26, Node 22. Stack: Go (chi, modernc SQLite), React 19 + Vite, no other runtime dependencies.
The fixture library is real photography from Unsplash — [credits](scripts/fixtures/README.md) and
[attribution](docs/attribution.md).

## License

MIT
