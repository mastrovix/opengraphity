/**
 * Pezzi condivisi delle pagine Servizi (lista, dettaglio, sezione nel
 * dettaglio CI): badge di salute e stato della mappa, famiglie di colore per
 * salute (riquadri, nodi della mappa, barre), barra del punteggio d'impatto,
 * etichette di ruolo/«pesa», e la frase di spiegazione in parole
 * («Degradato: db-01 è giù (via api-03), cache-02 è degradato»).
 * Revisione 2: la nota «in manutenzione, sarebbe: giù» (`healthIfActive`), i
 * due motivi per cui la mappa è da rivedere (`staleReason`) e il motivo per
 * cui un componente non ha contato (`excludedReason`).
 *
 * Fail-loud: un valore fuori vocabolario (salute, stato, ruolo, pesa) NON
 * sparisce e non prende un colore «plausibile»: tinta rossa piena via
 * lookupOrError (console.error) ed etichetta «Sconosciuto (<valore>)».
 * Colori: solo token (lib/tokens, lib/eventPalette), niente esadecimali.
 */
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { Pill } from '@/components/ui/Pill'
import { lookupOrError, palette } from '@/lib/tokens'
import { TINT_CRITICAL, TINT_WARNING, TINT_INFO, TINT_SUCCESS, TINT_NEUTRAL, TINT_BROKEN, ACCENT, type Tint } from '@/lib/eventPalette'
import { CI_HEALTHS, type CIHealth } from '@/types/events'
import {
  SERVICE_HEALTHS, SERVICE_MAP_STATUSES, NODE_PROPAGATIONS, SERVICE_NODE_ROLES, NODE_EXCLUDED_REASONS,
  type ServiceHealth, type ServiceMapStatus, type NodePropagation, type ServiceNodeRole, type NodeExcludedReason,
  type ImpactCause, type ImpactPathRef, type ServiceMapRow,
} from '@/types/services'

const badgeFont = { fontSize: 'var(--font-size-label)' } as const

/** Viola: servizio/componente in finestra di change. */
const TINT_MAINTENANCE: Tint = { bg: palette.purple.bg, color: palette.purple.text }

// ── Salute del servizio ──────────────────────────────────────────────────────

const SERVICE_HEALTH_TINT: Record<string, Tint> = {
  operational: TINT_SUCCESS,
  degraded:    TINT_WARNING,
  down:        TINT_CRITICAL,
  maintenance: TINT_MAINTENANCE,
  unknown:     TINT_NEUTRAL,
}

/** Colore pieno della salute (barre, strisce di riga, pallini della cronologia). */
export const SERVICE_HEALTH_ACCENT: Record<ServiceHealth, string> = {
  down:        ACCENT.critical,
  degraded:    ACCENT.warning,
  operational: ACCENT.success,
  maintenance: palette.purple.base,
  unknown:     ACCENT.neutral,
}

/** Una famiglia di colore per salute: sfondo pieno, sfondo marcato, bordo, testo, accento. */
export interface HealthFamily { bg: string; tint: string; border: string; text: string; accent: string }

/** Riquadri e nodi della mappa: rosso giù, ambra degradato, verde operativo, viola manutenzione, neutro sconosciuto. */
export const SERVICE_HEALTH_FAMILY: Record<ServiceHealth, HealthFamily> = {
  down:        { bg: palette.danger.bg,       tint: palette.danger.tint,    border: palette.danger.base,         text: palette.danger.text,  accent: ACCENT.critical },
  degraded:    { bg: palette.warning.bg,      tint: palette.warning.tint,   border: palette.warning.base,        text: palette.warning.text, accent: ACCENT.warning },
  operational: { bg: palette.success.bg,      tint: palette.success.tint,   border: palette.success.base,        text: palette.success.text, accent: ACCENT.success },
  maintenance: { bg: palette.purple.bg,       tint: palette.purple.tint,    border: palette.purple.base,         text: palette.purple.text,  accent: palette.purple.base },
  unknown:     { bg: palette.neutral.surface2, tint: palette.neutral.slateBg, border: palette.neutral.borderStrong, text: palette.neutral.text, accent: ACCENT.neutral },
}

