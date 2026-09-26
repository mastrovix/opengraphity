/**
 * Sezione unica "Ticket collegati" (incident, problem, change): un solo box
 * collassabile con conteggio totale, righe RAGGRUPPATE per tipologia e un
 * pannello "Collega" con selettore di tipo.
 *
 * La ricerca vive QUI: le query per tipo partono solo quando il pannello è
 * aperto e il tab è attivo (niente fetch eager a ogni apertura del dettaglio),
 * e il filtro per numero/titolo è applicato lato client per tutti i tipi —
 * `changes(...)` non ha un argomento `search` e prima il tab Change non
 * filtrava affatto. `excludeId` toglie il ticket corrente dai risultati
 * (un problem non può collegarsi a sé stesso).
 *
 * I link non rimovibili (removable === false, es. change auto-collegate)
 * mostrano un lucchetto invece della ✕.
 */
import { Pill } from '@/components/ui/Pill'
import { Button } from '@/components/Button'
import { useTranslation } from 'react-i18next'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery } from '@apollo/client/react'
import { Plus, X, Lock } from 'lucide-react'
import { SectionCard } from '@/components/ui/SectionCard'
import { Input } from '@/components/ui/FormControls'
import { GET_INCIDENTS, GET_PROBLEMS, GET_CHANGES } from '@/graphql/queries'
import { colors, palette } from '@/lib/tokens'
import { useWorkflowSteps } from '@/hooks/useWorkflowSteps'

export interface LinkedTicketItem { id: string; number: string; title: string; status: string; removable?: boolean | null }

export type LinkedKind = 'INCIDENT' | 'PROBLEM' | 'CHANGE'

export interface LinkedTypeConfig {
  kind:      LinkedKind
  label:     string            // etichetta nel selettore, es. "Incident"
  routeBase: string            // es. '/incidents'
  items:     LinkedTicketItem[]
  onLink:    (id: string) => void
  onUnlink:  (id: string) => void
  /**
   * Whether the reader may link and unlink this kind: each link has its own
   * permission on the API (review of 23 Sep 2026), so the caller says it.
   */
  canEdit:   boolean
}

const BADGE: Record<LinkedKind, string> = {
  INCIDENT: 'var(--color-trigger-sla-breach)',
  PROBLEM:  'var(--color-slate)',
  CHANGE:   'var(--color-brand)',
}

/** Il tipo di entità del workflow, per tradurre il nome del passo (F-33). */
const ENTITY_TYPE: Record<LinkedKind, string> = {
  INCIDENT: 'incident',
  PROBLEM:  'problem',
  CHANGE:   'change',
}

/**
 * La FASE di un ticket collegato con l'etichetta del workflow, non il nome
 * tecnico con i trattini bassi tolti (revisione totale · F-33): un passo
 * rinominato dal cliente si leggeva «in progress» invece di «In lavorazione».
 *
 * A step the workflow does not know reads as its name made readable: that
 * is `labelFor`'s own fallback now. The one written here never ran, since
 * `labelFor` gave back the raw name, and the row showed «waiting_vendor»
 * (tour of 23 Sep 2026).
 */
function StepCell({ kind, status }: { kind: LinkedKind; status: string }) {
  const { labelFor } = useWorkflowSteps(ENTITY_TYPE[kind])
  const label = status ? labelFor(status) : '—'
  return (
    <span style={{ width: 120, fontSize: 'var(--font-size-label)', color: 'var(--color-slate-light)' }}>{label}</span>
  )
}

/**
 * La ricerca la fa il SERVER (revisione totale · F-8).
 *
 * Incident e change venivano caricati coi 50 più recenti e filtrati nel
 * browser: su un tenant con trecento incident, cercare per numero non trovava
 * il ticket e l'utente concludeva che non esistesse. `incidents` e `changes`
 * non hanno un argomento `search`, ma hanno `filters` — lo stesso JSON del
 * costruttore di filtri: qui si compone «numero contiene X OPPURE titolo
 * contiene X», che è quello che la modale chiede.
 */
