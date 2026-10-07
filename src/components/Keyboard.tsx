const KEYS = [
  { key: 'a', note: 60, name: 'C' }, { key: 'w', note: 61, name: 'C♯', black: true },
  { key: 's', note: 62, name: 'D' }, { key: 'e', note: 63, name: 'D♯', black: true },
  { key: 'd', note: 64, name: 'E' }, { key: 'f', note: 65, name: 'F' },
  { key: 't', note: 66, name: 'F♯', black: true }, { key: 'g', note: 67, name: 'G' },
  { key: 'y', note: 68, name: 'G♯', black: true }, { key: 'h', note: 69, name: 'A' },
  { key: 'u', note: 70, name: 'A♯', black: true }, { key: 'j', note: 71, name: 'B' },
  { key: 'k', note: 72, name: 'C' },
]
export const keyMap = Object.fromEntries(KEYS.map(k => [k.key, k.note])) as Record<string, number>

export function Keyboard({ active, noteOn, noteOff }: { active: Set<number>; noteOn: (note: number) => void; noteOff: (note: number) => void }) {
  return <div className="keyboard" aria-label="Playable keyboard">
    {KEYS.map(k => <button key={k.note} className={`${k.black ? 'black' : 'white'} ${active.has(k.note) ? 'pressed' : ''}`} onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); noteOn(k.note) }} onPointerUp={() => noteOff(k.note)} onPointerCancel={() => noteOff(k.note)}>
      <span>{k.name}4</span><kbd>{k.key.toUpperCase()}</kbd>
    </button>)}
  </div>
}
