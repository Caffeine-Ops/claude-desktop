/**
 * FileTypeIcon — a coloured, per-type file glyph picked by extension.
 *
 * Four places render a "this is a file" chip/card: the composer
 * attachment chip, the user-bubble `@path` mention chip, the assistant
 * file card, and the ProseMirror composer mention chip (chipNodeView).
 * They all share THIS table so a PDF / Word / Excel / PowerPoint / HTML
 * / image / archive / code file shows its own recognisable colour icon.
 *
 * Icon family: Icons8 "Color" set (flat multi-colour fills, 48×48
 * viewBox). These are full coloured SVGs — NOT single-stroke Lucide
 * glyphs — so each `<path>` carries its own `fill`. That means the icon
 * looks the same on any surface and does NOT inherit `currentColor`; we
 * render it at the requested pixel size regardless of the surrounding
 * text colour.
 *
 * Shape of the table: each type maps to an array of `{ d, fill }`. The
 * React component below maps them to `<path>` elements; the exported
 * `fileTypeIconPaths` returns the same array so chipNodeView.ts (which
 * builds its glyph with imperative DOM, outside React) can draw the
 * identical icon.
 */

export type IconPath = { d: string; fill: string }

// ── Icon path tables (Icons8 Color) ────────────────────────────────

// Microsoft Word — blue document with white "W".
const WORD: readonly IconPath[] = [
  { d: 'M41,10H25v28h16c0.553,0,1-0.447,1-1V11C42,10.447,41.553,10,41,10z', fill: '#2196F3' },
  { d: 'M25 15.001H39V17H25zM25 19H39V21H25zM25 23.001H39V25.001H25zM25 27.001H39V29H25zM25 31H39V33.001H25z', fill: '#FFF' },
  { d: 'M27 42L6 38 6 10 27 6z', fill: '#0D47A1' },
  { d: 'M21.167,31.012H18.45l-1.802-8.988c-0.098-0.477-0.155-0.996-0.174-1.576h-0.032c-0.043,0.637-0.11,1.162-0.197,1.576l-1.85,8.988h-2.827l-2.86-14.014h2.675l1.536,9.328c0.062,0.404,0.111,0.938,0.143,1.607h0.042c0.019-0.498,0.098-1.051,0.223-1.645l1.97-9.291h2.622l1.785,9.404c0.062,0.348,0.119,0.846,0.17,1.511h0.031c0.02-0.515,0.073-1.035,0.16-1.563l1.503-9.352h2.468L21.167,31.012z', fill: '#FFF' }
]

// Microsoft Excel — green sheet with white "X".
const EXCEL: readonly IconPath[] = [
  { d: 'M41,10H25v28h16c0.553,0,1-0.447,1-1V11C42,10.447,41.553,10,41,10z', fill: '#4CAF50' },
  { d: 'M25 15.001H39V17H25zM25 19H39V21H25zM25 23.001H39V25.001H25zM25 27.001H39V29H25zM25 31H39V33.001H25z', fill: '#FFF' },
  { d: 'M27 42L6 38 6 10 27 6z', fill: '#2E7D32' },
  { d: 'M19.129,31l-2.165-4.83C16.825,25.856,16.7,25.531,16.6,25.182h-0.034c-0.046,0.165-0.184,0.502-0.415,1.011L13.971,31H11.18l3.987-7.026l-3.652-6.974h2.851l1.803,4.255c0.141,0.323,0.269,0.706,0.383,1.149h0.029c0.071-0.268,0.206-0.66,0.404-1.176l2.005-4.228h2.609l-3.759,6.948L23.802,31H19.129z', fill: '#FFF' }
]

