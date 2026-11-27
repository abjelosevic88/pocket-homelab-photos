# API and architecture

The Go server embeds the Vite build and serves authenticated routes under `/api/v1`. SQLite stores local users, hashed sessions and API tokens, encrypted per-user Immich connections and the pinned Pocket Core SDK state. Originals remain in Immich or their source app.

| Route | Purpose |
| --- | --- |
| `GET /healthz`, `GET /readyz` | Process health and SQLite readiness |
| `GET /api/v1/auth/status` | Setup/sign-in state and OIDC availability |
| `POST /api/v1/auth/setup` | Create the first local account, once |
| `POST /api/v1/auth/login`, `POST /api/v1/auth/logout` | Cookie sessions |
| `GET /api/v1/auth/me` | Current user |
| `GET /api/v1/auth/oidc/start`, `GET /api/v1/auth/oidc/callback` | OIDC code/PKCE flow, verified ID token and Core session tracking |
| `GET /api/v1/connection` | Test current user's Immich connection; no credentials returned |
| `PUT /api/v1/connection` | `{api_key}` or `{email,password}`; validated before replacing saved connection |
| `DELETE /api/v1/connection` | Remove the direct credential, falling back to Core when available |
| `/api/v1/immich/*` | Explicitly allowlisted Immich API methods; credentials injected on the server |
| `GET /api/v1/pocket/search?q=&limit=` | Pocket Search: photos and videos that match a description (Immich smart search), best first |
| `GET /api/v1/pocket/day/{YYYY-MM-DD}?tz=` | Pocket Day: how many photos and videos were taken that day, and up to 12 of them with thumbnails |
| `GET /api/v1/pocket/widget` | Pocket Hub: *On this day*, one row per earlier year with photos from today's date |
| `GET /api/v1/sources/files/spaces` | Authorized Pocket Files spaces |
| `GET /api/v1/sources/files/fs/list?space=&path=` | Authorized folders and files |
| `GET /api/v1/sources/files/fs/search?space=&path=&q=` | File search |
| `GET /api/v1/sources/files/fs/raw?space=&path=` | Original preview |
| `GET /api/v1/sources/files/fs/thumb?space=&path=` | Thumbnail |
| `GET /api/v1/sources/documents/documents?mime=image%2F&limit=&offset=&q=` | Image documents, paginated |
| `GET /api/v1/sources/documents/documents/{id}/thumb` | Document thumbnail |
| `GET /api/v1/sources/documents/documents/{id}/download?original=1` | Original image |
| `POST /api/v1/sources/files/import` | `{space,path,modified}`; stream an original into Immich |
| `POST /api/v1/sources/documents/import` | `{id,modified}`; stream an original image into Immich |
| `GET/POST /api/v1/tokens`, `DELETE /api/v1/tokens/{id}` | Personal Photos API tokens |
| `GET/POST /api/v1/users`, `PUT/DELETE /api/v1/users/{id}` | Local account administration; admin enforcement |

All source calls obtain a short-lived Core delegation for the signed-in user's email and the target's read scope. Target apps enforce folder, share and document access. The Photos API exposes no source write operation. Imports stream multipart uploads; original bytes and filenames are preserved, and known source timestamps are supplied as fallbacks. Immich extracts EXIF and performs checksum duplicate detection. A retry therefore reports an existing asset for unchanged bytes.

The Immich proxy forwards only supported photo operations. Administrative configuration, API key management and arbitrary URLs are unavailable. It strips incoming shared-link authentication query parameters, browser credentials and cookies; injects the current user's Immich credential; refuses redirects; and preserves byte ranges for video playback. JSON bodies are limited to 2 MiB, uploads to 20 GiB. Media responses carry a sandbox content policy and private/no-store caching.

The three `/api/v1/pocket/*` routes are Pocket Core's capability contract (`docs/capabilities.md` in pocket-homelab-core). A signed-in person may call them, and so may a Core link token with `pocket:search`, `pocket:day` or `pocket:widget`, which opens that one route and nothing else (not the thumbnails either: the browser of the signed-in person loads those). Each call reaches Immich with the current user's own credential, like every other route; a person with no library gets an empty answer, an Immich that fails a 500. The day runs from midnight to midnight in `tz` (the server's `TZ` when absent), counts up to 2,000 items and leaves out archived, hidden and deleted ones. *On this day* is Immich's `on_this_day` memories for today in the server's `TZ`; Immich's answer is kept in memory for ten minutes per person, while the person's connection is checked on every call.

API compatibility was checked against the [Immich 3.3.5 OpenAPI schema](https://github.com/immich-app/immich/blob/v3.3.5/open-api/immich-openapi-specs.json). Stable metadata searches use structured filters and cursors; smart search uses page tokens. Photo edits depend on Immich's beta non-destructive edit API. Machine learning features depend on the Immich server's configuration and completed jobs.
