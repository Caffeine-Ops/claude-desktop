import { useEffect, useRef, useState } from 'react'
import { motion, useReducedMotion } from 'motion/react'

/**
 * AppleGlowEffect
 * ---------------
 * An "Apple Intelligence" border glow, ported from the SwiftUI implementation
 * at github.com/jacobamobin/AppleIntelligenceGlowEffect.
 *
 * The original's charm is NOT a spinning conic gradient — it's a set of
 * concentric stroked rings (an AngularGradient border) stacked at increasing
 * line widths + blur radii (Swift: 6/0, 9/4, 11/12, 15/15), with a gradient
 * whose six FIXED colours are re-sorted to new random positions every ~0.5s
 * and tweened with a 1s ease-in-out. The colour band churns organically
 * instead of rotating mechanically — that's the Apple-Intelligence look.
 *
 * Web port:
 *   - Each "ring" is an absolutely-positioned div, its conic-gradient fill
 *     (= AngularGradient) masked to a `width`-px border ring (fill XOR an
 *     inset content-box fill), then blurred.
 *   - To churn the colours we hold TWO gradient strings and cross-fade between
 *     them: every STIR_MS we drop a freshly-randomised gradient onto the hidden
 *     layer and flip opacities, so the new colour positions ease in over
 *     TWEEN_MS. (Conic gradients aren't directly CSS-transitionable, so a
 *     cross-fade is the GPU-cheap way to get the smooth churn.)
 *
 * Respects prefers-reduced-motion: one static ring, no churn.
 *
 * Place inside a `position: relative` element with the desired border-radius;
 * the glow inherits that radius and hugs the border.
 */

// The six Apple-Intelligence colours, verbatim from the Swift source.
const COLORS = ['#BC82F3', '#F5B9EA', '#8D9FFF', '#FF6778', '#FFBA71', '#C686FF']

// Ring stack: [borderWidth(px), blur(px)]. Mirrors the Swift 6/0, 9/4, 11/12,
// 15/15 ratios, scaled down for a desktop panel border.
const RINGS: Array<{ width: number; blur: number; opacity: number }> = [
  { width: 1.5, blur: 0, opacity: 1 },
  { width: 2.5, blur: 3, opacity: 0.85 },
  { width: 4, blur: 9, opacity: 0.6 },
  { width: 6, blur: 16, opacity: 0.4 }
]

const STIR_MS = 850 // how often the colour positions re-shuffle
const TWEEN_MS = 1300 // cross-fade / ease duration between gradients

function randomConic(): string {
  // One random location per colour, sorted ascending — exactly the Swift
  // `Double.random(in: 0...1)` then `.sorted` approach. `from 0deg` =
  // AngularGradient(center: .center).
  const xs = COLORS.map(() => Math.random()).sort((a, b) => a - b)
  const parts = COLORS.map((c, i) => `${c} ${Math.round(xs[i] * 100)}%`)
  return `conic-gradient(from 0deg, ${parts.join(', ')})`
}

// Mask that keeps only the border ring of a box (centre punched out).
const RING_MASK = {
  WebkitMask: 'linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0)',
  WebkitMaskComposite: 'xor',
  mask: 'linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0)',
  maskComposite: 'exclude'
} as React.CSSProperties

export function AppleGlowEffect(): React.JSX.Element {
  const reduce = useReducedMotion()

  // Two gradients we cross-fade between. `front`/`back` content + which is
  // currently the visible target.
  const [grad, setGrad] = useState(() => {
    const g = randomConic()
    return { a: g, b: g }
  })
  const [showA, setShowA] = useState(true)
  const showARef = useRef(true)

  useEffect(() => {
    if (reduce) return
    const id = setInterval(() => {
      const next = randomConic()
      // Drop the new gradient onto the hidden layer, then flip to fade it in.
      setGrad((prev) => (showARef.current ? { ...prev, b: next } : { ...prev, a: next }))
      showARef.current = !showARef.current
      setShowA(showARef.current)
    }, STIR_MS)
    return () => clearInterval(id)
  }, [reduce])

  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 z-[5] [border-radius:inherit]">
      {RINGS.map((ring, i) => (
        <div
          key={i}
          className="absolute inset-0 [border-radius:inherit]"
          style={{ filter: ring.blur ? `blur(${ring.blur}px)` : undefined, opacity: ring.opacity }}
        >
          {/* Cross-fade layer A */}
          <motion.div
            className="absolute inset-0 [border-radius:inherit]"
            style={{ background: grad.a, padding: ring.width, ...RING_MASK }}
            initial={false}
            animate={{ opacity: reduce || showA ? 1 : 0 }}
            transition={{ duration: reduce ? 0 : TWEEN_MS / 1000, ease: 'easeInOut' }}
          />
          {/* Cross-fade layer B */}
          {!reduce && (
            <motion.div
              className="absolute inset-0 [border-radius:inherit]"
              style={{ background: grad.b, padding: ring.width, ...RING_MASK }}
              initial={false}
              animate={{ opacity: showA ? 0 : 1 }}
              transition={{ duration: TWEEN_MS / 1000, ease: 'easeInOut' }}
            />
          )}
        </div>
      ))}
    </div>
  )
}
