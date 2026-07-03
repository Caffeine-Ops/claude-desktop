import { useAudioLevelStore } from '../../stores/audioLevel'

/**
 * Live microphone waveform strip shown while dictation is active.
 *
 * Reads the binned frequency amplitudes written by the waveform
 * dictation adapter (runtime/waveformDictationAdapter.ts) and
 * renders one thin bar per bin. Bars animate via CSS height
 * transitions rather than per-frame inline keyframes — the store
 * updates ~60fps from the AnalyserNode loop, so a short
 * transition gives the strip a smooth ribbon feel without React
 * reconciling a keyframe every frame.
 *
 * Styling notes:
 *  - The bars are pinned to the vertical center of a fixed-height
 *    strip so tall amplitudes grow symmetrically up AND down, which
 *    reads more like a live waveform than a bar chart.
 *  - Idle bars (pre-speech, silence) fall back to a 2px minimum so
 *    the strip still shows a continuous baseline.
 *  - Color follows the current theme's accent — red-ish during the
 *    active session via `text-red-500` on the wrapper.
 */
export function DictationWaveform(): React.JSX.Element {
  const levels = useAudioLevelStore((s) => s.levels)
  const active = useAudioLevelStore((s) => s.active)

  return (
    <div
      aria-hidden
      className="flex h-7 w-full items-center justify-center gap-[3px] text-red-500/80"
    >
      {levels.map((level, i) => {
        // Map 0..1 amplitude to 2..24px so quiet audio still shows a
        // baseline wiggle and the loudest peaks reach the strip
        // height. `transitions` smooth between frames.
        const height = active ? Math.max(2, 2 + level * 22) : 2
        return (
          <span
            key={i}
            className="w-[2px] rounded-full bg-current transition-[height] duration-75 ease-out"
            style={{ height: `${height}px` }}
          />
        )
      })}
    </div>
  )
}
