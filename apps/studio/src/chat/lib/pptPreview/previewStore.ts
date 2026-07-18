/**
 * PPT-master live preview — staged annotation store.
 *
 * The deleted svg_editor Flask server kept unsaved annotations in the
 * SERVER PROCESS's memory (`app.config['ANNOTATIONS']`), which is why they
 * survived a tab switch: LivePreviewEditor unmounted (SlidesWorkspace's tab
 * switch is a real unmount, not a keep-alive hide like CanvasConfirm's), but
 * the server process didn't, and a remount re-fetched from it. With no
 * server process left, that survival has to come from somewhere else — a
 * module-level store, keyed by project directory so returning to the SAME
 * project's preview finds its staged work again, and a DIFFERENT project's
 * mount never sees stale data.
 *
 * Each slide's staged map is a DELTA against disk, not the full displayed
 * set — a value of `null` is an explicit tombstone ("remove this element's
 * annotation even though disk still has it"), not merely an absent key.
 * Without the tombstone, deleting an already-saved (on-disk) annotation and
 * then revisiting the slide (pickSlide reloads unconditionally, not gated
 * on mtime) would silently resurrect it: the merge is `{...diskMap,
 * ...staged}`, and an ABSENT key in `staged` doesn't override anything —
 * only an explicit `null` does. `clearSlideStaged` drops a slide's whole
 * delta once a save lands (disk is authoritative again at that point; a
 * stale delta would otherwise re-apply itself, or resurrect a tombstoned
 * element, forever).
 *
 * `pendingEdits` (direct element edits: text/attrs/tspan-promotion) is
 * intentionally NOT modeled here — that feature was never carried over from
 * the old browser editor to the native one (see live-preview.md's feature
 * list). If it's added later, it slots in next to `annotations` with the
 * same per-project, per-slide keying.
 */

import { create } from 'zustand'

/** `null` = tombstone (explicitly removed, must not fall back to disk). */
export type StagedAnnotationMap = Record<string, string | null>

export interface ProjectPreviewState {
  /** slideName → elementId → staged value (see module docstring for the
   *  `null` tombstone rule). Empty/absent for a slide means "no staged
   *  delta — disk is the whole story". */
  annotations: Record<string, StagedAnnotationMap>
  /** slideName → mtime at the moment it was last read via
   *  PPT_PREVIEW_READ_SLIDE — the compare-and-swap basis a save sends back. */
  baseMtimes: Record<string, number>
}

function emptyProjectState(): ProjectPreviewState {
  return { annotations: {}, baseMtimes: {} }
}

interface PreviewStoreState {
  byProject: Record<string, ProjectPreviewState>
  setAnnotation: (projectDir: string, slideName: string, elementId: string, text: string) => void
  removeAnnotation: (projectDir: string, slideName: string, elementId: string) => void
  setBaseMtime: (projectDir: string, slideName: string, mtime: number) => void
  /** Drop a slide's whole staged delta — called once its content has been
   *  durably written to disk (a successful save), so disk becomes the sole
   *  source of truth again until the next local edit. */
  clearSlideStaged: (projectDir: string, slideName: string) => void
}

