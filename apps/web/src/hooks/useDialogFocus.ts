/**
 * The keyboard contract of a dialog that declares `aria-modal="true"` (tour of
 * 23 Sep 2026): when it opens the focus moves inside — unless something inside
 * already took it, e.g. an input with autoFocus — Tab and Shift+Tab cycle
 * inside the panel, Escape closes it, and when it closes the focus goes back
 * where it was. It lived inside `Modal`; two dialogs that draw their own panel
 * (the form builder's centred modal and the widget editor) declared
 * `aria-modal` without it, so Tab walked out into the page behind them. A
 * dialog that cannot use `Modal` uses this hook, and "modal" means the same
 * thing everywhere.
 */
import { useEffect, type RefObject } from 'react'

export const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

export function useDialogFocus(panelRef: RefObject<HTMLElement | null>, open: boolean, onClose: () => void): void {
  // Escape closes; Tab / Shift+Tab cycle inside the panel (minimal focus trap).
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { onClose(); return }
      if (e.key !== 'Tab') return
      const panel = panelRef.current
      if (!panel) return
      const focusable = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE))
        .filter((el) => el.offsetParent !== null || el === document.activeElement)
      if (focusable.length === 0) { e.preventDefault(); return }
      const first = focusable[0]!
      const last  = focusable[focusable.length - 1]!
      const active = document.activeElement
      if (!panel.contains(active)) { e.preventDefault(); first.focus(); return }
      if (e.shiftKey && active === first) { e.preventDefault(); last.focus() }
      else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus() }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose, panelRef])

  // Move focus inside the dialog on open — unless something inside already
  // grabbed it (e.g. an input with autoFocus) — and give it back on close.
  useEffect(() => {
    if (!open) return
    const previouslyFocused = document.activeElement as HTMLElement | null
    queueMicrotask(() => {
      const panel = panelRef.current
      if (!panel || panel.contains(document.activeElement)) return
      panel.querySelector<HTMLElement>(FOCUSABLE)?.focus()
    })
    return () => { previouslyFocused?.focus?.() }
  }, [open, panelRef])
}
