import type { DictationAdapter } from '@assistant-ui/react'

import { pushUiLog } from '../stores/uiLogs'
import { NUM_BARS, useAudioLevelStore } from '../stores/audioLevel'

/**
 * Gemini / OpenAI-compatible audio dictation adapter.
 *
 * Records the user's microphone via `AudioWorklet` into a single
 * rolling PCM buffer for the full duration of the session. On
 * `stop()`, the entire buffer is downsampled to 16kHz mono, encoded
 * as one 16-bit PCM WAV, and shipped through the `speech:transcribe`
 * IPC to main — which sends it to Gemini (inline_data) using the
 * canonical "Generate a transcript of the speech." prompt. The
 * returned text is committed to the composer in a single
 * `onSpeech({isFinal: true})` emission.
 *
 * Why single-shot instead of rolling 3s chunks:
 *  - Google's audio-understanding best practice is to send the
 *    whole utterance in one request. Chunking slices words across
 *    boundaries, and Gemini cannot reliably stitch half-words back
 *    together — that manifests as "sometimes no text comes out".
 *  - A per-chunk silence RMS filter was dropping entire 3s windows
 *    containing a natural pause + one soft syllable, eating sentence
 *    onsets.
 *  - Inline audio budget: 20MB per request. At 16kHz mono 16-bit
 *    that is ~32KB/s, so ~10 minutes fits — far beyond any
 *    reasonable dictation utterance. Downsampling from the browser's
 *    native ~48kHz to 16kHz also matches the standard STT sample
 *    rate and makes Gemini faster.
 *  - Token accounting is 32 tok/s of audio, so a 30s utterance
 *    costs ~960 input tokens — trivial.
 *
 * IMPORTANT: assistant-ui's base composer runtime treats
 * `onSpeechEnd` as a *terminal* event — it calls `_cleanupDictation`
 * the moment the callback fires, tearing down the whole session.
 * So the final commit MUST go through `onSpeech({isFinal: true})`;
 * we never call `onSpeechEnd` during normal operation.
 *
 * The same `MediaStream` feeds an `AnalyserNode` that writes binned
 * amplitudes to the shared `audioLevel` store, so `<DictationWaveform>`
 * animates off the same single mic session.
 */
const TARGET_SAMPLE_RATE = 16_000
// Hard cap on buffered capture duration. At 16kHz 16-bit mono this
// is well under Gemini's 20MB inline_data ceiling. Anything beyond
// a few minutes is almost certainly a forgotten-to-stop session, so
// we force a tail flush rather than OOM the browser.
const MAX_SESSION_SEC = 600
// Minimum audio duration (measured at source sample rate) before
// we bother hitting the network. A <300ms accidental click is not
// worth a round trip and often comes back as an empty transcript,
// which looks like a bug to the user.
const MIN_AUDIO_SEC = 0.3

type SpeechResult = {
  transcript: string
  isFinal?: boolean
}

/**
 * AudioWorklet processor source — loaded as a Blob at runtime so we
 * don't need a separate worklet file in the Vite tree. The worklet
 * runs in the audio thread, forwards every 128-sample frame of the
 * mono input back to the main thread as a copy (the underlying
 * Float32Array is recycled every frame, so a `.slice()` is
 * mandatory — without it the main thread would read stale data by
 * the time the message lands).
 */
const PCM_WORKLET_SOURCE = `
class PcmCaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0]
    if (input && input[0]) {
      this.port.postMessage(input[0].slice())
    }
    return true
  }
}
registerProcessor('pcm-capture', PcmCaptureProcessor)
`

const LOG_PREFIX = '[dictation]'
const debug = (label: string, details?: Record<string, unknown>): void => {
  // Goes to both the DevTools console (cmd+opt+i) and the in-app
  // LogsDialog so users can see the trace without a devtools open.
  // eslint-disable-next-line no-console
  console.log(LOG_PREFIX, label, details ?? '')
  pushUiLog(`dictation:${label}`, details)
}

