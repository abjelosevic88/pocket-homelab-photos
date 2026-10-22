# Attribution

- The app shell tokens, basic controls, stroke icons, account handling, OIDC and encryption foundations were adapted from [Pocket Calendar](https://github.com/abjelosevic88/pocket-homelab-calendar), under the MIT license.
- Pocket Core SDK is pinned in `third_party/pocket-core`; provenance and checksums are retained in `sdk.lock.json` and `SHA256SUMS`.
- World land outlines come from Natural Earth's 1:110m land GeoJSON, projected to an equirectangular SVG path in `web/src/lib/world.ts`. [Natural Earth data is public domain](https://www.naturalearthdata.com/about/terms-of-use/). Source: [natural-earth-vector](https://github.com/nvkelso/natural-earth-vector/blob/master/geojson/ne_110m_land.geojson).
- README screenshots are generated from the synthetic SVG illustrations and fictional accounts in `scripts/e2e.mjs`. They do not contain personal photos or third-party photo assets.
