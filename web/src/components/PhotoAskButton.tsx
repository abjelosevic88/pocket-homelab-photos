import { useEffect, useRef, useState } from 'react'
import { Icon } from './icons'

/** Attach only the photo the person selected, using their authenticated preview. */
export function PhotoAskButton({ previewURL, name, context, onOpen, onError }: {
  previewURL: string
  name: string
  context: string
  onOpen?: () => void
  onError: (message: string) => void
}) {
  const [available, setAvailable] = useState(() => !!document.querySelector('pocket-ask-launcher'))
  const [busy, setBusy] = useState(false)
  const active = useRef<AbortController | null>(null)
  useEffect(() => {
    const ready = () => setAvailable(!!document.querySelector('pocket-ask-launcher'))
    window.addEventListener('pocket-ask-available', ready); ready()
    return () => window.removeEventListener('pocket-ask-available', ready)
  }, [])
  useEffect(() => {
    setBusy(false)
    return () => { active.current?.abort(); active.current = null }
  }, [previewURL])

  const ask = async () => {
    if (busy || !available) return
    const controller = new AbortController()
    active.current = controller; setBusy(true); onError(''); onOpen?.()
    let bitmap: ImageBitmap | undefined
    try {
      const url = new URL(previewURL, location.href)
      if (url.origin !== location.origin) throw Error('The photo must come from your Photos library.')
      const response = await fetch(url.href, { credentials: 'same-origin', redirect: 'error', signal: controller.signal })
      if (!response.ok || !response.headers.get('content-type')?.startsWith('image/')) throw Error('Could not attach this photo. Check that its preview is available and try again.')
      const blob = await response.blob()
      if (blob.size > 30 * 1024 * 1024) throw Error('This preview is too large to attach. Try a smaller photo.')
      bitmap = await createImageBitmap(blob)
      const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height))
      const canvas = document.createElement('canvas')
      canvas.width = Math.max(1, Math.round(bitmap.width * scale)); canvas.height = Math.max(1, Math.round(bitmap.height * scale))
      const ctx = canvas.getContext('2d')
      if (!ctx) throw Error('This browser could not prepare the photo.')
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height)
      ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
      let dataURL = canvas.toDataURL('image/jpeg', 0.9)
      if (dataURL.length > 2700000) dataURL = canvas.toDataURL('image/jpeg', 0.65)
      if (dataURL.length > 2700000) throw Error('This preview is too large to attach. Try a smaller photo.')
      if (controller.signal.aborted) return
      window.dispatchEvent(new CustomEvent('pocket-ask', { detail: {
        source: { url: url.href, title: name, selection: context, image: { name: name.replace(/\.[^.]+$/, '').slice(0, 200) + '.jpg', data_url: dataURL } },
        prompt: 'Describe this photo and explain any visible text.',
      } }))
    } catch (error) {
      if (!controller.signal.aborted) onError(error instanceof Error ? error.message : 'Could not prepare this photo for Ask.')
    } finally {
      bitmap?.close()
      if (active.current === controller) { active.current = null; setBusy(false) }
    }
  }

  return <button type="button" className="vpill photo-ask" data-pocket-ask-trigger
    aria-label={busy ? 'Preparing photo for AI' : 'Ask AI about this photo'} aria-haspopup="dialog"
    title={available ? 'Ask a question about this photo' : 'Connect Photos to Pocket Core to use Ask AI'}
    disabled={busy || !available} onClick={ask}>
    <Icon name="sparkle" size={17} /><span>{busy ? 'Preparing…' : 'Ask AI'}</span>
  </button>
}
