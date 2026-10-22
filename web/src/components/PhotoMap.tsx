import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { land } from '../lib/world'
import { placeName, plural, thumb } from '../lib/photos'
import type { MapMarker } from '../lib/types'

const W = 1000, H = 440
const point = (m: MapMarker) => ({ x: (m.lon + 180) / 360 * W, y: (90 - m.lat) / 180 * H })
type Box = { x: number; y: number; w: number; h: number }
function clamp(b: Box): Box {
  const w = Math.max(W / 2048, Math.min(W, b.w)), h = w * H / W
  return { x: Math.max(0, Math.min(W - w, b.x)), y: Math.max(0, Math.min(H - h, b.y)), w, h }
}
function fit(markers: MapMarker[]): Box {
  let x0 = W, x1 = 0, y0 = H, y1 = 0
  for (const m of markers) { const p = point(m); x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y) }
  const w = Math.max(160, x1 - x0 + 80, (y1 - y0 + 50) * W / H)
  return clamp({ x: (x0 + x1 - w) / 2, y: (y0 + y1 - w * H / W) / 2, w, h: w * H / W })
}

export function PhotoMap({ markers, selected, onSelect }: { markers: MapMarker[]; selected: string | null; onSelect: (markers: MapMarker[]) => void }) {
  const initial = useMemo(() => fit(markers), [markers])
  const [box, setBox] = useState(initial)
  const [width, setWidth] = useState(1000)
  const ref = useRef<SVGSVGElement>(null)
  const pointers = useRef(new Map<number, { x: number; y: number }>())
  const dragged = useRef(false)
  const origin = useRef({ x: 0, y: 0 })
  const prefix = useId().replaceAll(':', '')
  useEffect(() => setBox(initial), [initial])
  useEffect(() => {
    const el = ref.current!
    const update = () => setWidth(Math.min(el.clientWidth, el.clientHeight * W / H) || 1000)
    const observer = new ResizeObserver(update); observer.observe(el); update()
    return () => observer.disconnect()
  }, [])
  const units = box.w / width
  const clusters = useMemo(() => {
    type Cluster = { x: number; y: number; markers: MapMarker[] }
    const cells = new Map<string, Cluster[]>()
    const result: Cluster[] = [], size = 58 * units
    for (const m of markers) {
      const p = point(m), cx = Math.floor(p.x / size), cy = Math.floor(p.y / size)
      let near: Cluster | undefined
      for (let dx = -1; dx <= 1 && !near; dx++) for (let dy = -1; dy <= 1 && !near; dy++) {
        // cloud photos cluster on their own, so they keep their own (hollow) pins next to the library's
        near = cells.get(`${cx + dx},${cy + dy}`)?.find(c => !!c.markers[0].cloud === !!m.cloud && Math.hypot(c.x - p.x, c.y - p.y) < size)
      }
      if (near) near.markers.push(m)
      else {
        const cluster = { ...p, markers: [m] }, key = `${cx},${cy}`
        cells.set(key, [...(cells.get(key) || []), cluster]); result.push(cluster)
      }
    }
    return result.filter(c => c.x >= box.x - size && c.x <= box.x + box.w + size && c.y >= box.y - size && c.y <= box.y + box.h + size)
  }, [markers, units, box])
  const local = (x: number, y: number) => {
    const el = ref.current!, matrix = el.getScreenCTM()!
    return new DOMPoint(x, y).matrixTransform(matrix.inverse())
  }
  const zoom = (factor: number, at?: { x: number; y: number }) => setBox(b => {
    const p = at || { x: b.x + b.w / 2, y: b.y + b.h / 2 }
    const w = Math.max(W / 2048, Math.min(W, b.w / factor)), ratio = w / b.w
    return clamp({ x: p.x - (p.x - b.x) * ratio, y: p.y - (p.y - b.y) * ratio, w, h: w * H / W })
  })
  useEffect(() => {
    const el = ref.current!
    const wheel = (e: WheelEvent) => { e.preventDefault(); zoom(Math.exp(-Math.max(-100, Math.min(100, e.deltaY)) * .006), local(e.clientX, e.clientY)) }
    el.addEventListener('wheel', wheel, { passive: false })
    return () => el.removeEventListener('wheel', wheel)
  }, [])
  const choose = (ms: MapMarker[], x: number, y: number) => {
    if (dragged.current) return
    onSelect(ms)
    if (ms.length > 1) setBox(b => clamp({ x: x - b.w / 4, y: y - b.h / 4, w: b.w / 2, h: b.h / 2 }))
  }
  return <div className="map-card">
    <svg ref={ref} className="photo-map" viewBox={`${box.x} ${box.y} ${box.w} ${box.h}`} role="group" tabIndex={0} aria-label="Photo map. Use plus and minus to zoom, arrow keys to pan, Home to fit all photos."
      onKeyDown={e => {
        if (e.target !== e.currentTarget) return
        const moves: Record<string, [number, number]> = { ArrowLeft: [-.15, 0], ArrowRight: [.15, 0], ArrowUp: [0, -.15], ArrowDown: [0, .15] }
        if (e.key === '+' || e.key === '=') { e.preventDefault(); zoom(1.6) }
        else if (e.key === '-') { e.preventDefault(); zoom(1 / 1.6) }
        else if (e.key === 'Home') { e.preventDefault(); setBox(initial) }
        else if (moves[e.key]) { e.preventDefault(); const [x, y] = moves[e.key]; setBox(b => clamp({ ...b, x: b.x + x * b.w, y: b.y + y * b.h })) }
      }}
      onDoubleClick={e => { if (!(e.target as Element).closest('.map-pin')) zoom(2, local(e.clientX, e.clientY)) }}
      onPointerDown={e => {
        if (e.button !== 0) return
        if (!pointers.current.size) { dragged.current = false; origin.current = { x: e.clientX, y: e.clientY } }
        pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
        // Capture on the hit element so a tap still activates its photo marker.
        ;(e.target as Element).setPointerCapture(e.pointerId)
      }}
      onPointerMove={e => {
        const old = pointers.current.get(e.pointerId)
        if (!old) return
        const next = { x: e.clientX, y: e.clientY }
        if (Math.hypot(next.x - origin.current.x, next.y - origin.current.y) > 4) dragged.current = true
        if (pointers.current.size === 2) {
          const other = [...pointers.current.entries()].find(([id]) => id !== e.pointerId)![1]
          const before = Math.hypot(old.x - other.x, old.y - other.y), after = Math.hypot(next.x - other.x, next.y - other.y)
          if (before > 0 && after > 0) zoom(after / before, local((next.x + other.x) / 2, (next.y + other.y) / 2))
          dragged.current = true
        } else if (dragged.current) {
          const a = local(old.x, old.y), b = local(next.x, next.y)
          setBox(v => clamp({ ...v, x: v.x + a.x - b.x, y: v.y + a.y - b.y }))
        }
        pointers.current.set(e.pointerId, next)
      }}
      onPointerUp={e => pointers.current.delete(e.pointerId)} onPointerCancel={e => pointers.current.delete(e.pointerId)}>
      <rect width={W} height={H} className="map-sea" />
      <path d={land} className="map-land" vectorEffect="non-scaling-stroke" />
      {clusters.map((c, i) => {
        const names = [...new Set(c.markers.map(m => placeName(m)).filter(Boolean))]
        const name = names.length === 1 ? names[0] : `${names.length || 1} nearby places`
        const size = 38 * units, count = c.markers.length, clip = `${prefix}-pin-${i}`
        const cloud = c.markers.every(m => m.cloud), lead = c.markers.find(m => !m.cloud) || c.markers[0]
        return <g key={c.markers[0].id} className={`map-pin ${cloud ? 'cloud' : ''} ${c.markers.some(m => m.id === selected) ? 'active' : ''}`} role="button" tabIndex={0}
          aria-label={`${name}, ${plural(count, 'photo')}${cloud ? ' in your clouds' : ''}. View photos${count > 1 ? ' and zoom in' : ''}.`}
          onClick={() => choose(c.markers, c.x, c.y)} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); dragged.current = false; choose(c.markers, c.x, c.y) } }}>
          <defs><clipPath id={clip}><rect x={c.x - size / 2} y={c.y - size / 2} width={size} height={size} rx={8 * units} /></clipPath></defs>
          <rect className="map-thumb-frame" x={c.x - size / 2 - 2 * units} y={c.y - size / 2 - 2 * units} width={size + 4 * units} height={size + 4 * units} rx={10 * units} />
          <image href={lead.src || thumb(lead.id)} x={c.x - size / 2} y={c.y - size / 2} width={size} height={size} preserveAspectRatio="xMidYMid slice" clipPath={`url(#${clip})`} />
          <rect className="map-count-bg" x={c.x - 18 * units} y={c.y + 10 * units} width={36 * units} height={19 * units} rx={9 * units} />
          <text className="map-count" x={c.x} y={c.y + 23 * units} textAnchor="middle" fontSize={11 * units}>{count.toLocaleString()}</text>
          <title>{name} · {plural(count, 'photo')}</title>
        </g>
      })}
    </svg>
    <div className="map-controls" aria-label="Map controls">
      <button type="button" aria-label="Zoom in" onClick={() => zoom(1.6)} disabled={box.w <= W / 2048}>+</button>
      <button type="button" aria-label="Zoom out" onClick={() => zoom(1 / 1.6)} disabled={box.w >= W}>−</button>
      <button type="button" onClick={() => setBox(initial)}>Fit photos</button>
    </div>
    <span className="map-caption">Natural Earth</span>
    <span className="map-help">Scroll or pinch to zoom · Drag to explore</span>
  </div>
}

/** A small map around one point (the bundled outline, no tiles): where a single photo was taken. */
export function MiniMap({ lat, lon, label }: { lat: number; lon: number; label?: string }) {
  const p = point({ id: '', lat, lon, city: null, country: null })
  const w = 46, h = w * 0.5
  const x = Math.max(0, Math.min(W - w, p.x - w / 2)), y = Math.max(0, Math.min(H - h, p.y - h / 2))
  return (
    <svg className="mini-map" viewBox={`${x} ${y} ${w} ${h}`} role="img" aria-label={label ? `Map: ${label}` : 'Map of where it was taken'}>
      <rect width={W} height={H} className="map-sea" />
      <path d={land} className="map-land" vectorEffect="non-scaling-stroke" />
      <circle cx={p.x} cy={p.y} r={w / 14} className="mini-halo" />
      <circle cx={p.x} cy={p.y} r={w / 40} className="mini-dot" />
    </svg>
  )
}
