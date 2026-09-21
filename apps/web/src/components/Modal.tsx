import { useEffect, useId, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { X } from 'lucide-react'
import { alpha, colors } from '@/lib/tokens'

interface ModalProps {
  open: boolean
  onClose: () => void
  title: string
  children: React.ReactNode
  footer?: React.ReactNode
  width?: number
  /**
   * Element used for the modal panel. Use 'form' for native-validation forms:
   * body and footer render inside a <form>, so `required` / `pattern` and a
   * footer submit button work out of the box.
   */
  as?: 'div' | 'form'
  /** Submit handler — only meaningful with as="form". */
  onSubmit?: (e: React.FormEvent<HTMLFormElement>) => void
  /** Pinpoint overrides for the footer layout (e.g. space-between). */
  footerStyle?: React.CSSProperties
  /** Overlay z-index. Default unchanged (1000). */
  zIndex?: number
  /**
   * Close when the overlay (outside the panel) is clicked. Defaults to `true`
   * for plain dialogs and to `false` for `as="form"`: a stray click outside a
   * form must not throw away what the user typed (E-14).
   */
  closeOnOverlay?: boolean
}

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  width = 480,
  as = 'div',
  onSubmit,
  footerStyle,
  zIndex = 1000,
  closeOnOverlay,
}: ModalProps) {
  const { t } = useTranslation()
  const titleId = useId()
  const panelRef = useRef<HTMLElement | null>(null)
  const overlayClosesDialog = closeOnOverlay ?? (as !== 'form')

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
  }, [open, onClose])

  // Move focus inside the modal on open — unless something inside already
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
  }, [open])

  if (!open) return null

  const panelStyle: React.CSSProperties = {
    background:     colors.white,
    borderRadius:   10,
    boxShadow:      `0 20px 60px ${alpha.black15}`,
    width,
    maxWidth:       '90vw',
    maxHeight:      '90vh',
    overflow:       'hidden',
    display:        'flex',
    flexDirection:  'column',
    margin:         0,
  }

  const content = (
    <>
      {/* Header */}
      <div style={{
        padding:        '20px 24px',
        borderBottom:   '1px solid var(--border)',
        display:        'flex',
        alignItems:     'center',
        justifyContent: 'space-between',
        flexShrink:     0,
      }}>
        <span id={titleId} style={{ fontSize: 'var(--font-size-card-title)', fontWeight: 600, color: 'var(--color-slate-dark)' }}>{title}</span>
        <button
          type="button"
          onClick={onClose}
          aria-label={t('common.close')}
          style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-slate-light)', padding: 4, display: 'flex', alignItems: 'center', borderRadius: 4 }}
          onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.color = 'var(--color-slate)' }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.color = 'var(--color-slate-light)' }}
        >
          <X size={16} />
        </button>
      </div>

      {/* Body */}
      <div style={{ padding: '24px', overflowY: 'auto', flex: 1 }}>
        {children}
      </div>

      {/* Footer */}
      {footer && (
        <div style={{
          padding:        '16px 24px',
          borderTop:      '1px solid var(--border)',
          display:        'flex',
          justifyContent: 'flex-end',
          gap:            8,
          flexShrink:     0,
          ...footerStyle,
        }}>
          {footer}
        </div>
      )}
    </>
  )

  // Il pannello ferma la propagazione del click: il Modal viene montato da
  // celle di righe cliccabili (console allarmi) e da card con onClick; senza
  // questo un click nel textarea o su un risultato risalirebbe fino al
  // genitore React (il portal sposta il DOM, non l'albero degli eventi React).
  const dialogProps = {
    role: 'dialog', 'aria-modal': true, 'aria-labelledby': titleId,
    onClick: (e: React.MouseEvent) => e.stopPropagation(),
  } as const

  const overlay = (
    // Il click sull'overlay (fuori dal pannello) chiude il dialogo: è una
    // scorciatoia solo-mouse, l'equivalente da tastiera è Escape (gestito nel
    // keydown globale sopra) e il bottone "Chiudi" nell'header. Anche
    // l'overlay ferma la propagazione (stesso motivo del pannello).
    // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- overlay: chiusura via mouse, Escape/bottone per la tastiera
    <div
      style={{
        position:       'fixed',
        inset:          0,
        background:     alpha.scrim,
        zIndex,
        display:        'flex',
        alignItems:     'center',
        justifyContent: 'center',
      }}
      onClick={(e) => { e.stopPropagation(); if (overlayClosesDialog && e.target === e.currentTarget) onClose() }}
    >
      {as === 'form' ? (
        // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-noninteractive-element-interactions -- solo stopPropagation, nessuna azione
        <form
          {...dialogProps}
          ref={(el) => { panelRef.current = el }}
          style={panelStyle}
          onSubmit={onSubmit}
        >
          {content}
        </form>
      ) : (
        // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-noninteractive-element-interactions -- solo stopPropagation, nessuna azione
        <div
          {...dialogProps}
          ref={(el) => { panelRef.current = el }}
          style={panelStyle}
        >
          {content}
        </div>
      )}
    </div>
  )

  // Portal su document.body: il dialogo esce da contenitori con overflow o
  // z-index propri (tabelle scrollabili, card) e resta l'ultimo nel DOM, che
  // è anche l'ordine di focus atteso da uno screen reader.
  return createPortal(overlay, document.body)
}