function searchFilters(term: string, numberField: string): string | undefined {
  const q = term.trim()
  if (q === '') return undefined
  return JSON.stringify({
    rules: [
      { id: 'n', field: numberField, operator: 'contains', value: q, logic: 'OR' },
      { id: 't', field: 'title',     operator: 'contains', value: q, logic: 'OR' },
    ],
  })
}

/** Risultati di ricerca per il tipo attivo: query lazy (skip quando il tab non è attivo). */
function useLinkSearch(kind: LinkedKind | null, term: string): LinkedTicketItem[] {
  const { data: inc } = useQuery<{ incidents: { items: LinkedTicketItem[] } }>(GET_INCIDENTS, {
    variables: { limit: 50, filters: searchFilters(term, 'number') }, skip: kind !== 'INCIDENT',
  })
  const { data: prb } = useQuery<{ problems: { items: LinkedTicketItem[] } }>(GET_PROBLEMS, {
    variables: { search: term.trim() || undefined, limit: 20 }, skip: kind !== 'PROBLEM',
  })
  const { data: chg } = useQuery<{ changes: { items: { id: string; code: string; title: string; approvalStatus?: string | null; workflowInstance?: { currentStep?: string | null } | null }[] } }>(GET_CHANGES, {
    variables: { limit: 50, filters: searchFilters(term, 'code') }, skip: kind !== 'CHANGE',
  })
  if (kind === 'INCIDENT') return inc?.incidents?.items ?? []
  if (kind === 'PROBLEM')  return prb?.problems?.items ?? []
  if (kind === 'CHANGE')   return (chg?.changes?.items ?? []).map((c) => ({ id: c.id, number: c.code, title: c.title, status: c.workflowInstance?.currentStep ?? c.approvalStatus ?? '' }))
  return []
}