export function createOpenAIWhisperDictationAdapter(options: {
  language?: string
}): DictationAdapter {
  return {
    // Tell assistant-ui to lock the text input while dictation is
    // running. We also physically replace the textarea with a
    // waveform strip in the composer UI, but surfacing this flag
    // keeps the runtime's internal `inputDisabled` state accurate
    // so any primitive that depends on it (like the Send button's
    // empty-check) sees a consistent picture.
    disableInputDuringDictation: true,
    listen() {
      debug('listen-entered', { language: options.language })
      const speechStartListeners = new Set<() => void>()
      const speechEndListeners = new Set<(result: SpeechResult) => void>()
      const speechListeners = new Set<(result: SpeechResult) => void>()

      let state: 'starting' | 'running' | 'ended' = 'starting'
      let endReason: 'stopped' | 'cancelled' | 'error' = 'stopped'

      let mediaStream: MediaStream | null = null
      let audioCtx: AudioContext | null = null
      let analyser: AnalyserNode | null = null
      let workletNode: AudioWorkletNode | null = null
      let silentGain: GainNode | null = null
      let rafId = 0
      let torn = false
      // Idempotency guard for `session.stop()`. Without this, a user
      // clicking the ✓ button twice (because the first click is
      // invisibly awaiting a 1-3s Gemini response) would enter this
      // method twice: the second call fast-forwards through the
      // (now-empty) buffer, tears down, and triggers assistant-ui's
      // cleanupDictation — which unsubscribes every listener. When
      // the first call's transcribe finally resolves, there's
      // nobody left to receive `emitCommit` and the final chunk
      // text is silently dropped. Sharing a single in-flight stop
      // promise makes the second call a no-op.
      let stopPromise: Promise<void> | null = null

      // Rolling PCM buffer of Float32 samples at audioCtx.sampleRate.
      // Each AudioWorklet `process()` call contributes 128 samples.
      // We accumulate for the full session and flush exactly once on
      // stop() — no periodic chunk timer.
      let pcmChunks: Float32Array[] = []
      let pcmSampleCount = 0
      let sampleRate = 48000 // overwritten once AudioContext exists

      const emitStart = (): void => {
        if (state !== 'starting') return
        state = 'running'
        debug('state-running', { listeners: speechStartListeners.size })
        for (const cb of speechStartListeners) cb()
      }
      /**
       * Commit a chunk's transcribed text to the composer. Assistant-ui
       * treats `onSpeechEnd` as a terminal event, so per-chunk commits
       * must route through `onSpeech({isFinal: true})` instead — the
       * base composer runtime's onSpeech handler appends each final
       * utterance to the underlying text buffer.
       */
      const emitCommit = (chunkText: string): void => {
        if (!chunkText) return
        const result: SpeechResult = { transcript: chunkText, isFinal: true }
        for (const cb of speechListeners) cb(result)
      }

      /**
       * Final flush: drain the entire session buffer, downsample to
       * 16kHz, encode as one WAV, and send in a single request. Runs
       * exactly once on stop(). The buffer is cleared immediately
       * after the copy so a rogue second call (if the idempotency
       * guard ever misses) would just see an empty buffer and return.
       */
      const flushAll = async (): Promise<void> => {
        if (pcmSampleCount === 0) {
          pushUiLog('dictation:flush-empty')
          return
        }
        const srcSampleRate = sampleRate
        const durationSec = pcmSampleCount / srcSampleRate
        if (durationSec < MIN_AUDIO_SEC) {
          pushUiLog('dictation:flush-too-short', {
            durationMs: Math.round(durationSec * 1000)
          })
          pcmChunks = []
          pcmSampleCount = 0
          return
        }

        const samples = new Float32Array(pcmSampleCount)
        let offset = 0
        for (const buf of pcmChunks) {
          samples.set(buf, offset)
          offset += buf.length
        }
        pcmChunks = []
        pcmSampleCount = 0

        const resampled = downsample(samples, srcSampleRate, TARGET_SAMPLE_RATE)
        const wav = encodeWav(resampled, TARGET_SAMPLE_RATE)
        pushUiLog('dictation:transcribe-request', {
          durationMs: Math.round(durationSec * 1000),
          bytes: wav.byteLength,
          srcRate: srcSampleRate,
          dstRate: TARGET_SAMPLE_RATE
        })
        try {
          const result = await window.chatApi.transcribeAudio({
            audio: wav,
            mimeType: 'audio/wav',
            language: options.language
          })
          if (result.error) {
            pushUiLog('dictation:transcribe-error', { error: result.error })
            return
          }
          const text = (result.text ?? '').trim()
          if (text) {
            emitCommit(text)
            pushUiLog('dictation:transcribe-ok', {
              len: text.length,
              bytes: wav.byteLength
            })
          } else {
            pushUiLog('dictation:transcribe-empty', { bytes: wav.byteLength })
          }
        } catch (err) {
          pushUiLog('dictation:transcribe-throw', {
            error: err instanceof Error ? err.message : String(err)
          })
        }
      }

      const teardown = (finalReason: 'stopped' | 'cancelled' | 'error'): void => {
        if (torn) return
        torn = true
        endReason = finalReason
        state = 'ended'
        // Stack trace is super useful here: auto-cancel symptoms are
        // almost always "teardown was called from an unexpected code
        // path and we need to know which one".
        debug('teardown', {
          reason: finalReason,
          trace: new Error().stack?.split('\n').slice(1, 6).join(' | ')
        })
        if (rafId) {
          cancelAnimationFrame(rafId)
          rafId = 0
        }
        if (workletNode) {
          try {
            workletNode.port.onmessage = null
            workletNode.disconnect()
          } catch {
            /* already disconnected */
          }
          workletNode = null
        }
        if (silentGain) {
          try {
            silentGain.disconnect()
          } catch {
            /* noop */
          }
          silentGain = null
        }
        if (mediaStream) {
          for (const track of mediaStream.getTracks()) track.stop()
          mediaStream = null
        }
        if (audioCtx) {
          void audioCtx.close()
          audioCtx = null
        }
        analyser = null
        useAudioLevelStore.getState().setActive(false)
      }

      // Fire off the stream + worklet in the background so listen()
      // can stay synchronous (assistant-ui's runtime doesn't await us).
      void (async () => {
        try {
          debug('audioLevel-active')
          useAudioLevelStore.getState().setActive(true)
          debug('requesting-mic')
          mediaStream = await navigator.mediaDevices.getUserMedia({
            audio: true
          })
          debug('mic-granted', {
            tracks: mediaStream.getTracks().map((t) => ({
              kind: t.kind,
              label: t.label,
              readyState: t.readyState
            }))
          })
          if (torn) {
            debug('mic-granted-but-already-torn')
            for (const track of mediaStream.getTracks()) track.stop()
            mediaStream = null
            return
          }

          const AudioCtor =
            window.AudioContext ||
            (window as unknown as {
              webkitAudioContext: typeof AudioContext
            }).webkitAudioContext
          audioCtx = new AudioCtor()
          sampleRate = audioCtx.sampleRate
          debug('audiocontext-ready', { sampleRate, state: audioCtx.state })
          const source = audioCtx.createMediaStreamSource(mediaStream)

          // ── waveform pipeline ──────────────────────────────────
          analyser = audioCtx.createAnalyser()
          analyser.fftSize = 256
          analyser.smoothingTimeConstant = 0.55
          source.connect(analyser)

          const freqBuffer = new Uint8Array(analyser.frequencyBinCount)
          const binCount = freqBuffer.length
          const edges = new Array<number>(NUM_BARS + 1)
          for (let i = 0; i <= NUM_BARS; i++) {
            const t = i / NUM_BARS
            const shaped = Math.pow(t, 1.6)
            edges[i] = Math.floor(shaped * binCount)
          }

          const loop = (): void => {
            if (!analyser || torn) return
            analyser.getByteFrequencyData(freqBuffer)
            const levels = new Array<number>(NUM_BARS)
            for (let i = 0; i < NUM_BARS; i++) {
              const start = edges[i]!
              const end = Math.max(start + 1, edges[i + 1]!)
              let sum = 0
              for (let j = start; j < end; j++) sum += freqBuffer[j] ?? 0
              const mean = sum / (end - start) / 255
              levels[i] = Math.min(1, Math.pow(mean, 0.75) * 1.25)
            }
            useAudioLevelStore.getState().setLevels(levels)
            rafId = requestAnimationFrame(loop)
          }
          loop()

          // ── PCM capture pipeline via AudioWorklet ──────────────
          debug('worklet-loading')
          const blob = new Blob([PCM_WORKLET_SOURCE], {
            type: 'application/javascript'
          })
          const workletUrl = URL.createObjectURL(blob)
          try {
            await audioCtx.audioWorklet.addModule(workletUrl)
          } finally {
            URL.revokeObjectURL(workletUrl)
          }
          debug('worklet-loaded')
          if (torn) {
            debug('worklet-loaded-but-already-torn')
            return
          }

          workletNode = new AudioWorkletNode(audioCtx, 'pcm-capture', {
            numberOfInputs: 1,
            numberOfOutputs: 1,
            channelCount: 1
          })
          const maxSamples = MAX_SESSION_SEC * sampleRate
          workletNode.port.onmessage = (e: MessageEvent<Float32Array>) => {
            if (torn) return
            // Safety cap: if someone leaves dictation running for
            // tens of minutes, stop buffering rather than growing
            // unbounded. User will see silence in the preview; next
            // stop() still flushes everything we had up to the cap.
            if (pcmSampleCount >= maxSamples) return
            const frame = e.data
            pcmChunks.push(frame)
            pcmSampleCount += frame.length
          }
          // The worklet only runs when its output is connected to
          // something. Route it through a gain=0 node to keep the
          // graph alive without feeding the mic back to the speakers.
          silentGain = audioCtx.createGain()
          silentGain.gain.value = 0
          source.connect(workletNode)
          workletNode.connect(silentGain)
          silentGain.connect(audioCtx.destination)

          emitStart()

          debug('dictation-adapter-started', {
            sampleRate,
            targetSampleRate: TARGET_SAMPLE_RATE,
            maxSessionSec: MAX_SESSION_SEC
          })
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          const name = err instanceof Error ? err.name : 'unknown'
          debug('openai-start-error', { name, error: msg })
          teardown('error')
        }
      })()

      const sessionMethods: DictationAdapter.Session = {
        get status() {
          if (state === 'ended') {
            return { type: 'ended' as const, reason: endReason }
          }
          return { type: state }
        },
        stop: () => {
          // Idempotent: any subsequent stop() call while the first
          // is still in-flight returns the same promise, so double-
          // clicks / duplicate calls don't kick off a second flush
          // and tear down mid-transcribe.
          if (stopPromise) {
            debug('session-stop-called', { duplicate: true })
            return stopPromise
          }
          debug('session-stop-called', {
            trace: new Error().stack?.split('\n').slice(1, 6).join(' | ')
          })
          stopPromise = (async () => {
            // Await the full-session flush BEFORE teardown.
            // Assistant-ui runs
            //   session.stop().finally(() => _cleanupDictation())
            // and cleanupDictation unsubscribes every speech
            // listener. If we tore down first, the still-in-flight
            // transcribe call would eventually resolve and call
            // `emitCommit`, but by then the listener set would be
            // empty — the transcript would silently disappear.
            // Awaiting here keeps the dictation session alive
            // (state = 'running') until the text has landed in the
            // composer.
            try {
              await flushAll()
            } catch (err) {
              debug('stop-flush-error', {
                error: err instanceof Error ? err.message : String(err)
              })
            }
            teardown('stopped')
          })()
          return stopPromise
        },
        cancel: () => {
          debug('session-cancel-called', {
            trace: new Error().stack?.split('\n').slice(1, 6).join(' | ')
          })
          teardown('cancelled')
        },
        onSpeechStart: (callback) => {
          speechStartListeners.add(callback)
          return () => speechStartListeners.delete(callback)
        },
        onSpeechEnd: (callback) => {
          speechEndListeners.add(callback)
          return () => speechEndListeners.delete(callback)
        },
        onSpeech: (callback) => {
          speechListeners.add(callback)
          return () => speechListeners.delete(callback)
        }
      }

      return sessionMethods
    }
  }
}

