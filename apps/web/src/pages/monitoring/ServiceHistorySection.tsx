/**
 * Cronologia del servizio: timeline verticale delle voci `ServiceMap.history`
 * dalla più recente, nello stile di EventHistorySection (pallino colorato con
 * icona, frase, istante, nota). Il pallino ha il colore della salute raggiunta
 * (rosso giù, ambra degradato, verde operativo, viola manutenzione, grigio
 * sconosciuta); l'icona dice l'innesco (creazione, salute di un componente,
 * regole, mappa, manutenzione, manuale, passata periodica).
 *
 * Fail-loud: un trigger fuori vocabolario NON sparisce: pallino rosso pieno,
 * frase «Voce sconosciuta: <trigger>» e console.error (lookupOrError). La
 * salute precedente assente (prima voce) è detta in chiaro nella frase.
 *
 * Revisione 2 · C-8: il dettaglio carica le ultime 10 voci (prima 50, con le
 * cause, a ogni tick del polling). Le altre si leggono a richiesta con
 * «Mostra tutte», un documento suo che non pesa su chi non lo chiede; se la
 * lettura fallisce lo dice una riga con «Riprova», mai le 10 vecchie spacciate
 * per tutte.
 */
import { useState, type ReactNode } from 'react'
import { useQuery } from '@apollo/client/react'
import { Trans, useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { Sparkles, HeartPulse, SlidersHorizontal, GitBranch, Wrench, RotateCcw, Clock, HelpCircle, Loader2, type LucideIcon } from 'lucide-react'
import { Button } from '@/components/Button'
import { SectionCard } from '@/components/ui/SectionCard'
import { GET_SERVICE_MAP_HISTORY } from '@/graphql/queries'
import { formatDateTime, timeAgo } from '@/lib/datetime'
import { alpha, colors, lookupOrError, palette } from '@/lib/tokens'
import { TINT_BROKEN } from '@/lib/eventPalette'
import { SERVICE_HEALTH_ACCENT, ServiceHealthBadge, causeLabel } from './servicesShared'
import type { ServiceHealthEntry, ServiceHealthTrigger } from '@/types/services'

const ICON: Record<ServiceHealthTrigger, LucideIcon> = {
  created:       Sparkles,
  ci_health:     HeartPulse,
  rules_changed: SlidersHorizontal,
  map_changed:   GitBranch,
  maintenance:   Wrench,
  manual:        RotateCcw,
  periodic:      Clock,
}

/** Chiavi delle frasi, letterali (non template) così check-i18n le vede usate. */
const SENTENCE_KEY: Record<ServiceHealthTrigger, string> = {
  created:       'monitoring.services.history.trigger.created',
  ci_health:     'monitoring.services.history.trigger.ci_health',
  rules_changed: 'monitoring.services.history.trigger.rules_changed',
  map_changed:   'monitoring.services.history.trigger.map_changed',
  maintenance:   'monitoring.services.history.trigger.maintenance',
  manual:        'monitoring.services.history.trigger.manual',
  periodic:      'monitoring.services.history.trigger.periodic',
}

/** Quante cause elencare sotto la frase prima di «+N». */
const CAUSES_SHOWN = 3

function dotColor(entry: ServiceHealthEntry): string {
  return lookupOrError(SERVICE_HEALTH_ACCENT as Record<string, string>, entry.health, 'SERVICE_HISTORY_DOT', TINT_BROKEN.bg)
}

/** «db-01 giù via api-03, cache-02 degradato, +2». */
function causesLine(t: TFunction, entry: ServiceHealthEntry): string | null {
  if (entry.causes.length === 0) return null
  const shown = entry.causes.slice(0, CAUSES_SHOWN).map((c) => causeLabel(t, c))
  const rest = entry.causes.length - shown.length
  return rest > 0 ? t('monitoring.services.history.causesMore', { causes: shown.join(', '), count: rest }) : shown.join(', ')
}

function EntrySentence({ entry: e }: { entry: ServiceHealthEntry }) {
  const { t } = useTranslation()
  const key = SENTENCE_KEY[e.trigger]
  if (key === undefined) return <>{t('monitoring.services.history.trigger.unknown', { trigger: String(e.trigger) })}</>
  const components = {
    health:   <ServiceHealthBadge health={e.health} />,
    previous: e.previousHealth !== null
      ? <ServiceHealthBadge health={e.previousHealth} />
      : <span style={{ color: colors.slate, fontStyle: 'italic' }}>{t('monitoring.services.history.noPrevious')}</span>,
  }
  return <Trans i18nKey={key} values={{ score: e.impactScore }} components={components} />
}

/** Quante voci chiede «Mostra tutte» (il massimo che l'API restituisce). */
export const HISTORY_ALL_LIMIT = 500

interface Props {
  mapId:   string
  entries: ServiceHealthEntry[]
  /** Numero totale di voci (`historyCount`): può superare le voci caricate. */
  total:   number
}

interface HistoryData {
  serviceMap: { id: string; historyCount: number; history: ServiceHealthEntry[] } | null
}

export function ServiceHistorySection({ mapId, entries, total }: Props) {
  const { t } = useTranslation()
  const [showAll, setShowAll] = useState(false)
  const { data, loading, error, refetch } = useQuery<HistoryData>(GET_SERVICE_MAP_HISTORY, {
    variables: { id: mapId, limit: HISTORY_ALL_LIMIT }, skip: !showAll, fetchPolicy: 'cache-and-network',
  })

  // Finché la lettura completa non è arrivata restano le voci del dettaglio:
  // mai spacciate per «tutte» (il conteggio sotto dice sempre quante se ne vedono).
  const shown = (showAll ? data?.serviceMap?.history : null) ?? entries
  return (
    <SectionCard title={t('monitoring.services.history.title')} count={total} defaultOpen>
      {shown.length === 0
        ? <p style={{ fontSize: 'var(--font-size-body)', color: colors.slateLight, margin: 0 }}>{t('monitoring.services.history.empty')}</p>
        : (
          <ol aria-label={t('monitoring.services.history.title')} style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column' }}>
            {shown.map((e, idx) => <HistoryRow key={e.id} entry={e} last={idx === shown.length - 1} />)}
          </ol>
        )}

      {error && (
        <div role="alert" data-testid="history-error" style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginTop: 10, padding: '8px 12px', borderRadius: 8, background: palette.danger.bg, border: `1px solid ${palette.danger.border}`, color: palette.danger.text, fontSize: 'var(--font-size-body)' }}>
          <span>{t('monitoring.services.history.loadFailed', { error: error.message })}</span>
          <Button variant="secondary" size="xs" onClick={() => void refetch()}>{t('queryError.retry')}</Button>
        </div>
      )}

      {total > shown.length && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginTop: 10 }}>
          <span style={{ fontSize: 'var(--font-size-table)', color: colors.slate }}>
            {t('monitoring.services.history.truncated', { shown: shown.length, total })}
          </span>
          {!showAll && (
            <Button
              variant="secondary" size="xs"
              icon={loading ? <Loader2 size={13} className="animate-spin" aria-hidden="true" /> : undefined}
              onClick={() => setShowAll(true)}
            >
              {t('monitoring.services.history.showAll')}
            </Button>
          )}
        </div>
      )}
    </SectionCard>
  )
}

