export const base = "/api/v1";
export const immich = base + "/immich";
export async function api<T = any>(
  path: string,
  method = "GET",
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const r = await fetch(base + path, {
    method,
    signal,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) {
    let v: any;
    try {
      v = await r.json();
    } catch {}
    throw new Error(
      Array.isArray(v?.message)
        ? v.message.join(", ")
        : v?.error || v?.message || `Request failed (${r.status})`,
    );
  }
  if (r.status === 204 || r.headers.get("content-length") === "0")
    return undefined as T;
  const text = await r.text();
  return text ? JSON.parse(text) : (undefined as T);
}
export const photo = (
  path: string,
  method = "GET",
  body?: unknown,
  signal?: AbortSignal,
) => api("/immich" + path, method, body, signal);
export type Asset = {
  id: string;
  type: string;
  originalFileName: string;
  fileCreatedAt: string;
  localDateTime?: string;
  isFavorite: boolean;
  isTrashed: boolean;
  visibility: string;
  duration?: number;
  isEdited?: boolean;
  width?: number;
  height?: number;
  livePhotoVideoId?: string;
  exifInfo?: Record<string, any>;
  people?: { id: string; name: string }[];
  thumbhash?: string;
};
export const thumb = (a: Asset | string, size = "thumbnail") =>
  `${immich}/assets/${typeof a === "string" ? a : a.id}/thumbnail?size=${size}&edited=true${typeof a === "string" ? "" : "&c=" + encodeURIComponent(a.thumbhash || "")}`;
export function bytes(n: number) {
  if (!n) return "0 B";
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), 4);
  return (
    (n / 1024 ** i).toFixed(i ? 1 : 0) + " " + ["B", "KB", "MB", "GB", "TB"][i]
  );
}
export const date = (s: string) =>
  s
    ? new Date(s).toLocaleDateString(undefined, {
        day: "numeric",
        month: "long",
        year: "numeric",
      })
    : "Unknown date";
