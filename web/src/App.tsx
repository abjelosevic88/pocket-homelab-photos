import { useEffect, useRef, useState, useMemo } from "react";
import { api, photo, thumb, immich, base, date, type Asset } from "./lib/api";
import { Icon } from "./components/icons";
import { Button, Empty, ErrorBox, Modal } from "./components/ui";
import { Viewer } from "./Viewer";
import { Sources } from "./Sources";
import { Settings } from "./Settings";
import { UploadQueue } from "./UploadQueue";
import { Places } from "./Places";

type Route = { view: string; id?: string; name?: string };
const nav = [
  ["library", "image", "All photos"],
  ["favorites", "heart", "Favorites"],
  ["videos", "video", "Videos"],
  ["memories", "sparkle", "Memories"],
  ["albums", "album", "Albums"],
  ["people", "users", "People"],
  ["places", "pin", "Places"],
  ["sharing", "link", "Sharing"],
];
const readRoute = (): Route => {
  const q = new URLSearchParams(location.hash.slice(1));
  return {
    view: q.get("view") || "library",
    id: q.get("id") || undefined,
    name: q.get("name") || undefined,
  };
};
export function App({
  user,
  logout,
}: {
  user: any;
  logout: () => Promise<void>;
}) {
  const [route, setRoute] = useState<Route>(readRoute),
    [connection, setConnection] = useState<any>(),
    [connectionError, setConnectionError] = useState(""),
    [drawer, setDrawer] = useState(false),
    [theme, setTheme] = useState(
      localStorage.getItem("photos-theme") || "system",
    ),
    [assets, setAssets] = useState<Asset[]>([]),
    [collections, setCollections] = useState<any[]>([]),
    [loading, setLoading] = useState(false),
    [error, setError] = useState(""),
    [next, setNext] = useState<string | null>(null),
    [selected, setSelected] = useState<Set<string>>(new Set()),
    [selecting, setSelecting] = useState(false),
    [viewer, setViewer] = useState<number | null>(null),
    [query, setQuery] = useState(""),
    [search, setSearch] = useState(""),
    [searchMode, setSearchMode] = useState("smart"),
    [type, setType] = useState(""),
    [from, setFrom] = useState(""),
    [until, setUntil] = useState(""),
    [order, setOrder] = useState("desc"),
    [density, setDensity] = useState(
      localStorage.getItem("photos-density") || "comfortable",
    ),
    [group, setGroup] = useState("day"),
    [refresh, setRefresh] = useState(0),
    [toast, setToast] = useState(""),
    [modal, setModal] = useState<string | null>(null),
    [albums, setAlbums] = useState<any[]>([]),
    [busy, setBusy] = useState(false),
    [modalError, setModalError] = useState(""),
    [shareURL, setShareURL] = useState(""),
    [files, setFiles] = useState<File[]>([]),
    [stats, setStats] = useState<any>();
  const uploadRef = useRef<HTMLInputElement>(null),
    searchRef = useRef<HTMLInputElement>(null),
    generation = useRef(0),
    lastSelected = useRef<string | undefined>(undefined),
    cancelLoad = useRef<AbortController | null>(null);
  const navigate = (view: string, id?: string, name?: string) => {
    const q = new URLSearchParams({ view });
    if (id) q.set("id", id);
    if (name) q.set("name", name);
    location.hash = q.toString();
    setDrawer(false);
  };
  const notify = (s: string) => {
    setToast(s);
  };
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(""), 5000);
    return () => clearTimeout(t);
  }, [toast]);
  const checkConnection = () => {
    setConnectionError("");
    api("/connection")
      .then(setConnection)
      .catch((e) => setConnectionError(e.message));
  };
  useEffect(() => {
    checkConnection();
    const changed = () => setRoute(readRoute());
    window.addEventListener("hashchange", changed);
    return () => window.removeEventListener("hashchange", changed);
  }, []);
  useEffect(() => {
    const media = matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      document.documentElement.dataset.theme =
        theme === "system" ? (media.matches ? "dark" : "light") : theme;
    };
    apply();
    localStorage.setItem("photos-theme", theme);
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [theme]);
  useEffect(() => {
    localStorage.setItem("photos-density", density);
  }, [density]);
  useEffect(() => {
    if (connection?.connected)
      photo("/assets/statistics")
        .then(setStats)
        .catch(() => {});
  }, [connection, refresh]);
  const gallery = [
    "library",
    "favorites",
    "videos",
    "archive",
    "trash",
    "search",
    "album",
    "person",
    "place",
    "recent",
  ].includes(route.view);
  function filters() {
    const f: Record<string, any> = {
      trashedAt: route.view === "trash" ? { ne: null } : { eq: null },
      visibility: { eq: route.view === "archive" ? "archive" : "timeline" },
    };
    if (
      route.view === "trash" ||
      route.view === "album" ||
      route.view === "person" ||
      route.view === "search" ||
      route.view === "place"
    )
      delete f.visibility;
    if (route.view === "favorites") f.isFavorite = { eq: true };
    if (route.view === "videos" || type)
      f.type = { eq: route.view === "videos" ? "VIDEO" : type };
    if (route.view === "album") f.albumIds = { any: [route.id] };
    if (route.view === "person") f.personIds = { any: [route.id] };
    if (route.view === "place") f.city = { eq: route.name };
    if (from || until)
      f.takenAt = {
        ...(from ? { gte: new Date(from + "T00:00:00").toISOString() } : {}),
        ...(until ? { lte: new Date(until + "T23:59:59").toISOString() } : {}),
      };
    if (route.view === "search" && search && searchMode !== "smart")
      f[searchMode === "ocr" ? "ocr" : "originalFileName"] =
        searchMode === "ocr"
          ? { matches: search }
          : { like: "%" + search + "%" };
    return f;
  }
  async function load(cursor?: string) {
    const g = generation.current;
    setLoading(true);
    setError("");
    const controller = new AbortController();
    if (!cursor) cancelLoad.current?.abort();
    cancelLoad.current = controller;
    try {
      if (gallery) {
        const smart =
          route.view === "search" && search && searchMode === "smart";
        const v = await photo(
          smart ? "/search/smart" : "/search/metadata",
          "POST",
          {
            filter: filters(),
            size: 120,
            withExif: true,
            ...(!smart && cursor ? { cursor } : {}),
            ...(smart
              ? { query: search, page: Number(cursor || 1) }
              : {
                  orderBy: {
                    field:
                      route.view === "recent" ? "createdAt" : "fileCreatedAt",
                    direction: order,
                  },
                }),
          },
          controller.signal,
        );
        if (g !== generation.current) return;
        setAssets((old) =>
          cursor
            ? [
                ...old,
                ...v.assets.items.filter(
                  (a: Asset) => !old.some((o) => o.id === a.id),
                ),
              ]
            : v.assets.items,
        );
        setNext((smart ? v.assets.nextPage : v.assets.nextCursor) || null);
      } else if (route.view === "albums") {
        const v = await photo("/albums", "GET", undefined, controller.signal);
        if (g === generation.current) setCollections(v);
      } else if (route.view === "people") {
        const page = cursor || "1";
        const v = await photo(
          "/people?size=100&page=" + page,
          "GET",
          undefined,
          controller.signal,
        );
        if (g === generation.current) {
          setCollections((old) => (cursor ? [...old, ...v.people] : v.people));
          setNext(v.hasNextPage ? String(+page + 1) : null);
        }
      } else if (route.view === "memories") {
        const page = cursor || "1";
        const v = await photo(
          "/memories?size=50&page=" + page,
          "GET",
          undefined,
          controller.signal,
        );
        if (g === generation.current) {
          setCollections((old) => (cursor ? [...old, ...v] : v));
          setNext(v.length === 50 ? String(+page + 1) : null);
        }
      } else if (route.view === "sharing") {
        const v = await photo(
          "/shared-links",
          "GET",
          undefined,
          controller.signal,
        );
        if (g === generation.current) setCollections(v);
      }
    } catch (e: any) {
      if (e.name !== "AbortError" && g === generation.current)
        setError(e.message);
    } finally {
      if (g === generation.current) setLoading(false);
    }
  }
  useEffect(() => {
    generation.current++;
    cancelLoad.current?.abort();
    setAssets([]);
    setCollections([]);
    setNext(null);
    setSelected(new Set());
    setSelecting(false);
    setViewer(null);
    setError("");
    if (connection?.connected) load();
    return () => {
      cancelLoad.current?.abort();
    };
  }, [
    route,
    connection,
    search,
    searchMode,
    type,
    from,
    until,
    order,
    refresh,
  ]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (
        (e.target as HTMLElement).closest("input,textarea,select") ||
        modal ||
        viewer !== null
      )
        return;
      if (e.key === "/") {
        e.preventDefault();
        searchRef.current?.focus();
      }
      if (e.key === "Escape") {
        setSelected(new Set());
        setSelecting(false);
        setDrawer(false);
      }
      if (e.key === "u") uploadRef.current?.click();
      if (e.key === "?") setModal("shortcuts");
      if ((e.ctrlKey || e.metaKey) && e.key === "a" && gallery) {
        e.preventDefault();
        setSelected(new Set(assets.map((a) => a.id)));
        setSelecting(true);
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [assets, modal, viewer, gallery]);
  function select(a: Asset, shift = false) {
    setSelected((old) => {
      const n = new Set(old);
      if (shift && lastSelected.current) {
        const start = assets.findIndex((x) => x.id === lastSelected.current),
          end = assets.findIndex((x) => x.id === a.id);
        assets
          .slice(Math.min(start, end), Math.max(start, end) + 1)
          .forEach((x) => n.add(x.id));
      } else if (n.has(a.id)) n.delete(a.id);
      else n.add(a.id);
      return n;
    });
    lastSelected.current = a.id;
  }
  const groups = useMemo(() => {
    const g: Record<string, Asset[]> = {};
    for (const a of assets) {
      const raw = a.localDateTime || a.fileCreatedAt;
      const key =
        group === "all"
          ? "All photos"
          : raw?.slice(0, group === "year" ? 4 : group === "month" ? 7 : 10) ||
            "Unknown date";
      (g[key] ||= []).push(a);
    }
    return Object.entries(g);
  }, [assets, group]);
  const title =
    route.name ||
    nav.find((n) => n[0] === route.view)?.[2] ||
    (
      {
        archive: "Archive",
        trash: "Recently deleted",
        sources: "Sources",
        settings: "Settings",
        search: "Search",
        recent: "Recently added",
      } as Record<string, string>
    )[route.view] ||
    "Photos";
  const reload = () => setRefresh((x) => x + 1);
  async function mutate(action: string, ids = [...selected]) {
    if (!ids.length) return;
    setBusy(true);
    setModalError("");
    try {
      if (action === "trash")
        await photo("/assets", "DELETE", { ids, force: false });
      else if (action === "delete")
        await photo("/assets", "DELETE", { ids, force: true });
      else if (action === "restore")
        await photo("/trash/restore/assets", "POST", { ids });
      else if (action === "remove-album") {
        const result = await photo(
          "/albums/" + route.id + "/assets",
          "DELETE",
          { ids },
        );
        if (result?.some((x: any) => !x.success))
          throw new Error(
            "Some photos could not be removed. Refresh the album and try again.",
          );
      } else
        await photo("/assets", "PUT", {
          ids,
          ...(action === "favorite"
            ? { isFavorite: true }
            : action === "unfavorite"
              ? { isFavorite: false }
              : { visibility: action === "archive" ? "archive" : "timeline" }),
        });
      setModal(null);
      setSelected(new Set());
      notify(
        action === "trash"
          ? "Moved to recently deleted"
          : action === "restore"
            ? "Photos restored"
            : "Library updated",
      );
      reload();
    } catch (e: any) {
      setModalError(e.message);
      notify(e.message);
    } finally {
      setBusy(false);
    }
  }
  async function openAlbumPicker() {
    setModal("add-album");
    setModalError("");
    try {
      setAlbums(await photo("/albums"));
    } catch (e: any) {
      setModalError(e.message);
    }
  }
  async function addAlbum(id: string) {
    setBusy(true);
    try {
      const result = await photo("/albums/" + id + "/assets", "PUT", {
        ids: [...selected],
      });
      if (result?.some((x: any) => !x.success && x.error !== "duplicate"))
        throw new Error(
          "Some photos could not be added. Check album permissions.",
        );
      setModal(null);
      notify("Added to album");
      setSelected(new Set());
    } catch (e: any) {
      setModalError(e.message);
    } finally {
      setBusy(false);
    }
  }
  async function download() {
    setBusy(true);
    try {
      const r = await fetch(immich + "/download/archive", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          assetIds: [...selected],
          archiveName: "Pocket Photos",
        }),
      });
      if (!r.ok) throw new Error("Download failed");
      const url = URL.createObjectURL(await r.blob());
      const a = document.createElement("a");
      a.href = url;
      a.download = "Pocket Photos.zip";
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (e: any) {
      notify(e.message);
    } finally {
      setBusy(false);
    }
  }
  const openShare = () => {
    setShareURL("");
    setModalError("");
    setModal("share");
  };
  const shareLink = (s: any) =>
    connection?.public_url
      ? connection.public_url.replace(/\/$/, "") + "/share/" + (s.slug || s.key)
      : "";
  return (
    <div
      className="app"
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("Files")) e.preventDefault();
      }}
      onDrop={(e) => {
        if (e.dataTransfer.files.length) {
          e.preventDefault();
          const incoming = Array.from(e.dataTransfer.files);
          setFiles((f) => [...f, ...incoming]);
        }
      }}
    >
      {drawer && (
        <div className="drawer-shade" onClick={() => setDrawer(false)} />
      )}
      <aside className={"sidebar " + (drawer ? "open" : "")}>
        <div className="brand">
          <img src="/favicon.svg" alt="" />
          <span>
            <b>Pocket</b> Photos
          </span>
          <span className="version">0.1</span>
        </div>
        <Button
          icon="upload"
          primary
          onClick={() => uploadRef.current?.click()}
          disabled={!connection?.connected}
        >
          Upload photos <kbd>U</kbd>
        </Button>
        <div className="nav-label">Library</div>
        <nav>
          {nav.map(([id, icon, label]) => (
            <button
              key={id}
              className={"nav-item " + (route.view === id ? "active" : "")}
              onClick={() => navigate(id)}
            >
              <Icon name={icon} size={19} />
              {label}
              {id === "library" && stats && (
                <span className="nav-count">
                  {stats.total?.toLocaleString()}
                </span>
              )}
            </button>
          ))}
        </nav>
        <div className="nav-label">Your homelab</div>
        <button
          className={"nav-item " + (route.view === "sources" ? "active" : "")}
          onClick={() => navigate("sources")}
        >
          <Icon name="sources" size={19} />
          Sources<span className="badge">2</span>
        </button>
        <div className="source-hint">Photos from Files & Documents</div>
        <div className="nav-label">Utilities</div>
        {[
          ["recent", "clock", "Recently added"],
          ["archive", "archive", "Archive"],
          ["trash", "trash", "Recently deleted"],
        ].map(([id, icon, label]) => (
          <button
            key={id}
            className={"nav-item " + (route.view === id ? "active" : "")}
            onClick={() => navigate(id)}
          >
            <Icon name={icon} size={18} />
            {label}
          </button>
        ))}
        <div className="sidebar-bottom">
          <div className="connection-label">
            <span
              className={
                "status-dot " + (connection?.connected ? "online" : "")
              }
            />
            {connection?.connected
              ? "Connected to Immich"
              : "Library not connected"}
          </div>
          <button
            className={
              "nav-item " + (route.view === "settings" ? "active" : "")
            }
            onClick={() => navigate("settings")}
          >
            <Icon name="settings" size={18} />
            Settings
          </button>
          <div className="profile">
            <span className="avatar">
              {(user.name || user.email).slice(0, 1).toUpperCase()}
            </span>
            <div>
              <b>{user.name || "Your library"}</b>
              <small>{user.email}</small>
            </div>
            <Button
              icon="log-out"
              title="Sign out"
              onClick={() => logout().catch((e) => notify(e.message))}
            />
          </div>
        </div>
      </aside>
      <main className="main">
        <header className="topbar">
          <Button
            icon="menu"
            title="Open navigation"
            onClick={() => setDrawer(!drawer)}
          />
          <form
            className="searchbox"
            onSubmit={(e) => {
              e.preventDefault();
              setSearch(query.trim());
              navigate("search");
            }}
          >
            <Icon name="search" size={18} />
            <input
              ref={searchRef}
              aria-label="Search photos"
              placeholder="Search your photos, places, moments…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <kbd>/</kbd>
          </form>
          <div className="top-actions">
            <Button
              icon={theme === "dark" ? "sun" : "moon"}
              title="Switch appearance"
              onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
            />
            <Button
              icon="upload"
              title="Upload photos"
              disabled={!connection?.connected}
              onClick={() => uploadRef.current?.click()}
            />
          </div>
        </header>
        <input
          ref={uploadRef}
          type="file"
          accept="image/*,video/*,.heic,.heif,.dng,.cr2,.nef,.arw,.raf"
          multiple
          hidden
          onChange={(e) => {
            const incoming = Array.from(e.currentTarget.files || []);
            setFiles((f) => [...f, ...incoming]);
            e.target.value = "";
          }}
        />
        <div className="content" key={route.view + route.id}>
          <div className="page-heading">
            <div>
              <div className="eyebrow">YOUR POCKET LIBRARY</div>
              <h1>{title}</h1>
              <p className="muted">
                {route.view === "library"
                  ? "Every moment, right where it belongs."
                  : route.view === "sources"
                    ? "Bring the photos in your homelab together."
                    : route.view === "trash"
                      ? "Restore moments you want to keep. Immich manages the retention period."
                      : route.view === "albums"
                        ? "A little order for your favorite stories."
                        : route.view === "search"
                          ? "Find the moment you have in mind."
                          : route.view === "settings"
                            ? "Make yourself at home."
                            : route.view === "people"
                              ? "The people who make your photos yours."
                              : route.view === "places"
                                ? "See where your memories take you."
                                : route.view === "memories"
                                  ? "A look back at the days worth remembering."
                                  : route.view === "sharing"
                                    ? "Manage the moments you share with others."
                                    : `${assets.length.toLocaleString()} photos and videos loaded`}
              </p>
            </div>
            <div className="heading-actions">
              {route.view === "albums" && (
                <Button
                  icon="plus"
                  primary
                  onClick={() => {
                    setModalError("");
                    setModal("new-album");
                  }}
                >
                  New album
                </Button>
              )}
              {route.view === "album" && (
                <>
                  <Button
                    icon="edit"
                    title="Rename album"
                    onClick={() => {
                      setModalError("");
                      setModal("rename-album");
                    }}
                  />
                  <Button icon="link" title="Share album" onClick={openShare} />
                  <Button
                    icon="trash"
                    title="Delete album"
                    onClick={() => setModal("delete-album")}
                  />
                </>
              )}
              {gallery && (
                <Button
                  icon="check-circle"
                  onClick={() => {
                    setSelecting(!selecting);
                    setSelected(new Set());
                  }}
                >
                  {selecting ? "Done" : "Select"}
                </Button>
              )}
              <Button
                icon="refresh"
                title="Refresh"
                onClick={() => {
                  reload();
                  checkConnection();
                }}
              />
            </div>
          </div>
          {connectionError && (
            <ErrorBox message={connectionError} retry={checkConnection} />
          )}
          {route.view === "settings" ? (
            <Settings
              connection={connection}
              changed={checkConnection}
              theme={theme}
              setTheme={setTheme}
              user={user}
            />
          ) : route.view === "sources" ? (
            <Sources connected={!!connection?.connected} notify={notify} />
          ) : !connection ? (
            <div className="loading">Connecting to your library…</div>
          ) : !connection.connected ? (
            <div className="connect-card">
              <Icon name="image" size={40} />
              <h2>Your moments start here</h2>
              <p>
                Connect Immich to browse, organize and rediscover your photos.
                <br />
                You can also bring in photos from Pocket Files and Documents.
              </p>
              <p className="muted">{connection.message}</p>
              <Button primary icon="link" onClick={() => navigate("settings")}>
                Connect your library
              </Button>
            </div>
          ) : (
            <>
              {gallery && (
                <>
                  <div className="library-toolbar">
                    <div className="segmented" aria-label="Group photos">
                      {["all", "day", "month", "year"].map((g) => (
                        <button
                          className={group === g ? "active" : ""}
                          key={g}
                          onClick={() => setGroup(g)}
                        >
                          {g === "all"
                            ? "All photos"
                            : g === "day"
                              ? "Days"
                              : g === "month"
                                ? "Months"
                                : "Years"}
                        </button>
                      ))}
                    </div>
                    <div className="spacer" />
                    <select
                      aria-label="Sort photos"
                      value={order}
                      onChange={(e) => setOrder(e.target.value)}
                    >
                      <option value="desc">Newest first</option>
                      <option value="asc">Oldest first</option>
                    </select>
                    <Button
                      icon="grid"
                      title="Change grid density"
                      onClick={() =>
                        setDensity(
                          density === "comfortable" ? "compact" : "comfortable",
                        )
                      }
                    />
                  </div>
                  {route.view === "search" && (
                    <div className="filters">
                      <label>
                        Search in
                        <select
                          value={searchMode}
                          onChange={(e) => setSearchMode(e.target.value)}
                        >
                          <option value="smart">Natural language</option>
                          <option value="filename">File names</option>
                          <option value="ocr">Text in photos</option>
                        </select>
                      </label>
                      <label>
                        Media
                        <select
                          value={type}
                          onChange={(e) => setType(e.target.value)}
                        >
                          <option value="">All media</option>
                          <option value="IMAGE">Photos</option>
                          <option value="VIDEO">Videos</option>
                        </select>
                      </label>
                      <label>
                        From
                        <input
                          type="date"
                          value={from}
                          onChange={(e) => setFrom(e.target.value)}
                        />
                      </label>
                      <label>
                        Until
                        <input
                          type="date"
                          value={until}
                          onChange={(e) => setUntil(e.target.value)}
                        />
                      </label>
                      <Button
                        onClick={() => {
                          setType("");
                          setFrom("");
                          setUntil("");
                          setSearch("");
                          setQuery("");
                        }}
                      >
                        Clear
                      </Button>
                    </div>
                  )}
                  {selected.size > 0 && (
                    <div className="selection-bar">
                      <Button
                        icon="x"
                        title="Clear selection"
                        onClick={() => setSelected(new Set())}
                      />
                      <b>{selected.size} selected</b>
                      <Button
                        onClick={() =>
                          setSelected(new Set(assets.map((a) => a.id)))
                        }
                      >
                        Select loaded
                      </Button>
                      <div className="spacer" />
                      {route.view === "trash" ? (
                        <>
                          <Button
                            icon="repeat"
                            disabled={busy}
                            onClick={() => mutate("restore")}
                          >
                            Restore
                          </Button>
                          <Button
                            icon="trash"
                            danger
                            onClick={() => setModal("delete")}
                          >
                            Delete forever
                          </Button>
                        </>
                      ) : (
                        <>
                          <Button
                            icon="heart"
                            title={
                              route.view === "favorites"
                                ? "Remove favorites"
                                : "Add to favorites"
                            }
                            disabled={busy}
                            onClick={() =>
                              mutate(
                                route.view === "favorites"
                                  ? "unfavorite"
                                  : "favorite",
                              )
                            }
                          />
                          <Button
                            icon="album"
                            title="Add to album"
                            onClick={openAlbumPicker}
                          />
                          <Button
                            icon="link"
                            title="Share selected photos"
                            onClick={openShare}
                          />
                          <Button
                            icon="download"
                            title="Download selected photos as ZIP"
                            disabled={busy}
                            onClick={download}
                          />
                          <Button
                            icon="archive"
                            title={
                              route.view === "archive"
                                ? "Move to library"
                                : "Archive"
                            }
                            disabled={busy}
                            onClick={() =>
                              mutate(
                                route.view === "archive"
                                  ? "unarchive"
                                  : "archive",
                              )
                            }
                          />
                          {route.view === "album" && (
                            <Button
                              title="Remove from this album"
                              icon="minus"
                              onClick={() => mutate("remove-album")}
                            />
                          )}
                          <Button
                            icon="trash"
                            title="Move to recently deleted"
                            onClick={() => setModal("trash")}
                          />
                        </>
                      )}
                    </div>
                  )}
                  {groups.map(([key, items]) => (
                    <section className="photo-section" key={key}>
                      <div className="date-heading">
                        <button
                          onClick={() => {
                            setSelecting(true);
                            setSelected((old) => {
                              const n = new Set(old);
                              const all = items.every((a) => n.has(a.id));
                              items.forEach((a) =>
                                all ? n.delete(a.id) : n.add(a.id),
                              );
                              return n;
                            });
                          }}
                          aria-label={"Select " + key}
                        >
                          <Icon
                            name={
                              items.every((a) => selected.has(a.id))
                                ? "check-circle"
                                : "circle"
                            }
                            size={18}
                          />
                        </button>
                        <h2>
                          {group === "day" && key !== "Unknown date"
                            ? date(key + "T12:00:00")
                            : group === "month"
                              ? new Date(
                                  key + "-01T12:00:00",
                                ).toLocaleDateString(undefined, {
                                  month: "long",
                                  year: "numeric",
                                })
                              : key}
                        </h2>
                        <span>{items.length}</span>
                      </div>
                      <div className={"photo-grid " + density}>
                        {items.map((a) => (
                          <div
                            key={a.id}
                            className={
                              "photo-tile " +
                              (selected.has(a.id) ? "selected" : "")
                            }
                          >
                            <button
                              className="photo-open"
                              aria-label={
                                "Open " + (a.originalFileName || "photo")
                              }
                              onClick={(e) => {
                                if (selecting || selected.size || e.shiftKey)
                                  select(a, e.shiftKey);
                                else
                                  setViewer(
                                    assets.findIndex((x) => x.id === a.id),
                                  );
                              }}
                            >
                              <img
                                src={thumb(a)}
                                loading="lazy"
                                alt={
                                  a.exifInfo?.description ||
                                  a.originalFileName ||
                                  "Photo"
                                }
                                onError={(e) => {
                                  e.currentTarget.classList.add("broken");
                                }}
                              />
                              {a.type === "VIDEO" && (
                                <span className="media-label">
                                  <Icon name="play" size={12} />
                                  {a.duration
                                    ? Math.floor(a.duration / 60000) +
                                      ":" +
                                      String(
                                        Math.floor(a.duration / 1000) % 60,
                                      ).padStart(2, "0")
                                    : "Video"}
                                </span>
                              )}
                              {a.livePhotoVideoId && (
                                <span className="media-label">LIVE</span>
                              )}
                              {a.isFavorite && (
                                <span className="favorite-mark">
                                  <Icon name="heart" size={16} />
                                </span>
                              )}
                            </button>
                            <button
                              className={
                                "tile-select " + (selecting ? "visible" : "")
                              }
                              aria-label={
                                "Select " + (a.originalFileName || "photo")
                              }
                              aria-pressed={selected.has(a.id)}
                              onClick={(e) => select(a, e.shiftKey)}
                            >
                              <Icon
                                name={
                                  selected.has(a.id) ? "check-circle" : "circle"
                                }
                                size={22}
                              />
                            </button>
                          </div>
                        ))}
                      </div>
                    </section>
                  ))}
                  {!assets.length && !loading && !error && (
                    <Empty
                      title={
                        route.view === "search"
                          ? "No photos found"
                          : "A little room for memories"
                      }
                    >
                      {route.view === "search" ? (
                        "Try another description or adjust your filters."
                      ) : route.view === "library" ? (
                        <>
                          Upload photos or find them in{" "}
                          <button
                            className="text-link"
                            onClick={() => navigate("sources")}
                          >
                            your sources
                          </button>
                          .
                        </>
                      ) : (
                        "Photos you add here will appear in this view."
                      )}
                    </Empty>
                  )}
                </>
              )}
              {["albums", "memories", "people"].includes(route.view) && (
                <div
                  className={
                    "collection-grid " +
                    (route.view === "people" ? "people-grid" : "")
                  }
                >
                  {collections.map((c) => {
                    const id =
                      route.view === "memories"
                        ? c.assets?.[0]?.id
                        : route.view === "albums"
                          ? c.albumThumbnailAssetId
                          : c.id;
                    return (
                      <div className="collection" key={c.id}>
                        <button
                          className="collection-open"
                          onClick={() => {
                            if (route.view === "memories") {
                              setAssets(c.assets || []);
                              setViewer(0);
                            } else
                              navigate(
                                route.view === "albums" ? "album" : "person",
                                c.id,
                                c.albumName || c.name || "Unnamed person",
                              );
                          }}
                        >
                          {id ? (
                            <img
                              loading="lazy"
                              src={
                                route.view === "people"
                                  ? immich + "/people/" + id + "/thumbnail"
                                  : thumb(id)
                              }
                              alt=""
                            />
                          ) : (
                            <div className="collection-placeholder">
                              <Icon name="album" size={38} />
                            </div>
                          )}
                          <h2>
                            {c.albumName ||
                              c.name ||
                              c.data?.title ||
                              (route.view === "memories"
                                ? date(c.memoryAt)
                                : "Unnamed person")}
                          </h2>
                          <p>
                            {route.view === "people"
                              ? "View photos"
                              : route.view === "memories"
                                ? `${c.assets?.length || 0} memories`
                                : `${c.assetCount} items${c.shared ? " · Shared" : ""}`}
                          </p>
                        </button>
                        {route.view === "people" && (
                          <Button
                            icon="edit"
                            title="Name this person"
                            onClick={() => {
                              setModalError("");
                              setModal("person:" + c.id);
                            }}
                          />
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
              {["albums", "memories", "people"].includes(route.view) &&
                !collections.length &&
                !loading &&
                !error && (
                  <Empty
                    icon={route.view === "people" ? "users" : "album"}
                    title={
                      route.view === "albums"
                        ? "Your next story starts with an album"
                        : route.view === "people"
                          ? "No people found yet"
                          : "No memories yet"
                    }
                  >
                    {route.view === "albums"
                      ? "Create an album, then select photos to add to it."
                      : "Immich will populate this view as it processes your library."}
                  </Empty>
                )}
              {route.view === "places" && (
                <Places
                  open={async (id) => {
                    try {
                      setAssets([await photo("/assets/" + id)]);
                      setViewer(0);
                    } catch (e: any) {
                      notify(e.message);
                    }
                  }}
                />
              )}
              {route.view === "sharing" && (
                <div className="share-list">
                  {collections.map((c) => (
                    <div className="share-row" key={c.id}>
                      <Icon name="link" size={24} />
                      <div className="grow">
                        <b>
                          {c.description ||
                            c.album?.albumName ||
                            "Shared photos"}
                        </b>
                        <p className="muted">
                          {c.expiresAt
                            ? "Expires " + date(c.expiresAt)
                            : "No expiry"}{" "}
                          ·{" "}
                          {c.password
                            ? "Password protected"
                            : "Anyone with the link"}{" "}
                          ·{" "}
                          {c.allowDownload
                            ? "Downloads enabled"
                            : "Viewing only"}
                        </p>
                        {shareLink(c) && (
                          <a
                            href={shareLink(c)}
                            target="_blank"
                            rel="noreferrer"
                          >
                            Open shared link ↗
                          </a>
                        )}
                      </div>
                      <Button
                        icon="copy"
                        title="Copy link"
                        disabled={!shareLink(c)}
                        onClick={() =>
                          navigator.clipboard
                            .writeText(shareLink(c))
                            .then(() => notify("Link copied"))
                            .catch(() =>
                              notify(
                                "Open the link to copy it from your browser",
                              ),
                            )
                        }
                      />
                      <Button
                        icon="trash"
                        title="Revoke shared link"
                        onClick={() => setModal("revoke:" + c.id)}
                      />
                    </div>
                  ))}
                  {!collections.length && !loading && !error && (
                    <Empty icon="link" title="Keep a moment. Share a story.">
                      Select photos or open an album to create a sharing link.
                    </Empty>
                  )}
                </div>
              )}
              {error && <ErrorBox message={error} retry={() => load()} />}{" "}
              {loading && (
                <div className="loading" role="status">
                  <span className="spinner" />
                  Loading your moments…
                </div>
              )}
              {next && !loading && (
                <div className="load-more">
                  <Button onClick={() => load(next)}>Load more</Button>
                </div>
              )}
            </>
          )}
        </div>
      </main>
      {toast && (
        <div role="status" className="toast">
          <Icon name="check-circle" size={18} />
          {toast}
        </div>
      )}
      {viewer !== null && assets[viewer] && (
        <Viewer
          assets={assets}
          index={viewer}
          setIndex={setViewer}
          close={() => setViewer(null)}
          updated={(a) =>
            setAssets((old) => old.map((x) => (x.id === a.id ? a : x)))
          }
          removed={() => {
            setViewer(null);
            reload();
          }}
          notify={notify}
        />
      )}
      {files.length > 0 && (
        <UploadQueue files={files} close={() => setFiles([])} done={reload} />
      )}
      {modal && (
        <Modal
          title={
            modal === "shortcuts"
              ? "Keyboard shortcuts"
              : modal === "new-album"
                ? "Create an album"
                : modal === "rename-album"
                  ? "Rename album"
                  : modal === "add-album"
                    ? "Add to album"
                    : modal === "share"
                      ? "Share these moments"
                      : modal.startsWith("person:")
                        ? "Name this person"
                        : modal.startsWith("revoke:")
                          ? "Revoke this link?"
                          : modal === "delete-album"
                            ? "Delete album?"
                            : modal === "trash"
                              ? "Move to recently deleted?"
                              : "Delete these photos forever?"
          }
          close={() => {
            if (!busy) setModal(null);
          }}
        >
          {modalError && <ErrorBox message={modalError} />}
          {modal === "shortcuts" ? (
            <div className="shortcut-list">
              {[
                ["/", "Search photos"],
                ["U", "Upload photos"],
                ["← / →", "Previous / next photo"],
                ["F", "Favorite in viewer"],
                ["I", "Photo information"],
                ["Esc", "Close viewer or clear selection"],
                ["Ctrl / ⌘ A", "Select loaded photos"],
              ].map(([k, v]) => (
                <div key={k}>
                  <kbd>{k}</kbd>
                  <span>{v}</span>
                </div>
              ))}
            </div>
          ) : modal === "add-album" ? (
            <div className="album-picker">
              {albums.map((a) => (
                <Button
                  key={a.id}
                  icon="album"
                  disabled={busy}
                  onClick={() => addAlbum(a.id)}
                >
                  {a.albumName}
                </Button>
              ))}
              {!albums.length && <p>No albums yet.</p>}
              <Button icon="plus" onClick={() => setModal("new-album")}>
                Create a new album
              </Button>
            </div>
          ) : ["new-album", "rename-album"].includes(modal) ||
            modal.startsWith("person:") ? (
            <form
              className="stack"
              onSubmit={async (e) => {
                e.preventDefault();
                setBusy(true);
                setModalError("");
                const f = new FormData(e.currentTarget);
                try {
                  const name = String(f.get("name"));
                  if (modal.startsWith("person:"))
                    await photo("/people/" + modal.split(":")[1], "PUT", {
                      name,
                    });
                  else if (modal === "rename-album") {
                    await photo("/albums/" + route.id, "PATCH", {
                      albumName: name,
                    });
                    navigate("album", route.id, name);
                  } else {
                    const a = await photo("/albums", "POST", {
                      albumName: name,
                      description: String(f.get("description") || ""),
                      assetIds: [...selected],
                    });
                    navigate("album", a.id, a.albumName);
                  }
                  setModal(null);
                  reload();
                  notify("Saved");
                } catch (e: any) {
                  setModalError(e.message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              <label>
                Name
                <input
                  name="name"
                  required
                  maxLength={200}
                  defaultValue={modal === "rename-album" ? route.name : ""}
                  autoFocus
                />
              </label>
              {modal === "new-album" && (
                <label>
                  Description
                  <textarea name="description" rows={3} />
                </label>
              )}
              <Button primary type="submit" disabled={busy}>
                {busy ? "Saving…" : "Save"}
              </Button>
            </form>
          ) : modal === "share" ? (
            shareURL ? (
              <div className="stack">
                <p>Your link is ready.</p>
                <input
                  readOnly
                  value={shareURL}
                  aria-label="Share link"
                  onFocus={(e) => e.target.select()}
                />
                <Button
                  primary
                  icon="copy"
                  onClick={() =>
                    navigator.clipboard
                      .writeText(shareURL)
                      .then(() => notify("Link copied"))
                      .catch(() =>
                        setModalError("Select the link and copy it manually."),
                      )
                  }
                >
                  Copy link
                </Button>
                <a href={shareURL} target="_blank" rel="noreferrer">
                  Open shared album ↗
                </a>
              </div>
            ) : (
              <form
                className="stack"
                onSubmit={async (e) => {
                  e.preventDefault();
                  if (!connection.public_url) {
                    setModalError(
                      "Set IMMICH_PUBLIC_URL on the server so recipients can open the link.",
                    );
                    return;
                  }
                  setBusy(true);
                  setModalError("");
                  const f = new FormData(e.currentTarget);
                  try {
                    const days = Number(f.get("expiry"));
                    const v = await photo("/shared-links", "POST", {
                      type: route.view === "album" ? "ALBUM" : "INDIVIDUAL",
                      ...(route.view === "album"
                        ? { albumId: route.id }
                        : { assetIds: [...selected] }),
                      description: String(f.get("description")),
                      password: String(f.get("password")) || null,
                      expiresAt: days
                        ? new Date(Date.now() + days * 86400000).toISOString()
                        : null,
                      allowDownload: f.get("download") === "on",
                      allowUpload: false,
                      showMetadata: f.get("metadata") === "on",
                    });
                    setShareURL(shareLink(v));
                    reload();
                  } catch (e: any) {
                    setModalError(e.message);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                <p>Recipients open this link on your Immich server.</p>
                <label>
                  Label
                  <input
                    name="description"
                    placeholder="A weekend to remember"
                  />
                </label>
                <label>
                  Expires
                  <select name="expiry" defaultValue="7">
                    <option value="1">In 24 hours</option>
                    <option value="7">In 7 days</option>
                    <option value="30">In 30 days</option>
                    <option value="0">Never</option>
                  </select>
                </label>
                <label>
                  Password (optional)
                  <input
                    name="password"
                    type="password"
                    autoComplete="new-password"
                  />
                </label>
                <label className="check-label">
                  <input name="download" type="checkbox" defaultChecked />
                  Allow downloads
                </label>
                <label className="check-label">
                  <input name="metadata" type="checkbox" />
                  Include photo metadata and locations
                </label>
                <Button primary type="submit" disabled={busy}>
                  {busy ? "Creating…" : "Create link"}
                </Button>
              </form>
            )
          ) : (
            <div className="stack">
              <p>
                {modal === "trash"
                  ? "You can restore them from Recently deleted."
                  : modal === "delete-album"
                    ? "The album will be removed. Your photos stay in the library."
                    : modal.startsWith("revoke:")
                      ? "Anyone with this link will lose access."
                      : "The selected originals will be permanently removed from Immich. This cannot be undone."}
              </p>
              <div className="dialog-actions">
                <Button onClick={() => setModal(null)} disabled={busy}>
                  Cancel
                </Button>
                <Button
                  danger
                  disabled={busy}
                  onClick={async () => {
                    if (modal === "trash" || modal === "delete") {
                      await mutate(modal);
                      return;
                    }
                    setBusy(true);
                    try {
                      await photo(
                        modal === "delete-album"
                          ? "/albums/" + route.id
                          : "/shared-links/" + modal.split(":")[1],
                        "DELETE",
                      );
                      setModal(null);
                      if (modal === "delete-album") navigate("albums");
                      reload();
                    } catch (e: any) {
                      setModalError(e.message);
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  {busy
                    ? "Working…"
                    : modal === "trash"
                      ? "Move to trash"
                      : modal.startsWith("revoke:")
                        ? "Revoke link"
                        : "Delete"}
                </Button>
              </div>
            </div>
          )}
        </Modal>
      )}
    </div>
  );
}