export const usePreviewStore = create<PreviewStoreState>((set) => ({
  byProject: {},

  setAnnotation: (projectDir, slideName, elementId, text) =>
    set((s) => {
      const proj = s.byProject[projectDir] ?? emptyProjectState()
      const slideMap: StagedAnnotationMap = { ...(proj.annotations[slideName] ?? {}), [elementId]: text }
      return {
        byProject: {
          ...s.byProject,
          [projectDir]: { ...proj, annotations: { ...proj.annotations, [slideName]: slideMap } }
        }
      }
    }),

  removeAnnotation: (projectDir, slideName, elementId) =>
    set((s) => {
      const proj = s.byProject[projectDir] ?? emptyProjectState()
      const slideMap: StagedAnnotationMap = { ...(proj.annotations[slideName] ?? {}), [elementId]: null }
      return {
        byProject: {
          ...s.byProject,
          [projectDir]: { ...proj, annotations: { ...proj.annotations, [slideName]: slideMap } }
        }
      }
    }),

  setBaseMtime: (projectDir, slideName, mtime) =>
    set((s) => {
      const proj = s.byProject[projectDir] ?? emptyProjectState()
      return {
        byProject: {
          ...s.byProject,
          [projectDir]: { ...proj, baseMtimes: { ...proj.baseMtimes, [slideName]: mtime } }
        }
      }
    }),

  clearSlideStaged: (projectDir, slideName) =>
    set((s) => {
      const proj = s.byProject[projectDir]
      if (!proj || !(slideName in proj.annotations)) return s
      const annotations = { ...proj.annotations }
      delete annotations[slideName]
      return { byProject: { ...s.byProject, [projectDir]: { ...proj, annotations } } }
    })
}))

/**
 * Merge a slide's disk annotations with its staged delta — `null` tombstones
 * drop the key, any other staged value overrides disk, and everything else
 * passes through from disk unchanged. This is the ONE place "what should
 * currently be displayed / saved" gets computed; both loadSlide (display)
 * and applyChanges (save payload) call it so they can never disagree.
 */
export function mergeStagedAnnotations(
  diskAnnotations: Record<string, string>,
  staged: StagedAnnotationMap | undefined
): Record<string, string> {
  const merged = { ...diskAnnotations }
  if (staged) {
    for (const [elementId, value] of Object.entries(staged)) {
      if (value === null) delete merged[elementId]
      else merged[elementId] = value
    }
  }
  return merged
}

// ---------------------------------------------------------------------------
// Save-time diff → jsonl log records. Pure (no store/IPC dependency) so it's
// unit-testable on its own — port of the diff loop at the top of the old
// server.py's `save_all` handler.
// ---------------------------------------------------------------------------

export interface AnnotationLogRecord {
  ts: number
  file: string
  element_id: string
  action: 'annotation_saved' | 'annotation_updated' | 'annotation_removed'
  old: string | null
  new: string | null
}

/**
 * Diff a slide's on-disk annotation snapshot (`oldAnnotations`, read at
 * load time) against what's being saved (`newAnnotations`, the MERGED —
 * see `mergeStagedAnnotations` — set) and produce the jsonl records
 * PPT_PREVIEW_SAVE_ALL appends. `ts` is Unix seconds (pass `Date.now() /
 * 1000` — matches the old server's `time.time()`, which this log's
 * readers/format expect).
 *
 * Action rule ported verbatim from server.py: a brand-new element_id, OR one
 * whose text is UNCHANGED, both log as `annotation_saved`; only an existing
 * element_id whose text actually differs logs as `annotation_updated`. Any
 * element_id present in `oldAnnotations` but absent from `newAnnotations`
 * logs as `annotation_removed`.
 */
export function buildAnnotationLog(
  slideName: string,
  oldAnnotations: Record<string, string>,
  newAnnotations: Record<string, string>,
  ts: number
): AnnotationLogRecord[] {
  const records: AnnotationLogRecord[] = []
  for (const [elementId, text] of Object.entries(newAnnotations)) {
    const oldText = oldAnnotations[elementId]
    const action: AnnotationLogRecord['action'] =
      oldText === undefined || oldText === text ? 'annotation_saved' : 'annotation_updated'
    records.push({
      ts,
      file: slideName,
      element_id: elementId,
      action,
      old: oldText ?? null,
      new: text
    })
  }
  for (const [elementId, oldText] of Object.entries(oldAnnotations)) {
    if (elementId in newAnnotations) continue
    records.push({
      ts,
      file: slideName,
      element_id: elementId,
      action: 'annotation_removed',
      old: oldText,
      new: null
    })
  }
  return records
}
