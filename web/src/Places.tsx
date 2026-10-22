import { useEffect, useMemo, useState } from "react";
import { land } from "./lib/world";
import { photo, thumb } from "./lib/api";
import { Empty, ErrorBox, Button } from "./components/ui";
export function Places({ open }: { open: (id: string) => void }) {
  const [markers, setMarkers] = useState<any[]>([]),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true),
    [selected, setSelected] = useState<string | null>(null);
  useEffect(() => {
    const c = new AbortController();
    photo("/map/markers", "GET", undefined, c.signal)
      .then(setMarkers)
      .catch((e) => {
        if (e.name !== "AbortError") setError(e.message);
      })
      .finally(() => setLoading(false));
    return () => c.abort();
  }, []);
  const groups = useMemo(() => {
    const g: Record<string, any[]> = {};
    for (const m of markers) {
      const k =
        [m.city, m.country].filter(Boolean).join(", ") ||
        `${m.lat.toFixed(2)}, ${m.lon.toFixed(2)}`;
      (g[k] ||= []).push(m);
    }
    return Object.entries(g).sort((a, b) => b[1].length - a[1].length);
  }, [markers]);
  return (
    <div className="places">
      {error && <ErrorBox message={error} />}
      <div className="places-map">
        <svg
          viewBox="0 0 1000 440"
          role="img"
          aria-label="Photo locations plotted by latitude and longitude"
        >
          <defs>
            <pattern
              id="grid"
              width="83.333"
              height="73.333"
              patternUnits="userSpaceOnUse"
            >
              <path
                d="M83.333 0H0V73.333"
                fill="none"
                stroke="currentColor"
                strokeWidth=".5"
              />
            </pattern>
          </defs>
          <rect width="1000" height="440" fill="url(#grid)" opacity=".2" />
          <path d={land} fill="currentColor" opacity=".14" />
          <path d="M0 220H1000M500 0V440" stroke="currentColor" opacity=".1" />
          {groups.map(([name, ms]) => (
            <g
              key={name}
              role="button"
              tabIndex={0}
              aria-label={`${name}, ${ms.length} photos`}
              onClick={() => setSelected(selected === name ? null : name)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") setSelected(name);
              }}
            >
              <circle
                cx={((ms[0].lon + 180) / 360) * 1000}
                cy={((90 - ms[0].lat) / 180) * 440}
                r={Math.min(22, 6 + Math.log2(ms.length) * 2)}
                className={selected === name ? "map-dot active" : "map-dot"}
              />
              <title>
                {name} · {ms.length} photos
              </title>
            </g>
          ))}
        </svg>
        <span className="map-caption">
          Your world in photos · {markers.length.toLocaleString()} geotagged
          moments
        </span>
      </div>
      {loading && <div className="loading">Finding your places…</div>}
      {selected && (
        <div className="place-selection">
          <div className="row">
            <h2>{selected}</h2>
            <Button
              icon="x"
              title="Clear place"
              onClick={() => setSelected(null)}
            />
          </div>
          <div className="place-thumbnails">
            {groups
              .find(([n]) => n === selected)?.[1]
              .map((m) => (
                <button key={m.id} onClick={() => open(m.id)}>
                  <img
                    src={thumb(m.id)}
                    loading="lazy"
                    alt="Open photo at this location"
                  />
                </button>
              ))}
          </div>
        </div>
      )}
      <div className="collection-grid">
        {groups.map(([name, ms]) => (
          <button
            key={name}
            className="collection-open place-card"
            onClick={() => setSelected(selected === name ? null : name)}
          >
            <img src={thumb(ms[0].id)} loading="lazy" alt="" />
            <h2>{name}</h2>
            <p>{ms.length} photos</p>
          </button>
        ))}
      </div>
      {!loading && !markers.length && !error && (
        <Empty icon="pin" title="Every photo has a place">
          Photos with location information will appear here.
        </Empty>
      )}
    </div>
  );
}
