// Browser regression suite against an isolated fixture library. No real service is contacted.
import { createRequire } from "node:module";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
const require = createRequire(new URL("../web/package.json", import.meta.url));
const { chromium } = require("playwright");
const browser = process.env.CDP
  ? await chromium.connectOverCDP(process.env.CDP)
  : await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 1440, height: 960 },
});
const base = process.env.BASE || "http://127.0.0.1:18194";
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const assets = Array.from({ length: 18 }, (_, i) => ({
  id: id(i + 1),
  type: "IMAGE",
  originalFileName: `Mountain walk ${i + 1}.jpg`,
  fileCreatedAt: `2026-10-${20 - Math.floor(i / 6)}T10:00:00Z`,
  isFavorite: i === 1,
  isTrashed: false,
  visibility: "timeline",
  width: 1200,
  height: 900,
  exifInfo: {
    description: "",
    city: "Sarajevo",
    country: "Bosnia and Herzegovina",
    latitude: 43.85,
    longitude: 18.4,
    fileSizeInByte: 2600000,
    make: "Sample camera",
  },
}));
let albums = [
  {
    id: id(101),
    albumName: "Autumn walks",
    assetCount: 6,
    albumThumbnailAssetId: id(1),
    shared: false,
  },
];
let shares = [];
const calls = [],
  errors = [];
