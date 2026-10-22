import { useEffect, useState, useRef } from "react";
import { photo, thumb, immich, date, bytes, type Asset } from "./lib/api";
import { Button, ErrorBox } from "./components/ui";
import { Icon } from "./components/icons";
export function Viewer({
  assets,
  index,
  setIndex,
  close,
  updated,
  removed,
  notify,
}: {
  assets: Asset[];
  index: number;
  setIndex: (n: number) => void;
  close: () => void;
  updated: (a: Asset) => void;
  removed: () => void;
  notify: (s: string) => void;
}) {
  const asset = assets[index];
  const [detail, setDetail] = useState<Asset>(asset),
    [info, setInfo] = useState(false),
    [editing, setEditing] = useState(false),
    [zoom, setZoom] = useState(false),
    [slide, setSlide] = useState(false),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [confirm, setConfirm] = useState(false),
    [angle, setAngle] = useState(0),
    [mirror, setMirror] = useState(false),
    [crop, setCrop] = useState(0),
    [imageVersion, setImageVersion] = useState(0),
    [live, setLive] = useState(false);
  const ref = useRef<HTMLDivElement>(null),
    touch = useRef(0);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  useEffect(() => {
    let active = true;
    setDetail(asset);
    setEditing(false);
    setConfirm(false);
    setZoom(false);
    setError("");
    setLive(false);
    photo("/assets/" + asset.id)
      .then((a) => {
        if (active) setDetail(a);
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [asset.id]);
  useEffect(() => {
    if (!slide) return;
    const t = setInterval(() => setIndex((index + 1) % assets.length), 5000);
    return () => clearInterval(t);
  }, [slide, index, assets.length]);
  async function update(v: Record<string, unknown>) {
    setBusy(true);
    try {
      const a = await photo("/assets/" + asset.id, "PUT", v);
      setDetail(a);
      updated(a);
      return true;
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest("input,textarea,select")) return;
      if (e.key === "Escape") {
        e.stopPropagation();
        if (editing) setEditing(false);
        else if (confirm) setConfirm(false);
        else close();
      }
      if (e.key === "ArrowRight" && !editing)
        setIndex(Math.min(index + 1, assets.length - 1));
      if (e.key === "ArrowLeft" && !editing) setIndex(Math.max(index - 1, 0));
      if (e.key === "i") setInfo((v) => !v);
      if (e.key === "f" && !busy) update({ isFavorite: !detail.isFavorite });
      if (e.key === "Tab") {
        const all = ref.current?.querySelectorAll<HTMLElement>(
          "button:not(:disabled),input,textarea,select,a[href]",
        );
        if (!all?.length) return;
        const first = all[0],
          last = all[all.length - 1];
        if (
          e.shiftKey &&
          (document.activeElement === first ||
            document.activeElement === ref.current)
        ) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [index, detail, editing, confirm, busy]);
  const ex = detail.exifInfo || {},
    original = immich + "/assets/" + asset.id + "/original";
  return (
    <div
      className="viewer"
      role="dialog"
      aria-modal="true"
      aria-label="Photo viewer"
      ref={ref}
      tabIndex={-1}
    >
      <header className="viewer-header">
        <Button icon="x" title="Close viewer" onClick={close} />
        <div className="viewer-title">
          <b>{detail.originalFileName || "Photo"}</b>
          <small>
            {date(detail.fileCreatedAt)} · {index + 1} of {assets.length}
          </small>
        </div>
        <div className="spacer" />
        <Button
          icon="heart"
          title={
            detail.isFavorite ? "Remove from favorites" : "Add to favorites"
          }
          disabled={busy}
          onClick={() => update({ isFavorite: !detail.isFavorite })}
        />
        <Button
          icon="info"
          title="Show photo information"
          onClick={() => setInfo(!info)}
        />
        <Button
          icon="edit"
          title="Edit photo"
          disabled={asset.type === "VIDEO" || detail.isTrashed}
          onClick={() => {
            setEditing(!editing);
            setAngle(0);
            setMirror(false);
            setCrop(0);
          }}
        />
        <Button
          icon={slide ? "pause" : "play"}
          title={slide ? "Stop slideshow" : "Start slideshow"}
          onClick={() => setSlide(!slide)}
        />
        <a
          className="btn ghost icon-only"
          href={original}
          download={detail.originalFileName}
          title="Download original"
          aria-label="Download original"
        >
          <Icon name="download" size={18} />
        </a>
        <Button
          icon="trash"
          title={
            detail.isTrashed ? "Delete permanently" : "Move to recently deleted"
          }
          onClick={() => setConfirm(true)}
        />
      </header>
      {error && <ErrorBox message={error} retry={() => setError("")} />}
      <div className="viewer-body">
        <div
          className={"viewer-stage " + (zoom ? "zoom" : "")}
          onTouchStart={(e) => (touch.current = e.touches[0].clientX)}
          onTouchEnd={(e) => {
            const delta = e.changedTouches[0].clientX - touch.current;
            if (Math.abs(delta) > 70 && !editing && !zoom)
              setIndex(
                Math.max(
                  0,
                  Math.min(assets.length - 1, index + (delta < 0 ? 1 : -1)),
                ),
              );
          }}
        >
          {!editing && (
            <button
              className="viewer-prev"
              aria-label="Previous photo"
              disabled={index === 0}
              onClick={() => setIndex(index - 1)}
            >
              <Icon name="chevron-left" size={28} />
            </button>
          )}
          {asset.type === "VIDEO" || live ? (
            <video
              key={asset.id + String(live)}
              src={
                immich +
                "/assets/" +
                (live ? detail.livePhotoVideoId : asset.id) +
                "/video/playback"
              }
              controls
              autoPlay
              playsInline
              onError={() =>
                setError(
                  "This video could not be played. Try downloading the original.",
                )
              }
            />
          ) : (
            <div className="viewer-image-wrap">
              <img
                key={asset.id + imageVersion}
                className={editing ? "editing" : ""}
                src={
                  thumb(detail, "preview").replace(
                    "edited=true",
                    "edited=" + !editing,
                  ) +
                  "&v=" +
                  imageVersion
                }
                alt={ex.description || detail.originalFileName || "Photo"}
                onDoubleClick={() => setZoom(!zoom)}
                style={{
                  transform: editing
                    ? `scaleX(${mirror ? -1 : 1}) rotate(${angle}deg)`
                    : undefined,
                  clipPath: editing && crop ? `inset(${crop}%)` : undefined,
                }}
                onError={() =>
                  setError(
                    "The preview is unavailable. The original may still be downloadable.",
                  )
                }
              />
            </div>
          )}
          {!editing && (
            <button
              className="viewer-next"
              aria-label="Next photo"
              disabled={index === assets.length - 1}
              onClick={() => setIndex(index + 1)}
            >
              <Icon name="chevron-right" size={28} />
            </button>
          )}
          {detail.livePhotoVideoId && !editing && (
            <Button icon="play" onClick={() => setLive(!live)}>
              {live ? "Still photo" : "Play Live Photo"}
            </Button>
          )}
          {!editing && asset.type !== "VIDEO" && (
            <div className="viewer-bottom">
              <Button
                icon="search"
                title={zoom ? "Fit photo" : "Zoom photo"}
                onClick={() => setZoom(!zoom)}
              />
              <Button
                icon="fullscreen"
                title="Full screen"
                onClick={() => {
                  if (document.fullscreenElement) document.exitFullscreen();
                  else ref.current?.requestFullscreen().catch(() => {});
                }}
              />
            </div>
          )}
        </div>
        {info && !editing && (
          <aside className="photo-info">
            <h2>Photo details</h2>
            <form
              className="stack"
              onSubmit={(e) => {
                e.preventDefault();
                update({
                  description: String(
                    new FormData(e.currentTarget).get("description"),
                  ),
                }).then((ok) => {
                  if (ok) notify("Description saved");
                });
              }}
              key={asset.id + "-description"}
            >
              <label>
                Description
                <textarea
                  name="description"
                  defaultValue={ex.description || ""}
                  placeholder="Add a little context…"
                  rows={3}
                />
              </label>
              <Button type="submit" disabled={busy}>
                Save description
              </Button>
            </form>
            <dl>
              <dt>Taken</dt>
              <dd>
                {date(detail.fileCreatedAt)}
                <br />
                {new Date(detail.fileCreatedAt).toLocaleTimeString()}
              </dd>
              <dt>File</dt>
              <dd>
                {detail.originalFileName}
                <br />
                {bytes(ex.fileSizeInByte || 0)} ·{" "}
                {detail.width || ex.exifImageWidth} ×{" "}
                {detail.height || ex.exifImageHeight}
              </dd>
              {(ex.make || ex.model) && (
                <>
                  <dt>Camera</dt>
                  <dd>
                    {ex.make} {ex.model}
                    <br />
                    {ex.lensModel}
                  </dd>
                </>
              )}
              {(ex.fNumber || ex.iso) && (
                <>
                  <dt>Exposure</dt>
                  <dd>
                    {ex.fNumber ? "ƒ/" + ex.fNumber + " · " : ""}
                    {ex.exposureTime || ""}
                    {ex.iso ? " · ISO " + ex.iso : ""}
                  </dd>
                </>
              )}
              {ex.city && (
                <>
                  <dt>Location</dt>
                  <dd>
                    {[ex.city, ex.state, ex.country].filter(Boolean).join(", ")}
                  </dd>
                </>
              )}
              {ex.latitude != null && ex.longitude != null && (
                <>
                  <dt>Coordinates</dt>
                  <dd>
                    <a
                      target="_blank"
                      rel="noreferrer"
                      href={`https://www.openstreetmap.org/?mlat=${ex.latitude}&mlon=${ex.longitude}#map=14/${ex.latitude}/${ex.longitude}`}
                    >
                      {ex.latitude.toFixed(4)}, {ex.longitude.toFixed(4)} ↗
                    </a>
                  </dd>
                </>
              )}
            </dl>
            <label>
              Rating
              <select
                value={ex.rating || ""}
                disabled={busy}
                onChange={(e) =>
                  update({ rating: e.target.value ? +e.target.value : null })
                }
              >
                <option value="">Unrated</option>
                {[1, 2, 3, 4, 5].map((n) => (
                  <option key={n} value={n}>
                    {"★".repeat(n)}
                  </option>
                ))}
              </select>
            </label>
            {detail.people?.length ? (
              <div className="detail-people">
                <h3>People</h3>
                {detail.people.map((p) => (
                  <span key={p.id}>{p.name || "Unnamed person"}</span>
                ))}
              </div>
            ) : null}
            <Button
              icon="archive"
              disabled={busy}
              onClick={() =>
                update({
                  visibility:
                    detail.visibility === "archive" ? "timeline" : "archive",
                })
              }
            >
              {detail.visibility === "archive"
                ? "Move to library"
                : "Archive photo"}
            </Button>
            {detail.isTrashed && (
              <Button
                icon="repeat"
                disabled={busy}
                onClick={async () => {
                  try {
                    await photo("/trash/restore/assets", "POST", {
                      ids: [asset.id],
                    });
                    removed();
                  } catch (e: any) {
                    setError(e.message);
                  }
                }}
              >
                Restore photo
              </Button>
            )}
          </aside>
        )}
      </div>
      {editing && (
        <div className="edit-toolbar">
          <div>
            <b>Edit photo</b>
            <small>
              Your original stays safe. Saving replaces earlier edits.
            </small>
          </div>
          <Button icon="rotate" onClick={() => setAngle((angle + 90) % 360)}>
            Rotate
          </Button>
          <Button icon="flip" onClick={() => setMirror(!mirror)}>
            Mirror
          </Button>
          <label>
            Crop edges{" "}
            <input
              type="range"
              min="0"
              max="40"
              value={crop}
              onChange={(e) => setCrop(+e.target.value)}
            />
            <span>{crop}%</span>
          </label>
          <Button
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await photo("/assets/" + asset.id + "/edits", "DELETE");
                setImageVersion((v) => v + 1);
                setEditing(false);
                notify("Original restored");
              } catch (e: any) {
                setError(e.message);
              } finally {
                setBusy(false);
              }
            }}
          >
            Revert original
          </Button>
          <Button onClick={() => setEditing(false)}>Cancel</Button>
          <Button
            primary
            disabled={busy || (!angle && !mirror && !crop)}
            onClick={async () => {
              setBusy(true);
              try {
                const edits: {
                  action: string;
                  parameters: Record<string, number | string>;
                }[] = [];
                if (crop) {
                  const w = detail.width || ex.exifImageWidth,
                    h = detail.height || ex.exifImageHeight;
                  if (!w || !h)
                    throw new Error(
                      "Photo dimensions are not available for cropping",
                    );
                  edits.push({
                    action: "crop",
                    parameters: {
                      x: Math.floor((w * crop) / 100),
                      y: Math.floor((h * crop) / 100),
                      width: Math.floor(w * (1 - crop / 50)),
                      height: Math.floor(h * (1 - crop / 50)),
                    },
                  });
                }
                if (angle)
                  edits.push({ action: "rotate", parameters: { angle } });
                if (mirror)
                  edits.push({
                    action: "mirror",
                    parameters: { axis: "horizontal" },
                  });
                await photo("/assets/" + asset.id + "/edits", "PUT", { edits });
                setEditing(false);
                setImageVersion((v) => v + 1);
                notify("Edits saved. Immich is generating the new preview.");
              } catch (e: any) {
                setError(e.message);
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? "Saving…" : "Save edits"}
          </Button>
        </div>
      )}
      {confirm && (
        <div
          className="viewer-confirm"
          role="alertdialog"
          aria-label="Confirm deletion"
        >
          <h2>
            {detail.isTrashed
              ? "Permanently delete this photo?"
              : "Move this photo to recently deleted?"}
          </h2>
          <p>
            {detail.isTrashed
              ? "The original will be permanently removed from Immich. This cannot be undone."
              : "You can restore it from Recently deleted."}
          </p>
          <div className="row">
            <Button onClick={() => setConfirm(false)} disabled={busy}>
              Cancel
            </Button>
            <Button
              danger
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await photo("/assets", "DELETE", {
                    ids: [asset.id],
                    force: !!detail.isTrashed,
                  });
                  removed();
                } catch (e: any) {
                  setError(e.message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy
                ? "Working…"
                : detail.isTrashed
                  ? "Delete forever"
                  : "Move to trash"}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
