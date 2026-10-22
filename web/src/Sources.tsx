import { useEffect, useRef, useState } from "react";
import { api, base, bytes } from "./lib/api";
import { Button, Empty, ErrorBox, Modal } from "./components/ui";
import { Icon } from "./components/icons";
type Entry = {
  id?: number;
  name: string;
  path: string;
  is_dir?: boolean;
  size?: number;
  mime?: string;
  modified?: string;
  title?: string;
  original_filename?: string;
};
export function Sources({
  connected,
  notify,
}: {
  connected: boolean;
  notify: (s: string) => void;
}) {
  const [source, setSource] = useState("files"),
    [spaces, setSpaces] = useState<any[]>([]),
    [space, setSpace] = useState("home"),
    [path, setPath] = useState("/"),
    [entries, setEntries] = useState<Entry[]>([]),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(false),
    [partial, setPartial] = useState(false),
    [selected, setSelected] = useState<Set<string>>(new Set()),
    [preview, setPreview] = useState<Entry | null>(null),
    [importing, setImporting] = useState(false),
    [progress, setProgress] = useState(""),
    [results, setResults] = useState<{ name: string; status: string }[]>([]),
    [q, setQ] = useState(""),
    [search, setSearch] = useState(""),
    [offset, setOffset] = useState(0),
    [count, setCount] = useState(0);
  const stop = useRef(false);
  const key = (e: Entry) => (source === "files" ? e.path : String(e.id));
  const media = (e: Entry) =>
    e.mime?.startsWith("image/") ||
    e.mime?.startsWith("video/") ||
    /\.(heic|heif|dng|cr2|cr3|nef|arw|raf|jpe?g|png|webp|gif|mp4|mov|mkv)$/i.test(
      e.name,
    );
  const sourceURL = (p: string) => "/sources/" + source + p;
  const raw = (e: Entry) =>
    base +
    sourceURL(
      source === "files"
        ? "/fs/raw?" + new URLSearchParams({ space, path: e.path })
        : "/documents/" + e.id + "/download?original=1&inline=1",
    );
  const thumbnail = (e: Entry) =>
    base +
    sourceURL(
      source === "files"
        ? "/fs/thumb?" +
            new URLSearchParams({ space, path: e.path, size: "400" })
        : "/documents/" + e.id + "/thumb",
    );
  async function load(signal?: AbortSignal) {
    setLoading(true);
    setError("");
    setPartial(false);
    try {
      if (source === "files") {
        const s = await api("/sources/files/spaces", "GET", undefined, signal);
        setSpaces(s);
        const v = await api(
          sourceURL(
            (search ? "/fs/search?" : "/fs/list?") +
              new URLSearchParams({ space, path, q: search }),
          ),
          "GET",
          undefined,
          signal,
        );
        setPartial(!!v.partial);
        setEntries(
          (Array.isArray(v) ? v : v.entries || []).filter(
            (e: Entry) => e.is_dir || media(e),
          ),
        );
      } else {
        const v = await api(
          sourceURL("/documents?") +
            new URLSearchParams({
              mime: "image/",
              q: search,
              limit: "60",
              offset: String(offset),
            }),
          "GET",
          undefined,
          signal,
        );
        setEntries(
          (v.results || [])
            .map((e: any) => ({
              ...e,
              name: e.original_name || e.original_filename || e.title,
              size: e.size || e.file_size,
              modified: e.created ? e.created + "T12:00:00Z" : e.modified_at,
              path: String(e.id),
            }))
            .filter(media),
        );
        setCount(v.count || 0);
      }
    } catch (e: any) {
      if (e.name !== "AbortError") setError(e.message);
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }
  useEffect(() => {
    const c = new AbortController();
    setSelected(new Set());
    setEntries([]);
    load(c.signal);
    return () => c.abort();
  }, [source, space, path, search, offset]);
  async function runImport() {
    setImporting(true);
    stop.current = false;
    const list = entries.filter((e) => selected.has(key(e)) && !e.is_dir);
    const all: { name: string; status: string }[] = [];
    for (let i = 0; i < list.length; i++) {
      if (stop.current) break;
      const e = list[i];
      setProgress(`${i + 1} of ${list.length} · ${e.name}`);
      try {
        const r = await api(sourceURL("/import"), "POST", {
          space,
          path: e.path,
          id: e.id,
          name: e.name,
          modified: e.modified,
        });
        all.push({
          name: e.name,
          status:
            r?.status === "duplicate" ? "Already in your library" : "Imported",
        });
      } catch (err: any) {
        all.push({ name: e.name, status: err.message });
      }
      setResults([...all]);
    }
    setProgress("");
    setImporting(false);
    setSelected(new Set());
    notify("Import finished. Source originals are unchanged.");
  }
  return (
    <div className="sources">
      <div className="source-cards">
        {[
          [
            "files",
            "folder",
            "Pocket Files",
            "Your home folder, shared files and mounted storage.",
          ],
          [
            "documents",
            "file",
            "Pocket Documents",
            "Images and scanned photos in your document archive.",
          ],
        ].map(([id, icon, title, desc]) => (
          <button
            disabled={importing}
            key={id}
            className={"source-card " + (source === id ? "active" : "")}
            onClick={() => {
              setSource(id);
              setPath("/");
              setSearch("");
              setQ("");
              setOffset(0);
            }}
          >
            <div className="source-icon">
              <Icon name={icon} size={24} />
            </div>
            <div>
              <h2>{title}</h2>
              <p>{desc}</p>
            </div>
            <Icon
              name={source === id ? "check-circle" : "chevron-right"}
              size={20}
            />
          </button>
        ))}
      </div>
      <div className="source-note">
        <Icon name="shield" size={17} />
        <span>
          Your Pocket Core access is used to browse. Import copies selected
          originals into Immich; source files stay in place.
        </span>
      </div>
      <div className="source-toolbar">
        {source === "files" && (
          <>
            <select
              aria-label="File location"
              value={space}
              disabled={importing}
              onChange={(e) => {
                setSpace(e.target.value);
                setPath("/");
              }}
            >
              {spaces.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
            <Button
              icon="chevron-left"
              title="Parent folder"
              disabled={path === "/" || importing}
              onClick={() => {
                setPath(path.split("/").slice(0, -1).join("/") || "/");
                setSearch("");
                setQ("");
              }}
            />
            <span className="source-path">{path}</span>
          </>
        )}
        <form
          className="source-search"
          onSubmit={(e) => {
            e.preventDefault();
            setSearch(q);
            setOffset(0);
          }}
        >
          <input
            aria-label="Search this source"
            placeholder="Search this source…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            disabled={importing}
          />
          <Button
            type="submit"
            icon="search"
            title="Search source"
            disabled={importing}
          />
        </form>
        <Button
          icon="refresh"
          title="Refresh source"
          onClick={() => load()}
          disabled={importing}
        />
      </div>
      {selected.size > 0 && (
        <div className="selection-bar">
          <Button
            icon="x"
            title="Clear source selection"
            disabled={importing}
            onClick={() => setSelected(new Set())}
          />
          <b>{selected.size} selected</b>
          <Button
            disabled={importing}
            onClick={() =>
              setSelected(new Set(entries.filter((e) => !e.is_dir).map(key)))
            }
          >
            Select all photos
          </Button>
          <div className="spacer" />
          <Button
            primary
            icon="download"
            disabled={!connected || importing}
            onClick={runImport}
          >
            Import to library
          </Button>
        </div>
      )}
      {!connected && (
        <p className="source-note">
          You can browse your sources now. Connect Immich in Settings to import
          photos into your library.
        </p>
      )}
      {error && <ErrorBox message={error} retry={() => load()} />}
      {partial && (
        <p className="source-note">
          This search reached the source limit. Narrow your search or open a
          smaller folder to see more results.
        </p>
      )}{" "}
      {loading && (
        <div className="loading">
          Opening {source === "files" ? "your files" : "your documents"}…
        </div>
      )}
      <div className="source-grid">
        {entries.map((e) => (
          <div
            className={
              "source-entry " + (selected.has(key(e)) ? "selected" : "")
            }
            key={key(e)}
          >
            {e.is_dir ? (
              <button
                className="folder-entry"
                disabled={importing}
                onClick={() => {
                  setPath(e.path);
                  setSearch("");
                  setQ("");
                }}
              >
                <Icon name="folder" size={32} />
                <b>{e.name}</b>
                <Icon name="chevron-right" size={18} />
              </button>
            ) : (
              <>
                <button
                  className="source-preview"
                  onClick={() => setPreview(e)}
                >
                  <img
                    loading="lazy"
                    src={thumbnail(e)}
                    alt={e.title || e.name}
                    onError={(ev) => {
                      ev.currentTarget.style.opacity = ".2";
                    }}
                  />
                  <span>{e.title || e.name}</span>
                </button>
                <label className="source-check">
                  <input
                    type="checkbox"
                    checked={selected.has(key(e))}
                    disabled={importing}
                    onChange={() =>
                      setSelected((old) => {
                        const n = new Set(old);
                        n.has(key(e)) ? n.delete(key(e)) : n.add(key(e));
                        return n;
                      })
                    }
                  />
                  <span>{bytes(e.size || 0)}</span>
                </label>
              </>
            )}
          </div>
        ))}
      </div>
      {!entries.length && !loading && !error && (
        <Empty icon="folder" title="No photos in this location">
          {source === "files"
            ? "Open another folder or choose another location."
            : "Image documents will appear here. PDFs and other documents stay in Pocket Documents."}
        </Empty>
      )}
      {source === "documents" && count > 60 && (
        <div className="pagination">
          <Button
            disabled={!offset || importing}
            onClick={() => setOffset(Math.max(0, offset - 60))}
          >
            Previous
          </Button>
          <span>
            {offset + 1}–{Math.min(offset + 60, count)} of {count}
          </span>
          <Button
            disabled={offset + 60 >= count || importing}
            onClick={() => setOffset(offset + 60)}
          >
            Next
          </Button>
        </div>
      )}
      {importing && (
        <div className="import-progress" role="status">
          <span className="spinner" />
          <b>Importing {progress}</b>
          <Button
            onClick={() => {
              stop.current = true;
            }}
          >
            Stop after this file
          </Button>
        </div>
      )}
      {results.length > 0 && (
        <div className="import-results">
          <h2>Import results</h2>
          {results.map((r, i) => (
            <div key={i}>
              <span>{r.name}</span>
              <b>{r.status}</b>
            </div>
          ))}
        </div>
      )}
      {preview && (
        <Modal
          wide
          title={preview.title || preview.name}
          close={() => setPreview(null)}
        >
          <div className="source-preview-large">
            {preview.mime?.startsWith("video/") ? (
              <video src={raw(preview)} controls autoPlay />
            ) : (
              <img src={raw(preview)} alt={preview.name} />
            )}
          </div>
          <div className="dialog-actions">
            <a
              className="btn ghost"
              href={raw(preview)}
              target="_blank"
              rel="noreferrer"
            >
              Open original ↗
            </a>
            <Button
              primary
              disabled={!connected || importing}
              onClick={() => {
                setSelected(new Set([key(preview)]));
                setPreview(null);
              }}
            >
              Select for import
            </Button>
          </div>
        </Modal>
      )}
    </div>
  );
}