/** Famiglia «rotta» per un valore fuori vocabolario: rosso pieno, mai un colore plausibile. */
const BROKEN_FAMILY: HealthFamily = { bg: TINT_BROKEN.bg, tint: TINT_BROKEN.bg, border: TINT_BROKEN.bg, text: TINT_BROKEN.color, accent: TINT_BROKEN.bg }

export const isServiceHealth = (v: string | null | undefined): v is ServiceHealth =>
  v !== null && v !== undefined && (SERVICE_HEALTHS as readonly string[]).includes(v)

/** Etichetta della salute del servizio; fuori vocabolario → «Sconosciuto (<valore>)», mai il valore grezzo da solo né una stringa vuota. */
export function serviceHealthLabel(t: TFunction, value: string): string {
  return isServiceHealth(value) ? t(`monitoring.services.health.${value}`) : t('monitoring.services.health.outOfVocabulary', { value })
}

export function serviceHealthFamily(health: string): HealthFamily {
  return lookupOrError(SERVICE_HEALTH_FAMILY as Record<string, HealthFamily>, health, 'SERVICE_HEALTH_FAMILY', BROKEN_FAMILY)
}

export function ServiceHealthBadge({ health }: { health: ServiceHealth }) {
  const { t } = useTranslation()
  const s = lookupOrError(SERVICE_HEALTH_TINT, health, 'SERVICE_HEALTH_TINT', TINT_BROKEN)
  return <Pill bg={s.bg} color={s.color} style={badgeFont}>{serviceHealthLabel(t, health)}</Pill>
}

/**
 * «in manutenzione, sarebbe: giù» — la salute che il servizio avrebbe senza la
 * finestra di change in corso (`healthIfActive`, valorizzata solo quando la
 * salute è `maintenance`). Null quando non c'è niente da dire: la manutenzione
 * non deve mai nascondere un servizio che è comunque giù.
 */
export function healthIfActiveNote(t: TFunction, map: Pick<ServiceMapRow, 'health' | 'healthIfActive'>): string | null {
  if (map.health !== 'maintenance' || map.healthIfActive === null) return null
  return t('monitoring.services.healthIfActive', { health: serviceHealthLabel(t, map.healthIfActive) })
}

// ── Mappa da rivedere ────────────────────────────────────────────────────────

/**
 * Il motivo per cui la mappa è marcata `stale`, in chiaro: un componente
 * sparito dalla CMDB o il tetto dei componenti superato (in quel caso
 * sincronizzare fallirebbe di nuovo, quindi il testo NON lo propone).
 * Motivo assente → il testo generico; motivo fuori vocabolario → detto in
 * chiaro, mai taciuto.
 */
export function staleMessage(t: TFunction, reason: string | null): string {
  if (reason === null)         return t('monitoring.services.stale')
  if (reason === 'missing_ci') return t('monitoring.services.staleMissingCi')
  if (reason === 'over_limit') return t('monitoring.services.staleOverLimit')
  return t('monitoring.services.staleUnknownReason', { value: reason })
}

/** Lo stesso motivo in due parole (icona della lista). */
export function staleShortLabel(t: TFunction, reason: string | null): string {
  if (reason === 'over_limit') return t('monitoring.services.staleShortOverLimit')
  if (reason === null || reason === 'missing_ci') return t('monitoring.services.staleShort')
  return t('monitoring.services.health.outOfVocabulary', { value: reason })
}

// ── Stato della mappa ────────────────────────────────────────────────────────

const STATUS_TINT: Record<string, Tint> = { draft: TINT_INFO, active: TINT_SUCCESS, paused: TINT_NEUTRAL }

export function serviceStatusLabel(t: TFunction, value: string): string {
  return (SERVICE_MAP_STATUSES as readonly string[]).includes(value)
    ? t(`monitoring.services.status.${value as ServiceMapStatus}`)
    : t('monitoring.services.health.outOfVocabulary', { value })
}

export function ServiceStatusPill({ status }: { status: ServiceMapStatus }) {
  const { t } = useTranslation()
  const s = lookupOrError(STATUS_TINT, status, 'SERVICE_STATUS_TINT', TINT_BROKEN)
  return <Pill bg={s.bg} color={s.color} style={badgeFont}>{serviceStatusLabel(t, status)}</Pill>
}

