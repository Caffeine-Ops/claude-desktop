import React from 'react'

/* ───────────────────── shared sub-components ─────────────────── */

export function DiffView({
  oldText,
  newText
}: {
  oldText: string
  newText: string
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-0.5 font-mono text-[11.5px] leading-snug">
      {oldText && (
        <pre className="max-h-40 max-w-full overflow-auto whitespace-pre rounded-sm bg-red-500/10 px-2 py-1 text-red-400/90">
          {oldText.split('\n').map((line, i) => (
            <div key={i}>
              <span aria-hidden className="select-none opacity-60">
                -{' '}
              </span>
              {line || '\u200b'}
            </div>
          ))}
        </pre>
      )}
      {newText && (
        <pre className="max-h-40 max-w-full overflow-auto whitespace-pre rounded-sm bg-emerald-500/10 px-2 py-1 text-emerald-400/90">
          {newText.split('\n').map((line, i) => (
            <div key={i}>
              <span aria-hidden className="select-none opacity-60">
                +{' '}
              </span>
              {line || '\u200b'}
            </div>
          ))}
        </pre>
      )}
    </div>
  )
}

export function TodoStatusMark({ status }: { status: string }): React.JSX.Element {
  if (status === 'completed') {
    return (
      <svg
        width="12"
        height="12"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="text-emerald-500"
        aria-hidden
      >
        <polyline points="20 6 9 17 4 12" />
      </svg>
    )
  }
  if (status === 'in_progress') {
    return (
      <span
        aria-hidden
        className="block size-[7px] rounded-full bg-accent"
      />
    )
  }
  return (
    <span
      aria-hidden
      className="block size-[7px] rounded-full border border-muted-foreground/40"
    />
  )
}
