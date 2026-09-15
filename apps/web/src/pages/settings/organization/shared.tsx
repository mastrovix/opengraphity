/**
 * Pezzi comuni delle sezioni della pagina Organizzazione: la scheda con la
 * descrizione in testa, lo stato di caricamento e l'avviso «valori di
 * fabbrica». Stessa impaginazione delle sezioni già presenti (SectionCard non
 * richiudibile, corpo a 16px).
 */
import type { ReactNode } from 'react'
import { SectionCard } from '@/components/ui/SectionCard'
import { Skeleton } from '@/components/ui/skeleton'
import { QueryError } from '@/components/QueryError'
import { colors } from '@/lib/tokens'

export function OrgSection({ title, description, loading, error, onRetry, children }: {
  title: string; description: string; loading: boolean; error?: { message: string } | null
  onRetry?: () => void; children?: ReactNode
}) {
  return (
    <div style={{ marginTop: 16 }}>
      <SectionCard collapsible={false} title={title}>
        <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 14 }}>
          <p style={{ margin: 0, color: colors.slateLight, fontSize: 'var(--font-size-body)', lineHeight: 1.55, maxWidth: '80ch' }}>{description}</p>
          {error ? <QueryError message={error.message} onRetry={onRetry} /> : null}
          {loading ? <Skeleton style={{ height: 38, maxWidth: 320 }} /> : children}
        </div>
      </SectionCard>
    </div>
  )
}

export function Hint({ children, tone = 'muted' }: { children: ReactNode; tone?: 'muted' | 'danger' }) {
  return (
    <p role={tone === 'danger' ? 'alert' : undefined} style={{ margin: 0, fontSize: 'var(--font-size-label)', lineHeight: 1.5, color: tone === 'danger' ? 'var(--color-danger-text)' : colors.slateLight }}>
      {children}
    </p>
  )
}

export function GroupLabel({ children }: { children: ReactNode }) {
  return (
    <div style={{ fontSize: 'var(--font-size-label)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em', color: colors.slateLight }}>
      {children}
    </div>
  )
}
