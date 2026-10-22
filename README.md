# Pocket Photos

Your photos, together. A private photo application for the Pocket homelab, backed by **Immich** and connected to **Pocket Files** and **Pocket Documents**.

Built with the same Go, SQLite, React 19, TypeScript and Vite stack as Pocket Calendar. The interface shares Calendar's design tokens, controls and stroke icons. One binary embeds the web UI; one persistent data directory holds accounts and encrypted connections.

![Pocket Photos with an isolated illustration fixture library](docs/screenshots/library.png)

## What it does

- Browse a date-grouped photo and video library with cursor pagination, sort order, grid density, favorites, recently added, archive and trash.
- Search with Immich's natural-language search, filename or OCR text; filter by media type and date range.
- Open full previews, play videos and Live Photo clips, navigate with keys or swipe, zoom, run a slideshow, view EXIF and location metadata, and download originals.
- Edit descriptions and star ratings; apply non-destructive crop, rotate and mirror operations using Immich's edit API, or revert to the original.
- Create, rename and delete albums; add and remove selected assets. Delete an album without deleting its photos.
- Browse people, name recognized faces, revisit memories, and explore photo locations on a bundled world map that makes no third-party tile requests.
- Create and revoke Immich sharing links with expiry, optional passwords, download controls and metadata controls.
- Upload photos and videos with progress, cancellation, retry and duplicate reporting. Download a selection as a ZIP archive.
- Browse your own and shared storage in Pocket Files, or image originals in Pocket Documents; preview and import selected originals into Immich. The source files stay unchanged. Immich handles duplicate detection.
- Sign in locally or with Pocket Core / OIDC. Each user has their own encrypted Immich connection, or uses the personal service credentials already configured in Core. Other users cannot borrow that connection.
- Use light/dark/system appearance, phone navigation, keyboard shortcuts and a web-app manifest.

## Run

```sh
cp .env.example .env
# Set IMMICH_URL and IMMICH_PUBLIC_URL, and optionally Pocket Core / initial admin settings.
docker compose up -d
```

Open `http://localhost:8080`. Create the first account, then open **Settings → Your photo library**. Connect with your Immich API key or password, or let Pocket Core supply your connection. With Core configured, use **Continue with Pocket Core** for the same sign-in as the other Pocket apps.

Immich 3.3.5 is the tested API target. The library uses the structured search filters introduced in 3.2 and the non-destructive edits API. Older servers may not support all features. API key permissions are enforced by Immich; start with `user.read` plus the permissions for the features you want to use.

For the other sources, Photos declares only `files:read` and `documents:read` in Pocket Core. The app never asks for write permission to those sources. Both the Core link and the person's access to the target app must be enabled.

## Develop and verify

```sh
make web build
DATA_DIR=./data IMMICH_URL=http://localhost:2283 ./pocket-photos
```

The web dev server (`cd web && npm run dev`) proxies API requests to Go on port 8080.

```sh
make test
# Isolated browser fixtures; never touches a real library:
cd web && npx playwright install chromium && npm run preview -- --host 127.0.0.1 --port 18194
# In another terminal, from the repository root:
node scripts/e2e.mjs
```

Go tests cover connection encryption and isolation, authentication, CSRF, redirect credential leaks, route restrictions, range streaming, and delegated original-preserving imports. The browser suite covers the viewer, edits to metadata, favorites, albums, protected sharing, search, both source imports, uploads, themes, and 1440/768/390/320px layouts. Screenshots above use fictional illustrated fixtures; no private library images are included in this repository.

CI builds the UI and binary and runs the checks. The release workflow publishes multi-architecture Docker images to GHCR and builds release binaries for tagged versions.

## Data and boundaries

Immich remains the system of record for originals, metadata, albums, faces, search, sharing and trash retention. Back it up independently. Pocket Photos does not reimplement Immich's storage or machine-learning pipeline.

Source imports are explicit copies selected in the browser, not background folder synchronization. Browser uploads/imports require the app to remain open. For automatic phone camera backup, use the Immich mobile app against the same server. ZIP selection downloads are assembled by Immich and buffered by the browser; download very large collections from Immich directly.

Core controls access to source apps at read/import time. Once an original is copied into a user's Immich library, it is an independent copy. Removing access to a source does not remove prior imports. Shared links open on `IMMICH_PUBLIC_URL`; recipients need network access to that Immich address, including tailnet access on a private deployment.

[Configuration](docs/configuration.md) · [API and architecture](docs/api.md) · [Deployment](docs/deployment.md) · [Attribution](docs/attribution.md)

MIT license.