/**
 * Downsample a mono Float32 buffer from `srcRate` to `dstRate` via
 * box-averaging. Speech STT is standardised around 16kHz and that's
 * also what Gemini internally resamples to, so shipping 48kHz wastes
 * 3x bandwidth and encode time for zero accuracy gain. If the source
 * rate is already ≤ target (unusual but possible on headsets that
 * expose 16kHz directly), we skip the pass and return the input.
 *
 * Box-average is a crude anti-alias but for speech in the 300–3400Hz
 * band it is indistinguishable from a proper Kaiser-windowed sinc
 * filter at the quality Gemini needs. Keeping the implementation
 * inline avoids pulling in an AudioContext OfflineAudioContext or
 * any DSP dependency.
 */
function downsample(
  input: Float32Array,
  srcRate: number,
  dstRate: number
): Float32Array {
  if (dstRate >= srcRate) return input
  const ratio = srcRate / dstRate
  const outLength = Math.floor(input.length / ratio)
  const out = new Float32Array(outLength)
  let outIdx = 0
  let inIdx = 0
  while (outIdx < outLength) {
    const nextInIdx = Math.floor((outIdx + 1) * ratio)
    let sum = 0
    let count = 0
    for (let i = inIdx; i < nextInIdx && i < input.length; i++) {
      sum += input[i]!
      count++
    }
    out[outIdx] = count > 0 ? sum / count : 0
    inIdx = nextInIdx
    outIdx++
  }
  return out
}

