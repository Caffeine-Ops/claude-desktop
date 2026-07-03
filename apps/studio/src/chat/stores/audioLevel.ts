import { create } from 'zustand'

/**
 * Live microphone frequency-bin amplitudes driven by the dictation
 * waveform adapter. The adapter samples an AnalyserNode on every
 * requestAnimationFrame tick and pushes a downsampled `NUM_BARS`-wide
 * snapshot into this store; `<DictationWaveform>` reads it and
 * renders an animated bar strip.
 *
 * Kept separate from the dictation state in the composer runtime so
 * the waveform only re-renders when the samples change, not on every
 * composer state tick. `active` is driven by the adapter's
 * listen/stop lifecycle.
 */
export const NUM_BARS = 40

interface AudioLevelStore {
  /** True while a dictation session has an active mic stream. */
  active: boolean
  /** Normalized 0..1 amplitude per frequency bin, length = NUM_BARS. */
  levels: readonly number[]
  setActive: (active: boolean) => void
  setLevels: (levels: readonly number[]) => void
}

const EMPTY: readonly number[] = Object.freeze(new Array(NUM_BARS).fill(0))

export const useAudioLevelStore = create<AudioLevelStore>((set) => ({
  active: false,
  levels: EMPTY,
  setActive: (active) => set({ active, levels: EMPTY }),
  setLevels: (levels) => set({ levels })
}))