// Microsoft PowerPoint — orange document with white "P".
const PPT: readonly IconPath[] = [
  { d: 'M41,10H25v28h16c0.553,0,1-0.447,1-1V11C42,10.447,41.553,10,41,10z', fill: '#FF7043' },
  { d: 'M25 15.001H39V17H25zM25 19H39V21H25zM25 23.001H39V25.001H25zM25 27.001H39V29H25zM25 31H39V33.001H25z', fill: '#FFF' },
  { d: 'M27 42L6 38 6 10 27 6z', fill: '#D84315' },
  { d: 'M16.991,24.231v6.769h-2.667V17.013h4.181c3.013,0,4.52,1.227,4.52,3.681c0,1.158-0.416,2.093-1.249,2.804s-1.949,1.067-3.349,1.067h-1.436V24.231z M16.991,19.077v3.123h1.05c1.435,0,2.152-0.525,2.152-1.578c0-1.029-0.717-1.545-2.152-1.545C18.041,19.077,16.991,19.077,16.991,19.077z', fill: '#FFF' }
]

// PDF — red document with white "PDF".
const PDF: readonly IconPath[] = [
  { d: 'M40,45H8V3h22l10,10V45z', fill: '#E53935' },
  { d: 'M38.5,14H29V4.5L38.5,14z', fill: '#FFCDD2' },
  { d: 'M16,21h-1v8h1.5v-2.5h1.4c1.6,0,2.6-1.1,2.6-2.7C20.5,22.1,19.5,21,18,21H16z M17.5,25h-1v-2.5h1c0.7,0,1.4,0.3,1.4,1.2C18.9,24.7,18.2,25,17.5,25z', fill: '#FFF' },
  { d: 'M23.5,21H21v8h2.5c2.5,0,4-1.6,4-4S26,21,23.5,21z M23.4,27.5H22.5v-5h0.9c1.6,0,2.6,1,2.6,2.5S25,27.5,23.4,27.5z', fill: '#FFF' },
  { d: 'M28.5,21v8H30v-3.5h2.5V24H30v-1.5h3V21H28.5z', fill: '#FFF' }
]

// HTML — orange shield with white code marks.
const HTML: readonly IconPath[] = [
  { d: 'M6,4l3,34l15,4l15-4l3-34H6z', fill: '#E65100' },
  { d: 'M24,8v31.9l12.1-3.2L38.6,8H24z', fill: '#FF6D00' },
  { d: 'M33.1,13H24v4h8.7l-0.3,4H24v4h7.9l-0.4,5.5L24,32.5v4.2l11.4-3.2l0.9-13.1l0.1-1.4L37.1,13H33.1z', fill: '#FFF' },
  { d: 'M24,13v4h-8.9l0.3,4H24v4h-7.6l0.5,7.3l7.1,2v-4.2l-3.5-1l-0.2-3.1H24v-4h-8.4l-0.3-4H24v-4h-8.9H24z', fill: '#EEE' }
]

// Image — generic picture (Icons8 "Image" color).
const IMAGE: readonly IconPath[] = [
  { d: 'M40 41L8 41 8 7 30 7 40 17z', fill: '#90CAF9' },
  { d: 'M38.5 17L30 17 30 8.5z', fill: '#E1F5FE' },
  { d: 'M16 21A3 3 0 1 0 16 27 3 3 0 1 0 16 21Z', fill: '#FFB74D' },
  { d: 'M13 37L24 26 31 33 26 38z', fill: '#43A047' },
  { d: 'M22 37L33 30 38 35 35 38z', fill: '#1E88E5' }
]

// Archive — zipped folder (Icons8 "Zipped File" color).
const ARCHIVE: readonly IconPath[] = [
  { d: 'M40,12H22l-4-4H8c-2.2,0-4,1.8-4,4v8h40v-4C44,13.8,42.2,12,40,12z', fill: '#FFA000' },
  { d: 'M40,12H8c-2.2,0-4,1.8-4,4v20c0,2.2,1.8,4,4,4h32c2.2,0,4-1.8,4-4V16C44,13.8,42.2,12,40,12z', fill: '#FFCA28' },
  { d: 'M22,12h4v3h-4V12z M26,15h-4v3h4V15z M22,18h4v3h-4V18z M26,21h-4v3h4V21z', fill: '#F9A825' },
  { d: 'M27,26h-6v6c0,0.6,0.4,1,1,1h4c0.6,0,1-0.4,1-1V26z M25,31h-2v-3h2V31z', fill: '#FFFFFF' }
]