/**
 * Encode a mono Float32 sample buffer as a 16-bit PCM WAV file.
 * Spec reference: http://soundfile.sapp.org/doc/WaveFormat/
 *
 * - Samples are clipped to [-1, 1] and scaled to Int16 range.
 * - Header is a fixed 44 bytes; data follows.
 * - Endianness is little-endian throughout (WAV requirement).
 */
function encodeWav(samples: Float32Array, sampleRate: number): Uint8Array {
  const numChannels = 1
  const bitsPerSample = 16
  const bytesPerSample = bitsPerSample / 8
  const blockAlign = numChannels * bytesPerSample
  const byteRate = sampleRate * blockAlign
  const dataSize = samples.length * bytesPerSample
  const headerSize = 44
  const buffer = new ArrayBuffer(headerSize + dataSize)
  const view = new DataView(buffer)

  const writeStr = (offset: number, s: string): void => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i))
  }

  // RIFF header
  writeStr(0, 'RIFF')
  view.setUint32(4, headerSize + dataSize - 8, /* little-endian */ true)
  writeStr(8, 'WAVE')
  // fmt chunk
  writeStr(12, 'fmt ')
  view.setUint32(16, 16, true) // subchunk1Size = 16 for PCM
  view.setUint16(20, 1, true) // audioFormat = 1 (PCM)
  view.setUint16(22, numChannels, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, byteRate, true)
  view.setUint16(32, blockAlign, true)
  view.setUint16(34, bitsPerSample, true)
  // data chunk
  writeStr(36, 'data')
  view.setUint32(40, dataSize, true)

  // PCM samples — clip then scale to int16.
  let offset = headerSize
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]!))
    const int16 = s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff)
    view.setInt16(offset, int16, true)
    offset += 2
  }

  return new Uint8Array(buffer)
}
