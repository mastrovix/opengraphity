/**
 * Cronologia dell'allarme (Event Management): timeline verticale delle voci
 * `Event.history`, dalla più recente, nello stile di WorkflowTimeline. Ogni
 * voce ha un pallino colorato per FAMIGLIA con un'icona (cicli = severità,
 * correlazione = brand, silenzio = ambra, instabile = viola, tempesta =
 * arancione, manuale = ardesia), l'istante (data + "N min fa"), una frase in
 * i18n con i link a incident/change/CI e il nome dell'utente (la frase passa da
 * `<Trans>`: l'ordine delle parole resta alla lingua) e la nota della voce.
 *
 * Fail-loud: un kind fuori vocabolario NON sparisce e non prende un colore
 * "plausibile": pallino rosso, frase "Voce sconosciuta: <kind>" e
 * console.error (lookupOrError). Un riferimento mancante (incident, change,
 * CI o severità assenti dove la frase li cita) resta visibile come
 * "incident non registrato" al posto del link, mai una frase monca.
 * Le ripetizioni di un payload non sono voci: vedi `count` e "Ultimo visto".
 */
import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { Trans, useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import {
  Radar, Flame, CheckCircle2, ArrowUpDown, GitBranch, CircleSlash, BellOff, Bell, Waves, Anchor,
  CloudLightning, UserCheck, CheckSquare, Link2, FilePlus, RotateCcw, HelpCircle, type LucideIcon,
} from 'lucide-react'
import { SectionCard } from '@/components/ui/SectionCard'
import { formatDateTime, timeAgo } from '@/lib/datetime'
import { ciPath } from '@/lib/ciPath'
import { alpha, colors, palette, lookupOrError } from '@/lib/tokens'
import { ACCENT, TINT_BROKEN } from '@/lib/eventPalette'
import { EventSeverityBadge } from './eventShared'
import { EVENT_CORRELATIONS, EVENT_SEVERITIES, type EventHistoryEntry, type EventHistoryKind, type EventSeverity } from '@/types/events'

const linkStyle = { color: colors.brand, textDecoration: 'none', fontWeight: 500 } as const

/** Famiglia di ogni voce: decide colore e icona del pallino. */
type Family = 'cycle' | 'correlation' | 'silence' | 'flapping' | 'storm' | 'manual'

const FAMILY: Record<EventHistoryKind, Family> = {
  first_seen:               'cycle',
  cycle_firing:             'cycle',
  cycle_resolved:           'cycle',
  severity_changed:         'cycle',
  correlated:               'correlation',
  auto_resolved:            'correlation',
  auto_resolve_skipped:     'correlation',
  suppressed:               'silence',
  unsuppressed:             'silence',
  flapping:                 'flapping',
  stable:                   'flapping',
  storm:                    'storm',
  acknowledged:             'manual',
  resolved_manually:        'manual',
  linked_ci:                'manual',
  incident_opened_manually: 'manual',
  reevaluated:              'manual',
}

const ICON: Record<EventHistoryKind, LucideIcon> = {
  first_seen:               Radar,
  cycle_firing:             Flame,
  cycle_resolved:           CheckCircle2,
  severity_changed:         ArrowUpDown,
  correlated:               GitBranch,
  auto_resolved:            CheckCircle2,
  auto_resolve_skipped:     CircleSlash,
  suppressed:               BellOff,
  unsuppressed:             Bell,
  flapping:                 Waves,
  stable:                   Anchor,
  storm:                    CloudLightning,
  acknowledged:             UserCheck,
  resolved_manually:        CheckSquare,
  linked_ci:                Link2,
  incident_opened_manually: FilePlus,
  reevaluated:              RotateCcw,
}

/** Chiavi delle frasi, letterali (non template) così check-i18n le vede usate. */
const SENTENCE_KEY: Record<EventHistoryKind, string> = {
  first_seen:               'events.history.kind.first_seen',
  cycle_firing:             'events.history.kind.cycle_firing',
  cycle_resolved:           'events.history.kind.cycle_resolved',
  severity_changed:         'events.history.kind.severity_changed',
  correlated:               'events.history.kind.correlated',
  auto_resolved:            'events.history.kind.auto_resolved',
  auto_resolve_skipped:     'events.history.kind.auto_resolve_skipped',
  suppressed:               'events.history.kind.suppressed',
  unsuppressed:             'events.history.kind.unsuppressed',
  flapping:                 'events.history.kind.flapping',
  stable:                   'events.history.kind.stable',
  storm:                    'events.history.kind.storm',
  acknowledged:             'events.history.kind.acknowledged',
  resolved_manually:        'events.history.kind.resolved_manually',
  linked_ci:                'events.history.kind.linked_ci',
  incident_opened_manually: 'events.history.kind.incident_opened_manually',
  reevaluated:              'events.history.kind.reevaluated',
}

/** Colore pieno delle famiglie non legate alla severità. */
const FAMILY_COLOR: Record<Exclude<Family, 'cycle'>, string> = {
  correlation: colors.brand,
  silence:     ACCENT.warning,
  flapping:    ACCENT.flapping,
  storm:       palette.orange.base,
  manual:      ACCENT.neutral,
}

/** Cicli: il pallino segue la severità della voce; il rientro è verde; severità non registrata = grigio. */
const SEVERITY_COLOR: Record<EventSeverity, string> = {
  critical: ACCENT.critical,
  warning:  ACCENT.warning,
  info:     palette.info.base,
}

function dotColor(kind: EventHistoryKind, severity: EventSeverity | null): string {
  const family = FAMILY[kind]
  if (family !== 'cycle') return FAMILY_COLOR[family]
  if (kind === 'cycle_resolved') return ACCENT.success
  return severity ? lookupOrError(SEVERITY_COLOR, severity, 'EVENT_HISTORY_SEVERITY_COLOR', TINT_BROKEN.bg) : ACCENT.muted
}

/** Nome di chi ha agito: "monitoraggio" per le azioni automatiche; utente cancellato → resta l'id (è il dato vero, non un ripiego). */
function actorName(t: TFunction, e: EventHistoryEntry): string {
  if (e.actorId === 'monitoring') return t('events.history.actor.monitoring')
  return e.actor?.name ?? e.actorId
}

/** Etichetta di una severità; un valore fuori vocabolario è mostrato com'è. */
function severityLabel(t: TFunction, value: string): string {
  return (EVENT_SEVERITIES as readonly string[]).includes(value) ? t(`events.severity.${value as EventSeverity}`) : value
}

/** Esito di correlazione con l'etichetta breve già usata in console; assente o sconosciuto → detto in chiaro. */
function outcomeLabel(t: TFunction, e: EventHistoryEntry): string {
  if (e.outcome === null) return t('events.history.outcomeMissing')
  return EVENT_CORRELATIONS.includes(e.outcome)
    ? t(`events.correlation.short.${e.outcome}`)
    : t('events.history.outcomeUnknown', { value: String(e.outcome) })
}

/**
 * La frase della voce. I riferimenti (incident, change, CI, severità) sono
 * componenti di `<Trans>`: link quando ci sono, testo "non registrato" quando
 * mancano dove la frase li cita.
 */
function EntrySentence({ entry: e }: { entry: EventHistoryEntry }) {
  const { t } = useTranslation()
  const key = SENTENCE_KEY[e.kind]
  if (key === undefined) return <>{t('events.history.kind.unknown', { kind: String(e.kind) })}</>

  const missing = <span style={{ color: colors.slate, fontStyle: 'italic' }} />
  const components = {
    incident: e.incident ? <Link to={`/incidents/${e.incident.id}`} style={linkStyle} /> : missing,
    change:   e.change   ? <Link to={`/changes/${e.change.id}`} style={linkStyle} />   : missing,
    ci:       e.ci       ? <Link to={ciPath(e.ci)} style={linkStyle} />                 : missing,
    severity: e.severity
      ? <EventSeverityBadge severity={e.severity} />
      : <span style={{ color: colors.slate, fontStyle: 'italic' }}>{t('events.history.missing.severity')}</span>,
  }
  const values = {
    number:   e.incident?.number ?? t('events.history.missing.incident'),
    code:     e.change?.code     ?? t('events.history.missing.change'),
    ci:       e.ci?.name         ?? t('events.history.missing.ci'),
    name:     actorName(t, e),
    outcome:  outcomeLabel(t, e),
    // severity_changed: la nota è la severità precedente.
    previous: e.note !== null ? severityLabel(t, e.note) : t('events.history.missing.severity'),
  }
  // Un esito senza incident è legittimo (nessun CI, sotto soglia, in attesa…): frase senza il riferimento.
  const i18nKey = e.kind === 'correlated' && !e.incident ? 'events.history.kind.correlatedNoIncident' : key
  return <Trans i18nKey={i18nKey} values={values} components={components} />
}

/** La nota sotto la frase: `alias` di linked_ci è un codice (tradotto), la severità precedente è già nella frase, il resto è testo libero. */
function noteText(t: TFunction, e: EventHistoryEntry): string | null {
  if (e.note === null || e.kind === 'severity_changed') return null
  if (e.kind === 'linked_ci' && e.note === 'alias') return t('events.history.note.alias')
  return e.note
}

interface Props {
  entries: EventHistoryEntry[]
  /** Numero totale di voci (`historyCount`): può superare le voci caricate. */
  total:   number
}

export function EventHistorySection({ entries, total }: Props) {
  const { t } = useTranslation()
  return (
    <SectionCard title={t('events.history.title')} count={total} defaultOpen>
      {entries.length === 0
        ? <p style={{ fontSize: 'var(--font-size-body)', color: colors.slateLight, margin: 0 }}>{t('events.history.empty')}</p>
        : (
          <ol aria-label={t('events.history.title')} style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column' }}>
            {entries.map((e, idx) => <HistoryRow key={e.id} entry={e} last={idx === entries.length - 1} />)}
          </ol>
        )}
      {total > entries.length && (
        <p style={{ fontSize: 'var(--font-size-table)', color: colors.slate, margin: 0 }}>
          {t('events.history.truncated', { shown: entries.length, total })}
        </p>
      )}
    </SectionCard>
  )
}

function HistoryRow({ entry: e, last }: { entry: EventHistoryEntry; last: boolean }) {
  const { t } = useTranslation()
  const known = e.kind in FAMILY
  // Kind sconosciuto: pallino rosso pieno e console.error, mai un colore "plausibile".
  const Icon: LucideIcon = lookupOrError(ICON, e.kind, 'EVENT_HISTORY_ICON', HelpCircle)
  const bg = known ? dotColor(e.kind, e.severity) : TINT_BROKEN.bg
  const note = known ? noteText(t, e) : e.note
  const dot: ReactNode = (
    <span aria-hidden="true" style={{ width: 20, height: 20, borderRadius: '50%', backgroundColor: bg, color: TINT_BROKEN.color, flexShrink: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', border: `2px solid ${colors.white}`, boxShadow: `0 0 0 1px ${alpha.black20}` }}>
      <Icon size={11} strokeWidth={2.5} />
    </span>
  )
  return (
    <li data-testid="history-entry" data-kind={e.kind} style={{ display: 'flex', gap: 12, paddingBottom: last ? 0 : 14, position: 'relative' }}>
      {!last && <span aria-hidden="true" style={{ position: 'absolute', left: 9, top: 22, bottom: 0, width: 2, backgroundColor: colors.slate, opacity: 0.3 }} />}
      {dot}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 'var(--font-size-body)', color: colors.slateDark, lineHeight: 1.5, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          <EntrySentence entry={e} />
        </div>
        <div style={{ fontSize: 'var(--font-size-table)', color: colors.slateLight, marginTop: 1 }}>
          <time dateTime={e.at}>{formatDateTime(e.at)}</time> · {timeAgo(e.at)}
        </div>
        {note && <div style={{ fontSize: 'var(--font-size-body)', color: colors.slate, marginTop: 2, fontStyle: 'italic', whiteSpace: 'pre-wrap' }}>{note}</div>}
      </div>
    </li>
  )
}
