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
 */
import type { ReactNode } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { Sparkles, HeartPulse, SlidersHorizontal, GitBranch, Wrench, RotateCcw, Clock, HelpCircle, type LucideIcon } from 'lucide-react'
import { SectionCard } from '@/components/ui/SectionCard'
import { formatDateTime, timeAgo } from '@/lib/datetime'
import { alpha, colors, lookupOrError } from '@/lib/tokens'
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

interface Props {
  entries: ServiceHealthEntry[]
  /** Numero totale di voci (`historyCount`): può superare le voci caricate. */
  total:   number
}

export function ServiceHistorySection({ entries, total }: Props) {
  const { t } = useTranslation()
  return (
    <SectionCard title={t('monitoring.services.history.title')} count={total} defaultOpen>
      {entries.length === 0
        ? <p style={{ fontSize: 'var(--font-size-body)', color: colors.slateLight, margin: 0 }}>{t('monitoring.services.history.empty')}</p>
        : (
          <ol aria-label={t('monitoring.services.history.title')} style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column' }}>
            {entries.map((e, idx) => <HistoryRow key={e.id} entry={e} last={idx === entries.length - 1} />)}
          </ol>
        )}
      {total > entries.length && (
        <p style={{ fontSize: 'var(--font-size-table)', color: colors.slate, margin: 0 }}>
          {t('monitoring.services.history.truncated', { shown: entries.length, total })}
        </p>
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
