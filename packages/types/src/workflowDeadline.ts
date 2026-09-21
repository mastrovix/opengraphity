/**
 * LA SCADENZA DI UN PASSO DI WORKFLOW (verifica «Cosa resta cablato», ondata 3).
 *
 * ## Cosa c'era
 * La chiusura automatica degli incident era un caso speciale: un'azione
 * `schedule_job(auto_close, 72 ore)` sul passo «resolved», un job che sapeva
 * chiudere SOLO un incident e lanciava per tutto il resto. Un cliente non poteva
 * dire «se la change resta in review più di 7 giorni, chiudila come riuscita».
 *
 * ## Cosa c'è
 * Qualunque passo di qualunque workflow può avere UNA scadenza: dopo quanto
 * tempo nel passo (ore o giorni, 24×7 oppure contando solo l'orario di un
 * calendario di servizio), verso quale passo spostare il ticket — seguendo uno
 * degli archi che escono dal passo — e quali campi impostare.
 *
 * La forma vive qui perché la leggono in tre: l'API in scrittura, il motore
 * delle scadenze e il disegnatore.
 */

/** Le unità della durata. */
export const STEP_DEADLINE_UNITS = ['hours', 'days'] as const
export type StepDeadlineUnit = (typeof STEP_DEADLINE_UNITS)[number]

/** Un campo che la scadenza imposta quando sposta il ticket. */
export interface StepDeadlineField {
  field: string
  value: string
}

export interface StepDeadline {
  /** Quante unità nel passo prima che la scadenza scatti (intero ≥ 1). */
  after:       number
  unit:        StepDeadlineUnit
  /**
   * Il calendario di servizio con cui si conta; `null` = 24×7. Con un
   * calendario un'ora è un'ora di servizio e un giorno è una giornata intera
   * di servizio (da inizio a fine fascia), non 24 ore.
   */
  calendar_id: string | null
  /** Il passo di arrivo: deve esserci un arco dal passo a questo. */
  to_step:     string
  set_fields:  StepDeadlineField[]
}

/** Il tetto della durata: dieci anni di giorni. Oltre è quasi certamente un errore di battitura. */
export const STEP_DEADLINE_MAX_DAYS = 3650

/** Chi risulta nella cronologia del ticket quando lo sposta una scadenza. */
export const STEP_DEADLINE_ACTOR = 'step_deadline'

/**
 * Gli SCOPI di passo verso cui una scadenza di una change non può portare: sono
 * i passi protetti dalle approvazioni (dove si approva, e la finestra di
 * rilascio). Una scadenza non ha un umano dietro: portare lì una change
 * «perché è passato il tempo» è esattamente lo scavalcamento che il varco
 * esiste per impedire. Si rifiuta in scrittura; il varco al momento dello
 * scatto resta come ultima difesa.
 */
export const DEADLINE_PROTECTED_TARGET_PURPOSES = ['approval', 'scheduled', 'implementation'] as const

/**
 * Da un passo di approvazione di una change una scadenza non può uscire: il
 * varco chiede le approvazioni per lasciarlo, e una scadenza che scatta
 * sempre rifiutata non è una configurazione, è un rumore.
 */
export const DEADLINE_PROTECTED_SOURCE_PURPOSES = ['approval'] as const

/** Perché una scadenza non è valida: un codice stabile, i parametri a parte. */
export type StepDeadlineProblem =
  | 'not_object' | 'invalid_json' | 'after' | 'unit' | 'calendar' | 'to_step' | 'set_fields' | 'duplicate_field'

export class StepDeadlineError extends Error {
  constructor(public readonly problem: StepDeadlineProblem, message: string, public readonly params: Record<string, string> = {}) {
    super(message)
    this.name = 'StepDeadlineError'
  }
}

/**
 * Legge e valida la FORMA di una scadenza (oggetto o JSON). `null`, `undefined`
 * e la stringa vuota sono «nessuna scadenza». La validità rispetto al workflow
 * (arco, scopi, calendario, campi del metamodello) è dell'API: qui solo quello
 * che si può dire senza leggere il grafo.
 */
export function parseStepDeadline(raw: unknown): StepDeadline | null {
  if (raw == null || raw === '') return null
  let value = raw
  if (typeof raw === 'string') {
    try { value = JSON.parse(raw) } catch {
      throw new StepDeadlineError('invalid_json', 'Step deadline: the stored value is not valid JSON')
    }
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new StepDeadlineError('not_object', 'Step deadline: an object {after, unit, calendar_id, to_step, set_fields} is expected')
  }
  const v = value as Record<string, unknown>

  const unit = v['unit']
  if (typeof unit !== 'string' || !(STEP_DEADLINE_UNITS as readonly string[]).includes(unit)) {
    throw new StepDeadlineError('unit', `Step deadline: unit must be one of ${STEP_DEADLINE_UNITS.join(', ')}`, { unit: String(unit ?? '') })
  }
  const after = v['after']
  const maxAfter = unit === 'days' ? STEP_DEADLINE_MAX_DAYS : STEP_DEADLINE_MAX_DAYS * 24
  if (typeof after !== 'number' || !Number.isInteger(after) || after < 1 || after > maxAfter) {
    throw new StepDeadlineError('after', `Step deadline: "after" must be a whole number from 1 to ${String(maxAfter)} ${unit}`, { max: String(maxAfter), unit })
  }

  const calendar = v['calendar_id']
  if (calendar != null && (typeof calendar !== 'string' || calendar.trim() === '')) {
    throw new StepDeadlineError('calendar', 'Step deadline: calendar_id must be a calendar id, or null to count 24×7')
  }

  const toStep = v['to_step']
  if (typeof toStep !== 'string' || toStep.trim() === '') {
    throw new StepDeadlineError('to_step', 'Step deadline: to_step (the step the ticket moves to) is required')
  }

  const rawFields = v['set_fields'] ?? []
  if (!Array.isArray(rawFields)) {
    throw new StepDeadlineError('set_fields', 'Step deadline: set_fields must be a list of {field, value}')
  }
  const seen = new Set<string>()
  const setFields = rawFields.map((f): StepDeadlineField => {
    const field = (f as { field?: unknown } | null)?.field
    const fv    = (f as { value?: unknown } | null)?.value
    if (typeof field !== 'string' || field.trim() === '' || (typeof fv !== 'string' && typeof fv !== 'number' && typeof fv !== 'boolean')) {
      throw new StepDeadlineError('set_fields', 'Step deadline: every entry of set_fields needs a field name and a value')
    }
    if (seen.has(field)) {
      throw new StepDeadlineError('duplicate_field', `Step deadline: field "${field}" is set twice`, { field })
    }
    seen.add(field)
    return { field: field.trim(), value: String(fv) }
  })

  return { after, unit: unit as StepDeadlineUnit, calendar_id: calendar == null ? null : calendar, to_step: toStep.trim(), set_fields: setFields }
}

/**
 * I minuti che la scadenza conta. 24×7: minuti di orologio. Con un calendario:
 * minuti di servizio, e un giorno vale `minutesPerServiceDay` (la fascia).
 */
export function stepDeadlineMinutes(deadline: Pick<StepDeadline, 'after' | 'unit'>, minutesPerServiceDay: number | null): number {
  if (deadline.unit === 'hours') return deadline.after * 60
  return deadline.after * (minutesPerServiceDay ?? 24 * 60)
}
