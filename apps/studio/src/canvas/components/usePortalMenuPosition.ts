// Shared positioning + dismissal logic for dropdown menus that must escape
// their local stacking context by portaling to <body>.
//
// Why this exists: several dropdowns (the handoff picker, the FileViewer
// present/share menus) render inside the project chrome, which is its own
// stacking context. A menu rendered in-place there — however high its
// z-index — can be painted UNDER the viewer toolbar stacked above it, because
// z-index only compares within one stacking context. The fix is to portal the
// menu to document.body and position it `fixed`, measured from its trigger.
// This hook packages the measure/reposition/dismiss mechanics so each call
// site stays thin (see HandoffButton for the original hand-rolled version).
//
// Usage:
//   const { wrapRef, menuRef, menuPos } = usePortalMenuPosition(open, setOpen);
//   <div ref={wrapRef}> <button onClick={() => setOpen(v => !v)}/> </div>
//   {open && menuPos && typeof document !== 'undefined'
//     ? createPortal(
//         <div ref={menuRef} style={{ position:'fixed', top: menuPos.top, right: menuPos.right }} />,
//         document.body)
//     : null}

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from 'react';

export interface PortalMenuPosition {
  top: number;
  /** Distance from the viewport's right edge — the menu right-aligns to the
   *  trigger's right edge, the way these dropdowns hang down from a caret. */
  right: number;
}

export interface UsePortalMenuPositionResult<
  W extends HTMLElement = HTMLDivElement,
  M extends HTMLElement = HTMLDivElement,
> {
  /** Attach to the trigger's wrapper — the rect we measure to place the menu. */
  wrapRef: React.RefObject<W | null>;
  /** Attach to the portaled menu — kept separate because, living under
   *  <body>, it is NOT inside wrapRef's subtree, so outside-click needs both. */
  menuRef: React.RefObject<M | null>;
  /** Fixed-position coords; null until measured (gate rendering on it so the
   *  menu never flashes at 0,0 before the layout effect runs). */
  menuPos: PortalMenuPosition | null;
}

export function usePortalMenuPosition<
  W extends HTMLElement = HTMLDivElement,
  M extends HTMLElement = HTMLDivElement,
>(
  open: boolean,
  // Accept the full useState setter type so call sites can keep their existing
  // `setOpen(v => !v)` toggles unchanged.
  setOpen: Dispatch<SetStateAction<boolean>>,
): UsePortalMenuPositionResult<W, M> {
  const wrapRef = useRef<W | null>(null);
  const menuRef = useRef<M | null>(null);
  const [menuPos, setMenuPos] = useState<PortalMenuPosition | null>(null);

  // Measure on open + on resize. A fixed menu doesn't follow scroll, so we
  // close on scroll instead of re-tracking — the standard dropdown behaviour
  // and far cheaper. useLayoutEffect measures before paint so the menu never
  // flashes at (0,0).
  useLayoutEffect(() => {
    if (!open) {
      setMenuPos(null);
      return;
    }
    function place() {
      const el = wrapRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      setMenuPos({ top: r.bottom + 6, right: window.innerWidth - r.right });
    }
    place();
    function onScroll() {
      setOpen(false);
    }
    window.addEventListener('resize', place);
    // Capture phase so any ancestor scroll container (not just window) closes it.
    window.addEventListener('scroll', onScroll, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [open, setOpen]);

  // Outside-click + Escape. The menu is portaled out of wrapRef's subtree, so
  // a click inside the open menu would otherwise read as "outside" and dismiss
  // it — check menuRef too.
  useEffect(() => {
    if (!open) return;
    function onPointer(e: MouseEvent) {
      const target = e.target as Node;
      if (wrapRef.current?.contains(target)) return;
      if (menuRef.current?.contains(target)) return;
      setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, setOpen]);

  return { wrapRef, menuRef, menuPos };
}
