/**
 * Pure logic shared by the Konami easter-egg mini game — extracted from the
 * component so it stays unit-testable.
 */

/** The classic Konami code: ↑ ↑ ↓ ↓ ← → ← → B A */
export const KONAMI = [
  'ArrowUp',
  'ArrowUp',
  'ArrowDown',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'ArrowLeft',
  'ArrowRight',
  'b',
  'a',
]

/**
 * Feeds a key into the running sequence. Returns `true` when the sequence
 * completes the Konami code (and resets it), `false` otherwise.
 *
 * `state` is the accumulated sequence so far (may be reset/trimmed in place).
 * Keys that are not part of the code simply shorten the effective window via
 * trimming, so typing anything in between is fine.
 */
export function feedKonami(state: string[], key: string): boolean {
  // Normalise: arrows pass through, letters normalise to lowercase code chars
  // so Caps Lock / Shift can't break the code.
  const norm = key === 'a' || key === 'A' ? 'a' : key === 'b' || key === 'B' ? 'b' : key
  const seq = [...state, norm].slice(-KONAMI.length)
  state.length = 0
  state.push(...seq)
  const matched = seq.join() === KONAMI.join()
  if (matched) state.length = 0
  return matched
}