// ── Modalità della mappa: viva o congelata (ondata 5) ────────────────────────

/**
 * Badge accanto al nome della mappa: «viva» (si aggiorna da sola dal grafo) o
 * «congelata» (i componenti nuovi restano una proposta da accettare a mano).
 * Il testo dice la modalità da solo, il colore è un di più; il `title` spiega
 * cosa comporta.
 */
export function ServiceSyncModePill({ autoSync }: { autoSync: boolean }) {
  const { t } = useTranslation()
  const s = autoSync ? TINT_INFO : TINT_NEUTRAL
  const mode = autoSync ? 'live' : 'frozen'
  return (
    <Pill bg={s.bg} color={s.color} style={badgeFont} title={t(`monitoring.services.syncMode.${mode}Hint`)}>
      <span data-testid="sync-mode-badge" data-mode={mode}>{t(`monitoring.services.syncMode.${mode}`)}</span>
    </Pill>
  )
}

// ── Salute dei componenti (CI) ───────────────────────────────────────────────

const CI_HEALTH_TINT: Record<string, Tint> = { operational: TINT_SUCCESS, degraded: TINT_WARNING, down: TINT_CRITICAL }

/** Etichetta della salute di un CI; null = sconosciuta (mai toccato da un allarme); fuori vocabolario → «Sconosciuto (<valore>)». */
export function ciHealthLabel(t: TFunction, health: string | null): string {
  if (health === null) return t('events.health.unknown')
  return (CI_HEALTHS as readonly string[]).includes(health) ? t(`events.health.${health as CIHealth}`) : t('monitoring.services.health.outOfVocabulary', { value: health })
}

/** Badge della salute di un componente: null → «Sconosciuta» neutro. */
export function NodeHealthBadge({ health }: { health: CIHealth | null }) {
  const { t } = useTranslation()
  const s = health === null ? TINT_NEUTRAL : lookupOrError(CI_HEALTH_TINT, health, 'NODE_HEALTH_TINT', TINT_BROKEN)
  return <Pill bg={s.bg} color={s.color} style={badgeFont}>{ciHealthLabel(t, health)}</Pill>
}

/** Famiglia di colore di un nodo della mappa: in manutenzione → viola (non pesa), salute nulla → neutro. */
export function nodeHealthFamily(health: CIHealth | null, inMaintenance: boolean): HealthFamily {
  if (inMaintenance) return SERVICE_HEALTH_FAMILY.maintenance
  if (health === null) return SERVICE_HEALTH_FAMILY.unknown
  return lookupOrError(SERVICE_HEALTH_FAMILY as Record<string, HealthFamily>, health, 'NODE_HEALTH_FAMILY', BROKEN_FAMILY)
}

// ── Ruolo e «pesa» ───────────────────────────────────────────────────────────

export function roleLabel(t: TFunction, role: string): string {
  return (SERVICE_NODE_ROLES as readonly string[]).includes(role)
    ? t(`monitoring.services.role.${role as ServiceNodeRole}`)
    : t('monitoring.services.health.outOfVocabulary', { value: role })
}

/**
 * Perché un componente non ha contato nell'ultima valutazione: «in
 * manutenzione (ciclo di vita)», «in finestra di change», «non pesa mai»,
 * «salute sconosciuta». null = ha contato, non c'è niente da dire; valore
 * fuori vocabolario → detto in chiaro.
 */
export function excludedReasonLabel(t: TFunction, reason: string | null): string | null {
  if (reason === null) return null
  return (NODE_EXCLUDED_REASONS as readonly string[]).includes(reason)
    ? t(`monitoring.services.excludedReason.${reason as NodeExcludedReason}`)
    : t('monitoring.services.health.outOfVocabulary', { value: reason })
}

/** «Pesa»: sempre / mai / ponderato (al posto di propagate, glossario del progetto). */
export function propagationLabel(t: TFunction, propagate: string): string {
  return (NODE_PROPAGATIONS as readonly string[]).includes(propagate)
    ? t(`monitoring.services.propagation.${propagate as NodePropagation}`)
    : t('monitoring.services.health.outOfVocabulary', { value: propagate })
}

