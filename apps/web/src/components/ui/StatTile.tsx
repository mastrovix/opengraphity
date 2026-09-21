/**
 * IL BOX NUMERICO, in un posto solo.
 *
 * Ce n'erano quattro, ognuno scritto a mano nella sua pagina e ognuno diverso:
 * i riquadri di Monitoraggio (salute dei CI, servizi) con numero grande,
 * etichetta maiuscola, ombra e raggio 12; e poi SLA Report (bordo chiaro, niente
 * sfondo né ombra, numero piccolo, etichetta minuscola), Anomalie (etichetta
 * SOPRA il numero) e Sincronizzazione (raggio 8, icona accanto all'etichetta).
 * Passando da una pagina all'altra la stessa cosa — un numero con il suo nome —
 * aveva quattro facce.
 *
 * Il riferimento è il riquadro di Monitoraggio, il più curato. I riquadri
 * CLICCABILI di Monitoraggio (che filtrano la tabella) restano i loro, perché
 * hanno uno stato attivo; questo è il box che si LEGGE.
 */
import type { ReactNode } from 'react'

export interface StatTileProps {
  label:    ReactNode
  value:    ReactNode
  /** Colore del numero (e dell'icona). Di default il testo scuro. */
  accent?:  string
  /** Tinta del cerchio dell'icona; senza, l'icona non ha cerchio colorato. */
  tint?:    string
  icon?:    ReactNode
  /** Una riga di contesto sotto, in grigio. */
  context?: ReactNode
}

export function StatTile({ label, value, accent, tint, icon, context }: StatTileProps) {
  return (
    <div style={{
      textAlign: 'left', padding: '14px 16px', borderRadius: 12, minWidth: 0,
      background: 'var(--color-white)', border: '1px solid var(--border)', boxShadow: 'var(--shadow-card)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        {icon && (
          <span aria-hidden="true" style={{
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 36, height: 36,
            borderRadius: 999, background: tint ?? 'var(--color-slate-bg)', color: accent ?? 'var(--color-slate)', flexShrink: 0,
          }}>
            {icon}
          </span>
        )}
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 28, lineHeight: 1.1, fontWeight: 700, color: accent ?? 'var(--color-slate-dark)', fontVariantNumeric: 'tabular-nums' }}>
            {value}
          </div>
          <div style={{ fontSize: 'var(--font-size-table)', fontWeight: 600, color: 'var(--color-slate)', textTransform: 'uppercase', letterSpacing: '0.04em', marginTop: 2 }}>
            {label}
          </div>
        </div>
      </div>
      {context && <div style={{ fontSize: 'var(--font-size-table)', color: 'var(--color-slate-light)', marginTop: 10 }}>{context}</div>}
    </div>
  )
}

/** La griglia dei box: stessa di Monitoraggio, si adatta alla larghezza senza lasciare un box da solo su una riga lunga. */
export function StatTileGrid({ children }: { children: ReactNode }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 12, marginBottom: 20 }}>
      {children}
    </div>
  )
}
