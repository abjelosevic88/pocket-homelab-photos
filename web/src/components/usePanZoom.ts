// Zoom and pan for the viewer's photo: double-click / double-tap into the spot you pointed at, pinch and
// ctrl/⌘-wheel around the cursor, drag or scroll to pan, edges kept on screen, a sharper image once the
// preview runs out of pixels. Scale 1 is "fit"; the image box fills the stage and object-fit keeps the
// photo's aspect, so the content rectangle is worked out from the aspect ratio.
import { useCallback, useEffect, useRef, useState } from 'react'

type View = { s: number; tx: number; ty: number; anim: boolean }
const FIT: View = { s: 1, tx: 0, ty: 0, anim: true }
const TAP_MS = 300, TAP_PX = 30, SWIPE_PX = 70

export function usePanZoom({ width, height, enabled, onSwipe }: {
  width?: number          // original pixels, for "100%" and how far zooming is worth it
  height?: number
  enabled: boolean        // off for videos and while editing
  onSwipe: (dir: 1 | -1) => void
}) {
  const stage = useRef<HTMLDivElement>(null)
  const img = useRef<HTMLImageElement>(null)
  const [view, setView] = useState<View>(FIT)
  const [dragging, setDragging] = useState(false)
  const v = useRef(view); v.current = view
  const pointers = useRef(new Map<number, { x: number; y: number }>())
  const gesture = useRef<{ x: number; y: number; d: number; view: View; moved: boolean; type: string } | null>(null)
  const lastTap = useRef({ t: 0, x: 0, y: 0 })
  const lastType = useRef('mouse')

  // Geometry: the image box (layout position, unaffected by the transform) and the photo inside it.
  const geo = useCallback(() => {
    const st = stage.current, im = img.current
    if (!st || !im) return null
    const sr = st.getBoundingClientRect()
    const bw = im.offsetWidth, bh = im.offsetHeight
    const ar = (im.naturalWidth && im.naturalHeight) ? im.naturalWidth / im.naturalHeight : (width && height ? width / height : bw / bh)
    const cw = Math.min(bw, bh * ar), ch = cw / ar
    return { sr, bx: sr.left + im.offsetLeft, by: sr.top + im.offsetTop, cx: (bw - cw) / 2, cy: (bh - ch) / 2, cw, ch }
  }, [width, height])

  // Scale at which one photo pixel is one CSS pixel; zooming far past it only shows mush.
  const actual = useCallback(() => {
    const g = geo()
    if (!g || !width || !height) return 4
    return Math.max(width, height) / Math.max(g.cw, g.ch)
  }, [geo, width, height])
  const maxScale = useCallback(() => Math.min(12, Math.max(4, actual() * 2)), [actual])

  const clamp = useCallback((n: View): View => {
    const g = geo()
    if (!g || n.s <= 1.001) return { ...FIT, anim: n.anim }
    const axis = (t: number, box: number, off: number, size: number, lo: number, len: number) => {
      const w = size * n.s
      const want = w <= len ? lo + (len - w) / 2 : Math.min(lo, Math.max(lo + len - w, box + t + off * n.s))
      return want - box - off * n.s
    }
    return { ...n, tx: axis(n.tx, g.bx, g.cx, g.cw, g.sr.left, g.sr.width), ty: axis(n.ty, g.by, g.cy, g.ch, g.sr.top, g.sr.height) }
  }, [geo])

  // Zoom to scale s keeping the photo point under (x, y) where it is.
  const zoomAt = useCallback((x: number, y: number, s: number, anim: boolean, from = v.current) => {
    const g = geo()
    if (!g) return
    s = Math.max(1, Math.min(maxScale(), s))
    const px = (x - g.bx - from.tx) / from.s, py = (y - g.by - from.ty) / from.s
    setView(clamp({ s, tx: x - g.bx - px * s, ty: y - g.by - py * s, anim }))
  }, [geo, clamp, maxScale])

  const center = () => { const r = stage.current?.getBoundingClientRect(); return r ? [r.left + r.width / 2, r.top + r.height / 2] as const : [0, 0] as const }

  // Double-click / double-tap: into the spot you pointed at (pulled onto the photo), or back to fit.
  const toggleAt = useCallback((x: number, y: number) => {
    if (!enabled) return
    if (v.current.s > 1.001) { setView(FIT); return }
    const g = geo()
    if (!g) return
    const l = g.bx + g.cx, t = g.by + g.cy
    x = Math.min(l + g.cw, Math.max(l, x)); y = Math.min(t + g.ch, Math.max(t, y))
    const a = actual()
    zoomAt(x, y, a >= 2.5 ? 2.5 : Math.max(a, 1.6), true)
  }, [enabled, geo, actual, zoomAt])

  const reset = useCallback(() => setView(FIT), [])
  const zoomBy = useCallback((f: number) => { const [x, y] = center(); zoomAt(x, y, v.current.s * f, true) }, [zoomAt])
  const zoomActual = useCallback(() => { const [x, y] = center(); zoomAt(x, y, actual(), true) }, [zoomAt, actual])
  const toggle = useCallback(() => { const [x, y] = center(); toggleAt(x, y) }, [toggleAt])

  // Wheel: pinch on a trackpad (ctrlKey) or ⌘/ctrl-scroll zooms around the cursor; plain scroll pans.
  useEffect(() => {
    const st = stage.current
    if (!st) return
    const wheel = (e: WheelEvent) => {
      if (!enabled) return
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault()
        zoomAt(e.clientX, e.clientY, v.current.s * Math.exp(-e.deltaY * (e.deltaMode ? 0.05 : 0.01)), false)
      } else if (v.current.s > 1.001) {
        e.preventDefault()
        setView(clamp({ ...v.current, tx: v.current.tx - e.deltaX, ty: v.current.ty - e.deltaY, anim: false }))
      }
    }
    st.addEventListener('wheel', wheel, { passive: false })
    return () => st.removeEventListener('wheel', wheel)
  }, [enabled, zoomAt, clamp])

  // A new layout (window size, info panel) invalidates the pan; start again from fit.
  useEffect(() => {
    const st = stage.current
    if (!st || typeof ResizeObserver === 'undefined') return
    let first = true
    const ro = new ResizeObserver(() => { if (first) { first = false; return } setView(FIT) })
    ro.observe(st)
    return () => ro.disconnect()
  }, [])

  useEffect(() => { if (!enabled) setView(FIT) }, [enabled])

  const startGesture = (type: string) => {
    const pts = [...pointers.current.values()]
    const mid = pts.length > 1 ? { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 } : pts[0]
    const d = pts.length > 1 ? Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) : 0
    gesture.current = { x: mid.x, y: mid.y, d, view: v.current, moved: false, type }
  }

  const handlers = {
    onPointerDown: (e: React.PointerEvent) => {
      lastType.current = e.pointerType
      if (!enabled || (e.target as HTMLElement).closest('button,a,video')) return
      if (e.pointerType === 'mouse' && e.button !== 0) return
      pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
      ;(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId)
      startGesture(e.pointerType)
    },
    onPointerMove: (e: React.PointerEvent) => {
      if (!pointers.current.has(e.pointerId) || !gesture.current) return
      pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
      const g = gesture.current, pts = [...pointers.current.values()]
      if (pts.length > 1 && g.d) {
        const mid = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 }
        const s = g.view.s * Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) / g.d
        g.moved = true
        const geo0 = geo()
        if (!geo0) return
        const sc = Math.max(1, Math.min(maxScale(), s))
        const px = (g.x - geo0.bx - g.view.tx) / g.view.s, py = (g.y - geo0.by - g.view.ty) / g.view.s
        setView(clamp({ s: sc, tx: mid.x - geo0.bx - px * sc, ty: mid.y - geo0.by - py * sc, anim: false }))
        return
      }
      const dx = e.clientX - g.x, dy = e.clientY - g.y
      if (Math.hypot(dx, dy) > 4) g.moved = true
      if (g.view.s > 1.001 && g.moved) {
        setDragging(true)
        setView(clamp({ ...g.view, tx: g.view.tx + dx, ty: g.view.ty + dy, anim: false }))
      }
    },
    onPointerUp: (e: React.PointerEvent) => {
      const g = gesture.current
      const was = pointers.current.size
      pointers.current.delete(e.pointerId)
      setDragging(false)
      if (!g) return
      if (pointers.current.size) { startGesture(g.type); return }   // one finger of a pinch lifted: keep panning
      gesture.current = null
      if (was > 1 || g.type !== 'touch') return
      const dx = e.clientX - g.x, dy = e.clientY - g.y
      if (!g.moved) {
        const now = Date.now(), lt = lastTap.current
        if (now - lt.t < TAP_MS && Math.hypot(e.clientX - lt.x, e.clientY - lt.y) < TAP_PX) { lastTap.current = { t: 0, x: 0, y: 0 }; toggleAt(e.clientX, e.clientY) }
        else lastTap.current = { t: now, x: e.clientX, y: e.clientY }
      } else if (g.view.s <= 1.001 && Math.abs(dx) > SWIPE_PX && Math.abs(dx) > Math.abs(dy)) onSwipe(dx < 0 ? 1 : -1)
    },
    onPointerCancel: (e: React.PointerEvent) => { pointers.current.delete(e.pointerId); gesture.current = null; setDragging(false) },
    onDoubleClick: (e: React.MouseEvent) => {
      if (lastType.current === 'touch' || (e.target as HTMLElement).closest('button,a,video')) return
      toggleAt(e.clientX, e.clientY)
    },
  }

  const zoomed = view.s > 1.001
  // Displayed photo pixels beyond what the loaded image has: worth fetching the full-size one.
  const needsDetail = () => {
    const im = img.current, g = geo()
    return !!(im && g && zoomed && im.naturalWidth && g.cw * view.s * (window.devicePixelRatio || 1) > im.naturalWidth * 1.05)
  }

  return {
    stage, img, handlers, zoomed, dragging, needsDetail,
    percent: Math.round((view.s / actual()) * 100),
    style: { transform: zoomed ? `translate(${view.tx}px, ${view.ty}px) scale(${view.s})` : undefined, transition: view.anim ? undefined : 'none' } as React.CSSProperties,
    reset, toggle, zoomBy, zoomActual,
  }
}
