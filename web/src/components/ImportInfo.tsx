import { useRef, useState } from 'react'
import { Icon } from './icons'
import { Popover, rectOf, type Anchor } from './ui'

export function ImportInfo({ source, cloud = false }: { source: string; cloud?: boolean }) {
  const trigger = useRef<HTMLButtonElement>(null)
  const [anchor, setAnchor] = useState<Anchor | null>(null)
  const close = () => { setAnchor(null); trigger.current?.focus() }
  return <>
    <button ref={trigger} type="button" className="btn ghost sm import-info-trigger" aria-haspopup="dialog" aria-expanded={!!anchor}
      onClick={e => setAnchor(anchor ? null : rectOf(e.currentTarget))}><Icon name="info" size={15} />About importing</button>
    {anchor && <Popover anchor={anchor} onClose={close} prefer="below" width={340} className="import-info" label="About importing">
      <div className="row"><strong className="grow">About importing</strong><button type="button" className="btn ghost icon-only sm" aria-label="Close import information" autoFocus onClick={close}><Icon name="x" size={16} /></button></div>
      <p>Importing copies selected originals into your Immich library. Your files in {source} stay where they are and are never changed.</p>
      <p className="muted">{cloud ? `Photos reads ${source} using your connected account and stores small thumbnails for browsing.` : 'Photos browses using your own access in Pocket Core.'}</p>
    </Popover>}
  </>
}
