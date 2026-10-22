# Configuration

All configuration comes from environment variables. Credentials never belong in Git.

| Variable | Default | Purpose |
| --- | --- | --- |
| `HOST`, `PORT` | `0.0.0.0`, `8080` | HTTP listener |
| `DATA_DIR` | `./data` | Persistent account database, encryption key and Core registration |
| `DB_PATH` | `DATA_DIR/pocket-photos.db` | SQLite database |
| `BASE_URL` | empty | Browser URL; required for OIDC callback registration |
| `IMMICH_URL` | empty | Trusted server address for direct account connections; optional `/api` suffix |
| `IMMICH_PUBLIC_URL` | empty | Immich browser URL used to open sharing links |
| `CORE_URL` | empty | Pocket Core internal URL |
| `CORE_REGISTRATION_KEY` | empty | Key authorizing initial app registration |
| `CORE_APP_URL` | `BASE_URL` | URL Core uses to reach Photos |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `ADMIN_NAME` | empty, empty, `Admin` | Create the first account on an empty database; password at least 8 characters |
| `AUTH_MODE` | `local` | `local`, `proxy`, or explicitly trusted-network-only `none` |
| `AUTH_PROXY_HEADER` | `Remote-User` | Identity from a trusted authentication proxy |
| `AUTH_PROXY_EMAIL_HEADER` | `Remote-Email` | Email from that proxy |
| `SESSION_TTL` | `720h` | Browser session lifetime |
| `SECURE_COOKIES` | `false` | Set `true` behind HTTPS |
| `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` | empty | Optional explicit OIDC provider; takes precedence over Core |
| `OIDC_NAME` | `single sign-on` | Sign-in button label |
| `OIDC_AUTO_CREATE` | `true` | Provision accounts from a verified OIDC identity |
| `METRICS_ENABLED` | `true` | Expose numeric request/uptime metrics at `/metrics` |
| `TRUST_PROXY` | `true` | Use forwarded client IP headers from a trusted proxy |
| `TZ` | `UTC` | Server timezone |
| `LOG_LEVEL`, `LOG_FORMAT` | `info`, `text` | Logging (`debug`/`info`/`warn`/`error`; `text`/`json`) |

Direct Immich API keys or session tokens are sealed with AES-256-GCM under `DATA_DIR/secret.key`; only ciphertext is kept in SQLite. Password sign-in sends the password once to Immich and saves its session token, not the password. A user without a direct connection asks Core for that user's Immich service credential. Box-wide credentials are not automatically shared between local users.

Back up the complete `DATA_DIR` privately. `pocket-photos backup -o /data/backups/photos.db` creates a consistent SQLite snapshot. Keep `secret.key` alongside the backup and protect `core.token` and `core.token.oidc` if present. Restore while the app is stopped. These files do not include Immich's originals or database.

`pocket-photos reset-password -email person@example.com` resets a local password and prints a newly generated one. Handle that output as a secret.

Only set proxy authentication behind a trusted proxy that replaces incoming identity headers. Do not expose `AUTH_MODE=none` outside an isolated development instance. Requests that mutate data reject cross-origin browser requests. Images and videos are authenticated and returned with private/no-store caching. Upstream authentication headers, cookies and redirect destinations are never exposed as browser credentials.