function HistoryRow({ entry: e, last }: { entry: ServiceHealthEntry; last: boolean }) {
  const { t } = useTranslation()
  const known = e.trigger in ICON
  const Icon: LucideIcon = lookupOrError(ICON, e.trigger, 'SERVICE_HISTORY_ICON', HelpCircle)
  const bg = known ? dotColor(e) : TINT_BROKEN.bg
  const causes = causesLine(t, e)
  const dot: ReactNode = (
    <span aria-hidden="true" style={{ width: 20, height: 20, borderRadius: '50%', backgroundColor: bg, color: TINT_BROKEN.color, flexShrink: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', border: `2px solid ${colors.white}`, boxShadow: `0 0 0 1px ${alpha.black20}` }}>
      <Icon size={11} strokeWidth={2.5} />
    </span>
  )
  return (
    <li data-testid="service-history-entry" data-trigger={e.trigger} style={{ display: 'flex', gap: 12, paddingBottom: last ? 0 : 14, position: 'relative' }}>
      {!last && <span aria-hidden="true" style={{ position: 'absolute', left: 9, top: 22, bottom: 0, width: 2, backgroundColor: colors.slate, opacity: 0.3 }} />}
      {dot}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 'var(--font-size-body)', color: colors.slateDark, lineHeight: 1.5, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          <EntrySentence entry={e} />
        </div>
        <div style={{ fontSize: 'var(--font-size-table)', color: colors.slateLight, marginTop: 1 }}>
          <time dateTime={e.at}>{formatDateTime(e.at)}</time> · {timeAgo(e.at)}
        </div>
        {causes && <div style={{ fontSize: 'var(--font-size-table)', color: colors.slate, marginTop: 2 }}>{causes}</div>}
        {e.note && <div style={{ fontSize: 'var(--font-size-body)', color: colors.slate, marginTop: 2, fontStyle: 'italic', whiteSpace: 'pre-wrap' }}>{e.note}</div>}
      </div>
    </li>
  )
}