// ── Punteggio d'impatto ──────────────────────────────────────────────────────

/** Barra 0–100 + numero; il colore segue la salute del servizio. Il testo accessibile è nel `title` e in un'etichetta. */
export function ImpactScore({ score, health, width = 80 }: { score: number; health: ServiceHealth; width?: number }) {
  const { t } = useTranslation()
  const clamped = Math.max(0, Math.min(100, score))
  const label = t('monitoring.services.impactScoreLabel', { score: clamped })
  return (
    <span title={label} aria-label={label} style={{ display: 'inline-flex', alignItems: 'center', gap: 8, whiteSpace: 'nowrap' }}>
      <span aria-hidden="true" style={{ width, height: 6, borderRadius: 999, background: palette.neutral.slateBg, overflow: 'hidden', flexShrink: 0 }}>
        <span style={{ display: 'block', width: `${clamped}%`, height: '100%', background: serviceHealthFamily(health).accent, transition: 'width 300ms' }} />
      </span>
      <span style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 600, color: 'var(--color-slate-dark)', minWidth: 24, textAlign: 'right' }}>{clamped}</span>
    </span>
  )
}

// ── Spiegazione in parole ────────────────────────────────────────────────────

/** Il nodo da cui si arriva al malato («via api-03»): il passo successivo del percorso, che può iniziare dal nodo stesso. */
export function causeVia(cause: ImpactCause): ImpactPathRef | null {
  return cause.path.find((p) => p.id !== cause.ci.id) ?? null
}

/** Parola della salute del componente dentro una frase («giù», «degradato»); fuori vocabolario → detto in chiaro. */
function healthWord(t: TFunction, health: string): string {
  return (CI_HEALTHS as readonly string[]).includes(health)
    ? t(`monitoring.services.explain.word.${health as CIHealth}`)
    : t('monitoring.services.health.outOfVocabulary', { value: health })
}

/** «db-01 → api-03 → Enterprise Billing»: il percorso della causa fino al servizio, in nomi. */
export function causeSequenceLabel(cause: ImpactCause, serviceName: string): string {
  const names = [cause.ci.name]
  for (const p of cause.path) if (p.id !== cause.ci.id) names.push(p.name)
  names.push(serviceName)
  return names.join(' → ')
}

/** «db-01 giù via api-03» (causa principale nella lista). */
export function causeLabel(t: TFunction, cause: ImpactCause): string {
  const via = causeVia(cause)
  const health = healthWord(t, cause.health)
  return via
    ? t('monitoring.services.explain.causeVia', { name: cause.ci.name, health, via: via.name })
    : t('monitoring.services.explain.cause', { name: cause.ci.name, health })
}

/**
 * «Degradato: db-01 è giù (via api-03), cache-02 è degradato»; un nodo critico
 * aggiunge «— componente critico». Senza cause la frase dipende dalla salute
 * (operativo, sconosciuta, in manutenzione); giù/degradato senza cause è detto
 * in chiaro, non taciuto.
 */
export function explanationSentence(t: TFunction, map: Pick<ServiceMapRow, 'health' | 'explanation'>): string {
  const label = serviceHealthLabel(t, map.health)
  const causes = map.explanation.map((c) => {
    const via = causeVia(c)
    const health = healthWord(t, c.health)
    const base = via
      ? t('monitoring.services.explain.isVia', { name: c.ci.name, health, via: via.name })
      : t('monitoring.services.explain.is', { name: c.ci.name, health })
    return c.critical ? t('monitoring.services.explain.criticalSuffix', { text: base }) : base
  })
  if (causes.length === 0) {
    if (map.health === 'operational') return t('monitoring.services.explain.operational')
    if (map.health === 'unknown')     return t('monitoring.services.explain.unknown')
    if (map.health === 'maintenance') return t('monitoring.services.explain.maintenance')
    return t('monitoring.services.explain.noCauses', { health: label })
  }
  return t('monitoring.services.explain.sentence', { health: label, causes: causes.join(', ') })
}
