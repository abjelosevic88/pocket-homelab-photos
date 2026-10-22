import { useEffect, useRef, useState } from "react";
import { immich, bytes } from "./lib/api";
import { Button } from "./components/ui";
type Item = {
  file: File;
  state: "queued" | "uploading" | "done" | "error" | "duplicate" | "cancelled";
  progress: number;
  error?: string;
};
export function UploadQueue({
  files,
  close,
  done,
}: {
  files: File[];
  close: () => void;
  done: () => void;
}) {
  const [items, setItems] = useState<Item[]>([]),
    [minimized, setMinimized] = useState(false);
  const seen = useRef(0),
    running = useRef(false),
    itemsRef = useRef<Item[]>([]),
    xhr = useRef<XMLHttpRequest | null>(null),
    alive = useRef(true);
  const update = (index: number, v: Partial<Item>) => {
    itemsRef.current = itemsRef.current.map((x, i) =>
      i === index ? { ...x, ...v } : x,
    );
    if (alive.current) setItems([...itemsRef.current]);
  };
  useEffect(
    () => () => {
      alive.current = false;
      xhr.current?.abort();
    },
    [],
  );
  useEffect(() => {
    const added = files
      .slice(seen.current)
      .map((file) => ({ file, state: "queued" as const, progress: 0 }));
    seen.current = files.length;
    itemsRef.current = [...itemsRef.current, ...added];
    setItems([...itemsRef.current]);
    run();
  }, [files]);
  async function run() {
    if (running.current) return;
    running.current = true;
    let changed = false;
    while (alive.current) {
      const i = itemsRef.current.findIndex((x) => x.state === "queued");
      if (i < 0) break;
      const f = itemsRef.current[i].file;
      if (f.size > 20 * 1024 ** 3) {
        update(i, {
          state: "error",
          error: "Files must be smaller than 20 GB",
        });
        continue;
      }
      update(i, { state: "uploading" });
      await new Promise<void>((resolve) => {
        const x = new XMLHttpRequest();
        xhr.current = x;
        x.open("POST", immich + "/assets");
        x.upload.onprogress = (e) => {
          if (e.lengthComputable)
            update(i, { progress: Math.round((e.loaded / e.total) * 100) });
        };
        x.onerror = () => {
          update(i, {
            state: "error",
            error: "Connection interrupted. Try again.",
          });
          resolve();
        };
        x.onabort = () => {
          update(i, { state: "cancelled" });
          resolve();
        };
        x.onload = () => {
          let v: any;
          try {
            v = JSON.parse(x.responseText);
          } catch {}
          if (x.status >= 200 && x.status < 300) {
            changed = true;
            update(i, {
              state: v?.status === "duplicate" ? "duplicate" : "done",
              progress: 100,
            });
          } else
            update(i, {
              state: "error",
              error: Array.isArray(v?.message)
                ? v.message.join(", ")
                : v?.message || v?.error || "Upload failed",
            });
          resolve();
        };
        const form = new FormData();
        form.append("assetData", f, f.name);
        form.append("fileCreatedAt", new Date(f.lastModified).toISOString());
        form.append("fileModifiedAt", new Date(f.lastModified).toISOString());
        x.send(form);
      });
    }
    running.current = false;
    if (changed && alive.current) done();
  }
  const active = items.some(
    (x) => x.state === "queued" || x.state === "uploading",
  );
  return (
    <aside className="upload-panel" aria-label="Upload progress">
      <header>
        <b>
          {active ? "Uploading photos" : "Uploads"} ·{" "}
          {items.filter((x) => ["done", "duplicate"].includes(x.state)).length}/
          {items.length}
        </b>
        <Button
          icon={minimized ? "chevron-up" : "chevron-down"}
          title="Toggle upload details"
          onClick={() => setMinimized(!minimized)}
        />
        <Button
          icon="x"
          title={active ? "Cancel uploads" : "Close uploads"}
          onClick={() => {
            if (active) {
              itemsRef.current = itemsRef.current.map((x) =>
                x.state === "queued" ? { ...x, state: "cancelled" } : x,
              );
              setItems([...itemsRef.current]);
              xhr.current?.abort();
            } else close();
          }}
        />
      </header>
      {!minimized && (
        <div className="upload-items">
          {items.map((x, i) => (
            <div className="upload-item" key={i}>
              <div>
                <b>{x.file.name}</b>
                <small>
                  {bytes(x.file.size)} ·{" "}
                  {x.state === "duplicate"
                    ? "Already in your library"
                    : x.state === "done"
                      ? "Uploaded"
                      : x.state === "uploading"
                        ? x.progress + "%"
                        : x.state}
                </small>
                {x.error && <span className="upload-error">{x.error}</span>}
              </div>
              {["error", "cancelled"].includes(x.state) && (
                <Button
                  onClick={() => {
                    update(i, { state: "queued", error: "" });
                    run();
                  }}
                >
                  Retry
                </Button>
              )}
              {x.state === "uploading" && (
                <progress
                  value={x.progress}
                  max="100"
                  aria-label={x.file.name}
                />
              )}
            </div>
          ))}
        </div>
      )}
    </aside>
  );
}
