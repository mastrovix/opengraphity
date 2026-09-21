/**
 * Presentational + styling helpers shared by the TaskViewPage form modules.
 */
import { colors } from '@/lib/tokens'

export const inputStyle: React.CSSProperties = {
  width: '100%', padding: '8px 12px', border: `1px solid ${colors.border}`, borderRadius: 6,
  fontSize: 'var(--font-size-body)', color: 'var(--color-slate-dark)', boxSizing: 'border-box',
}

export const labelStyle: React.CSSProperties = {
  display: 'block', fontSize: 'var(--font-size-label)', fontWeight: 600,
  color: 'var(--color-slate-light)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 6,
}

/** Chiavi del titolo del task per tipo: la lingua la decide il client. */
export const KIND_TITLE_KEY: Record<string, string> = {
  assessment: 'changeTasks.kind.assessment', 'deploy-plan': 'changeTasks.kind.deployPlan',
  validation: 'changeTasks.kind.validation', deployment: 'changeTasks.kind.deployment', review: 'changeTasks.kind.review',
}

/**
 * ISO → valore di un campo `datetime-local`, nel fuso indicato (revisione
 * totale · F-13).
 *
 * Senza `timeZone` vale il fuso del browser, come prima: è il ripiego finché
 * la risposta col fuso dell'organizzazione non è arrivata, e chi mostra il
 * campo scrive accanto quale fuso sta usando. Le finestre di rilascio si
 * pianificano nel fuso dell'ORGANIZZAZIONE: un operatore in viaggio che
 * digitava 22:00 le salvava alle 22:00 del suo posto, cioè a un'altra ora per
 * il cliente.
 */
export function toLocal(iso: string, timeZone?: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ''
  if (!timeZone) {
    const pad = (n: number) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
  }
  // `sv-SE` dà «AAAA-MM-GG HH:MM», che è il formato del campo con uno spazio.
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(d).replace(' ', 'T')
}

/** Quanti minuti il fuso è avanti rispetto a UTC in quell'istante (F-13). */
function zoneOffsetMinutes(at: Date, timeZone: string): number {
  const asUtc = new Date(new Intl.DateTimeFormat('sv-SE', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(at).replace(' ', 'T') + 'Z')
  return Math.round((asUtc.getTime() - at.getTime()) / 60_000)
}

/**
 * Valore del campo → ISO, leggendolo nel fuso indicato (F-13). Due passaggi:
 * il primo con l'offset del momento indicato, il secondo per i casi a cavallo
 * dell'ora legale, dove l'offset cambia proprio in quel giorno.
 */
export function fromLocal(v: string, timeZone?: string | null): string {
  if (!v) return ''
  if (!timeZone) return new Date(v).toISOString()
  const naive = new Date(`${v}:00Z`)
  if (isNaN(naive.getTime())) return ''
  let instant = new Date(naive.getTime() - zoneOffsetMinutes(naive, timeZone) * 60_000)
  instant = new Date(naive.getTime() - zoneOffsetMinutes(instant, timeZone) * 60_000)
  return instant.toISOString()
}

export function StickyAction({ label, disabled, blockReason, onClick }: {
  label: string; disabled: boolean; blockReason?: string; onClick: () => void
}) {
  return (
    <div style={{ position: 'sticky', bottom: 0, background: colors.white, borderTop: `1px solid ${colors.border}`, padding: '12px 0', marginTop: 20 }}>
      <button type="button" disabled={disabled} onClick={onClick} style={{
        width: '100%', padding: '12px 24px', borderRadius: 8, border: 'none',
        backgroundColor: 'var(--color-brand)', color: colors.white, fontSize: 'var(--font-size-card-title)',
        fontWeight: 600, cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.5 : 1,
      }}>
        {label}
      </button>
      {blockReason && <p style={{ margin: '6px 0 0', fontSize: 'var(--font-size-label)', color: 'var(--color-trigger-sla-breach)', textAlign: 'center' }}>{blockReason}</p>}
    </div>
  )
}