const svg = (n) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="900"><defs><linearGradient id="s" x2="0" y2="1"><stop stop-color="hsl(${190 + n * 6} 40% 58%)"/><stop offset="1" stop-color="#e6ddd0"/></linearGradient></defs><path fill="url(#s)" d="M0 0h1200v900H0z"/><circle cx="${850 - n * 15}" cy="220" r="85" fill="#f4e3b8"/><path d="M0 690 350 ${240 + n * 10} 670 660 900 400 1200 670V900H0" fill="hsl(${170 + n * 4} 20% 35%)"/><path d="M0 820 300 620 680 780 1000 510 1200 620V900H0" fill="hsl(${155 + n * 3} 25% 24%)"/></svg>`;
await context.route("**/api/v1/**", async (route) => {
  const req = route.request(),
    u = new URL(req.url()),
    p = u.pathname.replace("/api/v1", ""),
    method = req.method();
  let body;
  try {
    body = req.postDataJSON();
  } catch {}
  calls.push({ p, method, body });
  const json = (data) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(data),
    });
  if (
    p.endsWith("/thumbnail") ||
    p.endsWith("/original") ||
    p.endsWith("/thumb") ||
    p.endsWith("/raw")
  )
    return route.fulfill({
      contentType: "image/svg+xml",
      body: svg(Number(p.match(/(\d+)\//)?.[1] || 3) % 18),
    });
  if (p === "/auth/status")
    return json({
      authenticated: true,
      user: { name: "Alex", email: "alex@example.com" },
    });
  if (p === "/connection")
    return json({
      connected: true,
      via: "core",
      core: true,
      public_url: "https://immich.example.com",
      server_configured: true,
      user: { name: "Alex", email: "alex@example.com" },
    });
  if (p === "/immich/assets/statistics")
    return json({ images: 18, videos: 0, total: 18 });
  if (p === "/immich/search/metadata" || p === "/immich/search/smart") {
    let items = assets.filter((a) => !a.isTrashed);
    if (body?.filter?.isFavorite?.eq) items = items.filter((a) => a.isFavorite);
    return json({
      assets: { items, nextCursor: null, nextPage: null },
      albums: { items: [] },
    });
  }
  if (p === "/immich/albums" && method === "POST") {
    const a = {
      id: id(102),
      albumName: body.albumName,
      assetCount: body.assetIds.length,
      albumThumbnailAssetId: body.assetIds[0] || null,
    };
    albums.push(a);
    return json(a);
  }
  if (p === "/immich/albums") return json(albums);
  if (/\/albums\/.+\/assets$/.test(p))
    return json(body.ids.map((id) => ({ id, success: true })));
  if (p === "/immich/people")
    return json({
      people: [{ id: id(201), name: "Alex" }],
      hasNextPage: false,
      total: 1,
    });
  if (p === "/immich/memories")
    return json([
      {
        id: id(301),
        assets: assets.slice(0, 6),
        memoryAt: "2025-10-20",
        data: { title: "A year ago today" },
      },
    ]);
  if (p === "/immich/map/markers")
    return json(
      assets.map((a) => ({
        id: a.id,
        lat: 43.85,
        lon: 18.4,
        city: "Sarajevo",
        country: "Bosnia and Herzegovina",
      })),
    );
  if (p === "/immich/shared-links") {
    if (method === "POST") {
      shares.push({ id: id(401), key: "fixture-link", ...body });
      return json(shares.at(-1));
    }
    return json(shares);
  }
  if (p.endsWith("/edits")) return json({ edits: [] });
  if (/^\/immich\/assets\/[\da-f-]+$/.test(p)) {
    const a = assets.find((a) => p.endsWith(a.id));
    if (method === "PUT") {
      if (body.description !== undefined)
        a.exifInfo.description = body.description;
      Object.assign(a, body);
    }
    return json(a);
  }
  if (p === "/immich/assets" && method === "POST")
    return json({ id: id(501), status: "created" });
  if (p === "/immich/assets" && body?.ids) {
    assets
      .filter((a) => body.ids.includes(a.id))
      .forEach((a) =>
        Object.assign(a, method === "DELETE" ? { isTrashed: true } : body),
      );
    return json({});
  }
  if (p === "/sources/files/spaces")
    return json([{ id: "home", name: "My files" }]);
  if (p === "/sources/files/fs/list")
    return json({
      entries: [
        {
          name: "Family walk.jpg",
          path: "/Family walk.jpg",
          mime: "image/jpeg",
          size: 450000,
          modified: "2026-10-20T12:00:00Z",
        },
      ],
    });
  if (p === "/sources/documents/documents")
    return json({
      count: 1,
      results: [
        {
          id: 1,
          title: "A photo from the archive",
          original_name: "Archive photo.jpg",
          mime: "image/jpeg",
          size: 240000,
          created: "2020-01-02",
        },
      ],
    });
  if (p.endsWith("/import")) return json({ id: id(502), status: "created" });
  return json({});
});
try {
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(base);
  await page.locator(".photo-tile").first().waitFor();
  assert.equal(await page.locator(".photo-tile").count(), 18);
  await page.locator(".photo-open").first().click();
  await page
    .getByRole("button", { name: "Show photo information", exact: true })
    .click();
  await page.locator("textarea[name=description]").fill("A wonderful walk");
  await page
    .getByRole("button", { name: "Save description", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Add to favorites", exact: true })
    .click();
  await page.waitForTimeout(100);
  assert.equal(assets[0].isFavorite, true);
  assert.equal(assets[0].exifInfo.description, "A wonderful walk");
  await page.keyboard.press("ArrowRight");
  await page.getByRole("button", { name: "Close viewer", exact: true }).click();
  await page.getByRole("button", { name: "Select", exact: true }).click();
  await page.locator(".tile-select").first().click();
  await page.getByRole("button", { name: "Add to album", exact: true }).click();
  await page.getByRole("button", { name: "Autumn walks", exact: true }).click();
  await page.waitForTimeout(100);
  assert.ok(
    calls.some(
      (c) =>
        c.p.endsWith("/assets") &&
        c.p.includes("/albums/") &&
        c.method === "PUT",
    ),
  );
  if (await page.getByRole("button", { name: "Done", exact: true }).isVisible())
    await page.getByRole("button", { name: "Done", exact: true }).click();
  await page.getByRole("button", { name: "Select", exact: true }).click();
  await page.locator(".tile-select").first().click();
  await page
    .getByRole("button", { name: "Share selected photos", exact: true })
    .click();
  await page.getByLabel("Password (optional)").fill("test-only-password");
  await page.getByRole("button", { name: "Create link", exact: true }).click();
  await page.getByLabel("Share link").waitFor();
  assert.equal(shares[0].showMetadata, false);
  assert.ok(shares[0].expiresAt);
  await page.getByRole("button", { name: "Close dialog", exact: true }).click();
  await page.getByLabel("Search photos").fill("mountains");
  await page.getByLabel("Search photos").press("Enter");
  await page.waitForTimeout(100);
  assert.ok(
    calls.some(
      (c) => c.p === "/immich/search/smart" && c.body.query === "mountains",
    ),
  );
  await page.goto(base + "/#view=sources");
  await page.locator(".source-check input").check();
  await page
    .getByRole("button", { name: "Import to library", exact: true })
    .click();
  await page.locator(".import-results").waitFor();
  assert.ok(
    calls.some(
      (c) =>
        c.p === "/sources/files/import" && c.body.path === "/Family walk.jpg",
    ),
  );
  await page.getByRole("button", { name: /Pocket Documents Images/ }).click();
  await page.locator(".source-check input").check();
  await page
    .getByRole("button", { name: "Import to library", exact: true })
    .click();
  await page.waitForTimeout(100);
  assert.ok(
    calls.some((c) => c.p === "/sources/documents/import" && c.body.id === 1),
  );
  await page.goto(base + "/#view=library");
  await page
    .locator("input[type=file]")
    .setInputFiles({
      name: "fixture.png",
      mimeType: "image/png",
      buffer: Buffer.from("fixture"),
    });
  await page
    .locator(".upload-item small")
    .filter({ hasText: "Uploaded" })
    .waitFor()
    .catch(async (e) => {
      console.log(
        "Upload state",
        await page.locator(".upload-panel").innerText(),
        calls.slice(-4),
      );
      throw e;
    });
  await page
    .getByRole("button", { name: "Close uploads", exact: true })
    .click();
  const output = new URL("../docs/screenshots/", import.meta.url);
  await fs.mkdir(output, { recursive: true });
  await page.getByLabel("Search photos").fill("");
  await page.locator(".toast").waitFor({state:"hidden", timeout:6000});
  for (const width of [1440, 768, 390, 320]) {
    await page.setViewportSize({ width, height: width < 768 ? 844 : 960 });
    await page.goto(base + "/#view=library");
    await page.locator(".photo-tile").first().waitFor();
    await page.waitForTimeout(150);
    const overflow = await page
      .locator(".content")
      .evaluate((e) => e.scrollWidth > e.clientWidth + 1);
    assert.equal(overflow, false, `Content overflows at ${width}px`);
    if ([1440, 390].includes(width))
      await page.screenshot({
        path: new URL(
          width === 1440 ? "library.png" : "mobile-library.png",
          output,
        ).pathname,
      });
    if (width < 768) {
      await page
        .getByRole("button", { name: "Open navigation", exact: true })
        .click();
      await page.locator(".sidebar.open").waitFor();
      await page
        .locator(".sidebar button")
        .filter({ hasText: "Sources" })
        .click();
      await page.locator(".source-card").first().waitFor();
      assert.equal(
        await page
          .locator(".content")
          .evaluate((e) => e.scrollWidth > e.clientWidth + 1),
        false,
      );
    }
  }
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.goto(base + "/#view=settings");
  await page.getByRole("button", { name: "Dark", exact: true }).click();
  await page.goto(base + "/#view=library");
  await page.locator(".photo-tile").first().waitFor();
  await page.screenshot({ path: new URL("library-dark.png", output).pathname });
  assert.deepEqual(errors, []);
  console.log(
    "PASS: gallery, viewer, metadata, favorites, album actions, protected sharing, smart search, Files/Documents imports, upload queue, light/dark themes, and four responsive widths.",
  );
} finally {
  await context.close();
  await browser.close();
}
