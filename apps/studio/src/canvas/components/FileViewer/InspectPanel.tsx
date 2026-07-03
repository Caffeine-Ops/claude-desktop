import { useEffect, useState } from 'react';
import type { InspectTarget } from './types';

// Maps a CSS computed value (e.g. "rgb(40, 50, 60)" or "16px") to a form
// input value. Browsers return colors as rgb()/rgba(); HTML <input type=color>
// only accepts "#rrggbb". Lengths come back as "12px" or "0px"; we strip
// units for slider binding and re-append on emit.
//
// Note: <input type=color> has no alpha channel, so an rgba() with alpha < 1
// is collapsed to its opaque RGB equivalent here. Most agent-generated HTML
// uses opaque colors, so this is a known cosmetic limitation — a
// semi-transparent source value will display in the panel as fully opaque.
function rgbToHex(value: string | undefined): string {
  if (!value) return '#000000';
  const v = value.trim();
  if (v.startsWith('#') && (v.length === 7 || v.length === 4)) {
    if (v.length === 4) {
      return '#' + [1, 2, 3].map((i) => {
        const c = v.charAt(i);
        return c + c;
      }).join('');
    }
    return v;
  }
  const m = v.match(/rgba?\(\s*([0-9.]+)[ ,]+([0-9.]+)[ ,]+([0-9.]+)/i);
  if (!m) return '#000000';
  const toHex = (n: string) => {
    const x = Math.max(0, Math.min(255, Math.round(Number(n))));
    return x.toString(16).padStart(2, '0');
  };
  return '#' + toHex(m[1] ?? '0') + toHex(m[2] ?? '0') + toHex(m[3] ?? '0');
}

// Parse a CSS length to a number. Inspect's current sliders all clamp to a
// non-negative range (padding, font-size, border-radius), so we reject
// negatives at parse time too — otherwise a `-12px` source value would be
// silently floored to 0 by the slider clamp without the regex agreeing.
// If a future control needs negative values (e.g. margin), thread an
// explicit `allowNegative` flag rather than reintroducing `-?` here.
function pxToNumber(value: string | undefined): number {
  if (!value) return 0;
  const m = value.trim().match(/^(\d+(?:\.\d+)?)/);
  return m ? Number(m[1]) : 0;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

export function InspectPanel({
  target,
  onApply,
  onResetElement,
  onSaveToSource,
  onClose,
  saving,
  savedAt,
  error,
}: {
  target: InspectTarget;
  onApply: (prop: string, value: string) => void;
  onResetElement: (elementId: string) => void;
  onSaveToSource: () => void;
  onClose: () => void;
  saving: boolean;
  savedAt: number | null;
  error: string | null;
}) {
  // Local "draft" mirror of the most recent value the user picked, so
  // sliders/colors keep responding even before the iframe echoes back the
  // computed result. Reset whenever the selected element changes.
  const [draft, setDraft] = useState<Record<string, string>>({});
  useEffect(() => {
    setDraft({});
  }, [target.elementId]);

  const value = (prop: string, fallback: string): string =>
    draft[prop] ?? fallback;

  function setVal(prop: string, raw: string) {
    setDraft((d) => ({ ...d, [prop]: raw }));
    onApply(prop, raw);
  }

  // Padding is exposed as a single shared slider that emits the `padding`
  // shorthand; the browser fans the value out to all four sides internally.
  // When per-side control becomes useful, switch to emitting explicit
  // padding-top / padding-right / padding-bottom / padding-left props
  // (the bridge already allow-lists those long-hand names).
  const initialPadding = pxToNumber(target.style.paddingTop);
  const initialFontSize = pxToNumber(target.style.fontSize);
  const initialRadius = pxToNumber(target.style.borderRadius);

  // Color / length controls all read through `draft` first so the input
  // tracks the most recent user pick even before getComputedStyle catches
  // up. Without this the picker would snap back to the initial computed
  // snapshot on every change and feel non-editable.
  const colorHex = value('color', rgbToHex(target.style.color));
  const bgHex = value('background-color', rgbToHex(target.style.backgroundColor));
  const padding = value('padding', String(initialPadding));
  const fontSize = value('font-size', String(initialFontSize));
  const radius = value('border-radius', String(initialRadius));
  const textAlign = value('text-align', target.style.textAlign || 'left');
  const fontWeight = value('font-weight', target.style.fontWeight || '400');
  // Parse once: `pxToNumber(...) || initial...` would treat a legitimate
  // `0px` draft as missing and snap the slider back to the original
  // computed value, making it impossible to remove padding/radius from an
  // element whose initial value is nonzero. `pxToNumber` already returns
  // 0 for unparseable input, so its result is safe to consume directly
  // and zero is preserved.
  const paddingNum = pxToNumber(padding);
  const fontSizeNum = pxToNumber(fontSize);
  const radiusNum = pxToNumber(radius);

  const justSaved = savedAt && Date.now() - savedAt < 4000;

  return (
    <aside className="inspect-panel" data-testid="inspect-panel">
      <header className="inspect-panel-head">
        <div className="inspect-panel-title">
          <strong title={target.label || target.elementId}>{target.label || target.elementId}</strong>
          <code title={target.selector}>{target.elementId}</code>
        </div>
        <button type="button" className="ghost" onClick={onClose} aria-label="Close inspect">
          ×
        </button>
      </header>

      {target.clickedDescendant ? (
        <div className="inspect-ancestor-notice" data-testid="inspect-ancestor-notice">
          <div className="inspect-ancestor-notice-icon" aria-hidden>
            i
          </div>
          <div className="inspect-ancestor-notice-text">
            You clicked <strong>{target.clickedDescendant.label}</strong>
            {target.clickedDescendant.text
              ? ` ("${target.clickedDescendant.text.slice(0, 40)}${target.clickedDescendant.text.length > 40 ? '...' : ''}")`
              : ''}
            , but it has no <code>data-od-id</code> annotation. Editing{' '}
            <strong>{target.label || target.elementId}</strong> instead, the nearest annotated ancestor.
          </div>
        </div>
      ) : null}

      <section className="inspect-section">
        <div className="inspect-section-label">Colors</div>
        <div className="inspect-row">
          <label htmlFor="ip-color">Text</label>
          <input
            id="ip-color"
            data-testid="inspect-color"
            type="color"
            value={colorHex}
            onChange={(e) => setVal('color', e.target.value)}
          />
          <input
            type="text"
            value={colorHex}
            onChange={(e) => setVal('color', e.target.value)}
            spellCheck={false}
          />
        </div>
        <div className="inspect-row">
          <label htmlFor="ip-bg">Background</label>
          <input
            id="ip-bg"
            data-testid="inspect-bg"
            type="color"
            value={bgHex}
            onChange={(e) => setVal('background-color', e.target.value)}
          />
          <input
            type="text"
            value={bgHex}
            onChange={(e) => setVal('background-color', e.target.value)}
            spellCheck={false}
          />
        </div>
      </section>

      <section className="inspect-section">
        <div className="inspect-section-label">Typography</div>
        <div className="inspect-row">
          <label htmlFor="ip-fs">Size</label>
          <input
            id="ip-fs"
            data-testid="inspect-font-size"
            type="range"
            min={8}
            max={160}
            step={1}
            value={clamp(fontSizeNum, 8, 160)}
            onChange={(e) => setVal('font-size', `${e.target.value}px`)}
          />
          <span className="inspect-row-value">{Math.round(fontSizeNum)}px</span>
        </div>
        <div className="inspect-row">
          <label htmlFor="ip-fw">Weight</label>
          <select
            id="ip-fw"
            value={fontWeight}
            onChange={(e) => setVal('font-weight', e.target.value)}
          >
            {['100', '300', '400', '500', '600', '700', '800', '900'].map((w) => (
              <option key={w} value={w}>{w}</option>
            ))}
          </select>
        </div>
        <div className="inspect-row">
          <label htmlFor="ip-ta">Align</label>
          <select
            id="ip-ta"
            value={textAlign}
            onChange={(e) => setVal('text-align', e.target.value)}
          >
            {['left', 'center', 'right', 'justify'].map((a) => (
              <option key={a} value={a}>{a}</option>
            ))}
          </select>
        </div>
      </section>

      <section className="inspect-section">
        <div className="inspect-section-label">Spacing &amp; Shape</div>
        <div className="inspect-row">
          <label htmlFor="ip-pad">Padding</label>
          <input
            id="ip-pad"
            data-testid="inspect-padding"
            type="range"
            min={0}
            max={120}
            step={1}
            value={clamp(paddingNum, 0, 120)}
            onChange={(e) => setVal('padding', `${e.target.value}px`)}
          />
          <span className="inspect-row-value">{Math.round(paddingNum)}px</span>
        </div>
        <div className="inspect-row">
          <label htmlFor="ip-rad">Radius</label>
          <input
            id="ip-rad"
            data-testid="inspect-radius"
            type="range"
            min={0}
            max={120}
            step={1}
            value={clamp(radiusNum, 0, 120)}
            onChange={(e) => setVal('border-radius', `${e.target.value}px`)}
          />
          <span className="inspect-row-value">{Math.round(radiusNum)}px</span>
        </div>
      </section>

      <footer className="inspect-panel-footer">
        <button
          type="button"
          className="ghost"
          onClick={() => {
            setDraft({});
            onResetElement(target.elementId);
          }}
        >
          Reset element
        </button>
        <button
          type="button"
          className="primary"
          data-testid="inspect-save"
          disabled={saving}
          onClick={onSaveToSource}
        >
          {saving ? 'Saving…' : justSaved ? 'Saved ✓' : 'Save to source'}
        </button>
      </footer>
      {error ? <div className="inspect-panel-error">{error}</div> : null}
    </aside>
  );
}
