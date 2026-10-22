# Attribution

- The app shell, design tokens, controls, stroke icons, account handling, OIDC and encryption foundations were adapted from [Pocket Calendar](https://github.com/abjelosevic88/pocket-homelab-calendar), under the MIT license.
- The app icon is drawn by the shared Pocket icon generator in the same "Dimensional" style as the other Pocket apps.
- Pocket Core SDK is pinned in `third_party/pocket-core`; provenance and checksums are retained in `sdk.lock.json` and `SHA256SUMS`.
- World land outlines come from Natural Earth's 1:110m land GeoJSON, projected to an equirectangular SVG path in `web/src/lib/world.ts`. [Natural Earth data is public domain](https://www.naturalearthdata.com/about/terms-of-use/). Source: [natural-earth-vector](https://github.com/nvkelso/natural-earth-vector/blob/master/geojson/ne_110m_land.geojson).
- The fixture library behind the browser suite and the README screenshots uses real photographs from [Unsplash](https://unsplash.com) under the [Unsplash License](https://unsplash.com/license); each photographer is credited in [scripts/fixtures/README.md](../scripts/fixtures/README.md). People's names, dates and places in the fixtures are invented.
