import { Modal } from './ui'

const GROUPS: { title: string; keys: [string[], string][] }[] = [
  { title: 'Go to', keys: [[['h'], 'All photos'], [['f'], 'Favorites'], [['v'], 'Videos'], [['m'], 'Memories'], [['a'], 'Albums'], [['p'], 'People'], [['o'], 'Places'], [['s'], 'Sharing'], [['t'], 'Recently deleted'], [[','], 'Settings']] },
  { title: 'Library', keys: [[['/'], 'Search & commands'], [['⌘', 'K'], 'Search & commands'], [['u'], 'Upload photos'], [['n'], 'New album'], [['⌘', 'A'], 'Select everything loaded'], [['⇧', 'click'], 'Select a range'], [['esc'], 'Clear the selection'], [['['], 'Show or hide the sidebar']] },
  { title: 'Viewer', keys: [[['←'], 'Previous photo'], [['→'], 'Next photo'], [['f'], 'Favorite'], [['i'], 'Details'], [['e'], 'Edit'], [['space'], 'Slideshow'], [['esc'], 'Close']] },
  { title: 'Help', keys: [[['?'], 'This sheet']] },
]

export function ShortcutsSheet({ onClose }: { onClose: () => void }) {
  return (
    <Modal title="Keyboard shortcuts" onClose={onClose} size="lg">
      <div className="shortcuts">
        {GROUPS.map(g => (
          <section key={g.title}>
            <h4 className="sc-h">{g.title}</h4>
            {g.keys.map(([keys, label]) => (
              <div key={label + keys.join('')} className="sc-row"><span>{label}</span><span className="sc-keys">{keys.map(k => <kbd key={k}>{k}</kbd>)}</span></div>
            ))}
          </section>
        ))}
      </div>
      <p className="muted small mt">On touch screens: swipe left or right in the viewer, tap once to zoom, tap again to fit.</p>
    </Modal>
  )
}