// Code — generic source file (Icons8 "Code File" color).
const CODE: readonly IconPath[] = [
  { d: 'M40,45H8V3h22l10,10V45z', fill: '#90A4AE' },
  { d: 'M38.5,14H29V4.5L38.5,14z', fill: '#CFD8DC' },
  { d: 'M16.7,28.6l-3.4-3.6l3.4-3.6l-1.4-1.4l-4.8,5l4.8,5L16.7,28.6z', fill: '#FFF' },
  { d: 'M31.3,28.6l3.4-3.6l-3.4-3.6l1.4-1.4l4.8,5l-4.8,5L31.3,28.6z', fill: '#FFF' },
  { d: 'M22.5,31.8l3-13l1.9,0.4l-3,13L22.5,31.8z', fill: '#FFF' }
]

// Generic — neutral document (Icons8 "File" color), the fallback.
const GENERIC: readonly IconPath[] = [
  { d: 'M40,45H8V3h22l10,10V45z', fill: '#90CAF9' },
  { d: 'M38.5,14H29V4.5L38.5,14z', fill: '#E1F5FE' },
  { d: 'M16,21h16v2H16V21z M16,25h16v2H16V25z M16,29h11v2H16V29z', fill: '#FFF' }
]

// ── Extension → icon table ─────────────────────────────────────────
function pathsForExt(ext: string): readonly IconPath[] {
  switch (ext) {
    case 'doc':
    case 'docx':
    case 'rtf':
    case 'odt':
      return WORD
    case 'xls':
    case 'xlsx':
    case 'csv':
    case 'tsv':
    case 'ods':
      return EXCEL
    case 'ppt':
    case 'pptx':
    case 'key':
    case 'odp':
      return PPT
    case 'pdf':
      return PDF
    case 'html':
    case 'htm':
    case 'xml':
      return HTML
    case 'png':
    case 'jpg':
    case 'jpeg':
    case 'gif':
    case 'webp':
    case 'bmp':
    case 'tiff':
    case 'ico':
    case 'avif':
    case 'heic':
    case 'svg':
      return IMAGE
    case 'zip':
    case 'rar':
    case '7z':
    case 'tar':
    case 'gz':
    case 'tgz':
    case 'bz2':
    case 'xz':
      return ARCHIVE
    case 'js':
    case 'jsx':
    case 'ts':
    case 'tsx':
    case 'mjs':
    case 'cjs':
    case 'py':
    case 'rb':
    case 'go':
    case 'rs':
    case 'java':
    case 'kt':
    case 'swift':
    case 'c':
    case 'h':
    case 'cc':
    case 'cpp':
    case 'cs':
    case 'php':
    case 'sh':
    case 'json':
    case 'yaml':
    case 'yml':
    case 'toml':
    case 'css':
    case 'scss':
      return CODE
    default:
      return GENERIC
  }
}

/** Pull the lowercase extension from a path or file name. */
export function extOf(pathOrName: string): string {
  const base = pathOrName.split(/[\\/]/).pop() ?? pathOrName
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : ''
}

/**
 * The coloured `<path>` specs for a path/name's file type. Exported so
 * the ProseMirror composer chip (chipNodeView.ts), which builds its
 * glyph with imperative DOM rather than React, can draw the SAME
 * per-type coloured icon as the React chips/cards here.
 */
export function fileTypeIconPaths(pathOrName: string): readonly IconPath[] {
  return pathsForExt(extOf(pathOrName))
}

export function FileTypeIcon({
  pathOrName,
  size = 18,
  className
}: {
  /** A path or file name; only its extension is inspected. */
  pathOrName: string
  /** Pixel size of the square SVG. */
  size?: number
  /** Extra classes (e.g. opacity / shrink-0). */
  className?: string
}): React.JSX.Element {
  const paths = pathsForExt(extOf(pathOrName))
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      aria-hidden="true"
      className={className}
    >
      {paths.map((p, i) => (
        <path key={i} d={p.d} fill={p.fill} />
      ))}
    </svg>
  )
}
