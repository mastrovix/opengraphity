import { useEffect, useId, useRef } from 'react'
import { X } from 'lucide-react'

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
}

const FOCUSABLE = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'

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
}: ModalProps) {
  const titleId = useId()
  const panelRef = useRef<HTMLElement | null>(null)

  // Close on Escape while open.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  // Move focus inside the modal on open — unless something inside already
  // grabbed it (e.g. an input with autoFocus).
  useEffect(() => {
    if (!open) return
    queueMicrotask(() => {
      const panel = panelRef.current
      if (!panel || panel.contains(document.activeElement)) return
      panel.querySelector<HTMLElement>(FOCUSABLE)?.focus()
    })
  }, [open])

  if (!open) return null

  const panelStyle: React.CSSProperties = {
    background:     '#fff',
    borderRadius:   10,
    boxShadow:      '0 20px 60px rgba(0,0,0,0.15)',
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
        borderBottom:   '1px solid #e5e7eb',
        display:        'flex',
        alignItems:     'center',
        justifyContent: 'space-between',
        flexShrink:     0,
      }}>
        <span id={titleId} style={{ fontSize: 'var(--font-size-card-title)', fontWeight: 600, color: 'var(--color-slate-dark)' }}>{title}</span>
        <button
          type="button"
          onClick={onClose}
          aria-label="Chiudi"
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
          borderTop:      '1px solid #e5e7eb',
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

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      style={{
        position:       'fixed',
        inset:          0,
        background:     'rgba(0,0,0,0.45)',
        zIndex,
        display:        'flex',
        alignItems:     'center',
        justifyContent: 'center',
      }}
      onClick={onClose}
    >
      {as === 'form' ? (
        <form
          ref={(el) => { panelRef.current = el }}
          style={panelStyle}
          onClick={(e) => e.stopPropagation()}
          onSubmit={onSubmit}
        >
          {content}
        </form>
      ) : (
        <div
          ref={(el) => { panelRef.current = el }}
          style={panelStyle}
          onClick={(e) => e.stopPropagation()}
        >
          {content}
        </div>
      )}
    </div>
  )
}
