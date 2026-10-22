# Deployment

The repository includes a multi-stage Dockerfile, Compose example, CI and GHCR release workflow. The runtime runs as UID/GID 1000. The application needs only its data directory; it does not mount the Immich originals or other applications' disks.

For this homelab, the deployment follows Pocket Calendar:

- URL: `https://photos.bjelke.org`
- Container: `pocket-photos`, host port `8194` → container `8080`
- Runtime files: `~/pocket-photos/docker-compose.yml`, private `.env`, and `data/`
- Immich direct URL: `http://host.docker.internal:8145`
- Immich sharing URL: `https://immich.bjelke.org`
- Core: `http://host.docker.internal:8179`
- Caddy: `photos.bjelke.org` → `host.docker.internal:8194`, with the same Cloudflare TLS and Pocket Hub frame policy as Calendar
- DNS: DNS-only A record pointing to the same tailnet address as `calendar.bjelke.org`

Only the existing homelab Caddy configuration and Photos runtime deployment need changing; the other Pocket application containers remain untouched. Caddy's previous configuration is backed up before adding the host.

Example Caddy block (adapt the shared snippets for another installation):

```caddy
photos.bjelke.org {
    import tls_cf
    import pocket_workspace "'self' https://hub.bjelke.org"
    reverse_proxy host.docker.internal:8194
}
```

The local runtime uses the tested image `pocket-photos:0.1.0`; CI also publishes `ghcr.io/abjelosevic88/pocket-homelab-photos:latest`. Before an upgrade, back up the app's data directory, build or pull the desired image, update Compose and run `docker compose up -d`. To roll back, restore the previous image and its matching data backup if a schema migration requires it.

Immich backup and retention are independent. A successful `/healthz` confirms the Photos process; `/readyz` checks its database. The authenticated connection status checks Immich separately and presents errors in the UI.
