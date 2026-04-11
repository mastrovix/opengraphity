import { X } from 'lucide-react'

interface ModalProps {
  open: boolean
  onClose: () => void
  title: string
  children: React.ReactNode
  footer?: React.ReactNode
  width?: number
}

export function Modal({ open, onClose, title, children, footer, width = 480 }: ModalProps) {
  if (!open) return null

  return (
    <div
      style={{
        position:       'fixed',
        inset:          0,
        background:     'rgba(0,0,0,0.45)',
        zIndex:         1000,
        display:        'flex',
        alignItems:     'center',
        justifyContent: 'center',
      }}
      onClick={onClose}
    >
      <div
        style={{
          background:     '#fff',
          borderRadius:   10,
          boxShadow:      '0 20px 60px rgba(0,0,0,0.15)',
          width,
          maxWidth:       '90vw',
          maxHeight:      '90vh',
          overflow:       'hidden',
          display:        'flex',
          flexDirection:  'column',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div style={{
          padding:        '20px 24px',
          borderBottom:   '1px solid #e5e7eb',
          display:        'flex',
          alignItems:     'center',
          justifyContent: 'space-between',
          flexShrink:     0,
        }}>
          <span style={{ fontSize: 'var(--font-size-card-title)', fontWeight: 600, color: 'var(--color-slate-dark)' }}>{title}</span>
          <button
            onClick={onClose}
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
          }}>
            {footer}
          </div>
        )}
      </div>
    </div>
  )
}