export function UnifiedLinkedTickets({ title, types, excludeId }: { title: string; types: LinkedTypeConfig[]; excludeId?: string }) {
  const { t } = useTranslation()
  const [showSearch, setShowSearch] = useState(false)
  // Only the kinds the reader may link are offered in the search.
  const linkable = types.filter((t) => t.canEdit)
  const [activeKind, setActiveKind] = useState<LinkedKind>(linkable[0]?.kind ?? 'INCIDENT')
  const [term, setTerm] = useState('')

  const groups = types.map((t) => ({ ...t, rows: t.items })).filter((g) => g.rows.length > 0)
  const total = groups.reduce((n, g) => n + g.rows.length, 0)
  const active = linkable.find((t) => t.kind === activeKind) ?? linkable[0]
  const linkedIds = new Set(types.flatMap((t) => t.items.map((it) => it.id)))

  const raw = useLinkSearch(showSearch && active ? active.kind : null, term)
  const q = term.trim().toLowerCase()
  const results = raw
    .filter((r) => r.id !== excludeId && !linkedIds.has(r.id))
    .filter((r) => q === '' || `${r.number} ${r.title}`.toLowerCase().includes(q))
    .slice(0, 10)

  return (
    <SectionCard title={title} count={total} collapsible>
      {linkable.length > 0 && <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 8 }}>
        <Button variant="secondary" size="xs"
          onClick={() => { setShowSearch((s) => !s); setTerm('') }}
        >
          <Plus size={12} /> {t(showSearch ? 'common.close' : 'components.linkedTickets.link')}
        </Button>
      </div>}

      {showSearch && active && (
        <div style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 12, marginBottom: 12 }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
            {linkable.map((t) => (
              <button key={t.kind} type="button" onClick={() => { setActiveKind(t.kind); setTerm('') }}
                style={{ padding: '5px 12px', borderRadius: 6, border: '1px solid var(--border)', cursor: 'pointer', fontSize: 'var(--font-size-label)', fontWeight: 600, background: activeKind === t.kind ? 'var(--color-brand)' : 'transparent', color: activeKind === t.kind ? colors.white : 'var(--color-slate)' }}>
                {t.label}
              </button>
            ))}
          </div>
          <Input type="text" value={term} onChange={(e) => setTerm(e.target.value)} placeholder={t('components.linkedTickets.searchPlaceholder', { kind: active.label.toLowerCase() })}
            // eslint-disable-next-line jsx-a11y/no-autofocus -- focus management: campo di ricerca montato dopo il click su "Collega ticket"
            autoFocus
            style={{ padding: '7px 12px', borderRadius: 8, border: '1px solid var(--border)', fontSize: 'var(--font-size-body)', width: '100%', boxSizing: 'border-box' }} />
          <div style={{ marginTop: 8, maxHeight: 220, overflowY: 'auto' }}>
            {results.length === 0 ? (
              <p style={{ margin: '4px 0', fontSize: 'var(--font-size-label)', color: 'var(--color-slate-light)' }}>{t('common.noResults')}</p>
            ) : results.map((r) => (
              <button key={r.id} type="button" onClick={() => active.onLink(r.id)} className="hover-bg"
                style={{ width: '100%', textAlign: 'left', background: 'transparent', border: 'none', borderBottom: '1px solid var(--border)', padding: '8px 10px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8, fontSize: 'var(--font-size-body)', color: 'inherit', ['--hover-bg' as string]: 'var(--surface-2)' }}>
                <span style={{ fontWeight: 600, color: 'var(--color-brand)' }}>{r.number}</span>
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.title}</span>
                <Plus size={14} color="var(--color-brand)" />
              </button>
            ))}
          </div>
        </div>
      )}

      {total === 0 ? (
        <p style={{ margin: 0, fontSize: 'var(--font-size-body)', color: 'var(--color-slate-light)' }}>{t('components.linkedTickets.empty')}</p>
      ) : (
        groups.map((g) => (
          <div key={g.kind} style={{ marginBottom: 12 }}>
            {/* Intestazione del gruppo per tipologia */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0 6px', borderBottom: '2px solid var(--border)' }}>
              <Pill bg={BADGE[g.kind]} color={colors.white} radius={4} style={{ fontSize: 'var(--font-size-caption)', fontWeight: 700 }}>{g.kind}</Pill>
              <span style={{ fontSize: 'var(--font-size-label)', fontWeight: 600, color: 'var(--color-slate-dark)' }}>{g.label}</span>
              <span style={{ fontSize: 'var(--font-size-label)', color: 'var(--color-slate-light)' }}>({g.rows.length})</span>
            </div>
            {g.rows.map((r) => (
              <div key={`${g.kind}-${r.id}`} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 0', borderBottom: `1px solid ${palette.neutral.borderLight}`, fontSize: 'var(--font-size-body)' }}>
                <span style={{ width: 130 }}><Link to={`${g.routeBase}/${r.id}`} style={{ fontWeight: 600, color: 'var(--color-link)', textDecoration: 'underline', textUnderlineOffset: 2 }}>{r.number}</Link></span>
                <span style={{ flex: 1, color: 'var(--color-slate-dark)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.title}</span>
                <StepCell kind={g.kind} status={r.status} />
                <span style={{ width: 30, display: 'flex', justifyContent: 'flex-end' }}>
                  {r.removable === false ? (
                    <span title={t('components.linkedTickets.automatic')} style={{ padding: 2, color: 'var(--color-slate-light)', display: 'inline-flex' }}>
                      <Lock size={12} />
                    </span>
                  ) : g.canEdit ? (
                    <button type="button" title={t('components.linkedTickets.unlink')} onClick={() => g.onUnlink(r.id)}
                      style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 2, color: 'var(--color-slate-light)' }}>
                      <X size={14} />
                    </button>
                  ) : null}
                </span>
              </div>
            ))}
          </div>
        ))
      )}
    </SectionCard>
  )
}
