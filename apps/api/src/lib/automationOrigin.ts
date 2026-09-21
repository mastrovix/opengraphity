/**
 * L'ORIGINE DI UN'AUTOMAZIONE, E LA SBARRA CHE NE DISCENDE
 * (20 set 2026, prerequisito dell'ondata 6).
 *
 * ## Il difetto
 * `:AutoTrigger` non portava nessuna traccia di chi l'avesse creata. Con
 * un'unica sorgente — una persona — la domanda non esisteva. Dal momento in
 * cui una proposta accettata può creare un'automazione, quella traccia è
 * l'unica cosa che permette di rispondere a «questa regola chi l'ha voluta?»,
 * e senza risposta non si può nemmeno decidere se fidarsi.
 *
 * ## Perché non basta una proprietà
 * Scrivere `origin: 'ai_proposal'` e fermarsi lì sarebbe teatro: la proprietà
 * racconterebbe una cosa vera senza cambiarne nessuna. Il rilievo della
 * revisione era preciso — «automazione disattivata riapre `execute_script` /
 * `call_webhook`» — e diceva questo: una proposta crea un'automazione spenta e
 * innocua, poi qualcuno la modifica, poi qualcuno la accende, e a quel punto
 * nessun controllo guarda più che cosa contiene. Il momento pericoloso non è
 * la creazione: è l'ACCENSIONE.
 *
 * Perciò qui c'è una funzione sola, `assertAzioniAmmesseDaProposta`, e si
 * chiama in due punti: quando la proposta crea l'automazione, e ogni volta
 * che qualcuno prova ad accenderne una di quell'origine. La seconda è quella
 * che serve davvero.
 */
import { AZIONI_AMMESSE_DA_PROPOSTA, isAutomationOrigin, type AutomationOrigin } from '@opengraphity/types'
import { ValidationError } from './errors.js'

/**
 * Le azioni di un'automazione, lette dal JSON che il nodo conserva.
 *
 * Tollerante sulla FORMA e severa sul CONTENUTO: un JSON illeggibile o di una
 * forma inattesa è un'automazione che non sappiamo leggere, e un'automazione
 * che non sappiamo leggere non si accende. Il contrario — «non riesco a
 * leggerla, la lascio passare» — è il fallback silenzioso che il prodotto non
 * fa.
 */
export function tipiDelleAzioni(actionsJson: unknown): string[] {
  if (actionsJson == null || actionsJson === '') return []
  if (typeof actionsJson !== 'string') {
    throw new ValidationError('The actions of an automation must be stored as JSON text', {
      key: 'errors.automation.actionsUnreadable', params: {},
    })
  }
  let letto: unknown
  try { letto = JSON.parse(actionsJson) } catch {
    throw new ValidationError('The actions of this automation are not valid JSON: it cannot be enabled', {
      key: 'errors.automation.actionsUnreadable', params: {},
    })
  }
  if (!Array.isArray(letto)) {
    throw new ValidationError('The actions of an automation must be a list', {
      key: 'errors.automation.actionsUnreadable', params: {},
    })
  }
  return letto.map((a) => {
    const tipo = (a as { type?: unknown } | null)?.type
    if (typeof tipo !== 'string' || tipo === '') {
      throw new ValidationError('Every action of an automation must declare its type', {
        key: 'errors.automation.actionsUnreadable', params: {},
      })
    }
    return tipo
  })
}

/**
 * La sbarra. Alza su qualunque azione fuori dall'allowlist ristretta,
 * NOMINANDOLA: chi legge l'errore deve sapere quale, non che «qualcosa non va».
 */
export function assertAzioniAmmesseDaProposta(actionsJson: unknown): void {
  const fuori = tipiDelleAzioni(actionsJson).filter((t) => !AZIONI_AMMESSE_DA_PROPOSTA.includes(t))
  if (fuori.length === 0) return
  const elenco = [...new Set(fuori)].join(', ')
  throw new ValidationError(
    `An automation created from an improvement proposal may only contain ${AZIONI_AMMESSE_DA_PROPOSTA.join(', ')}; `
    + `it contains: ${elenco}`,
    { key: 'errors.automation.originActionsForbidden', params: { actions: elenco } },
  )
}

/** L'origine letta dal nodo. Un valore sconosciuto vale `manual`: è il comportamento di prima. */
export function origineDi(props: Record<string, unknown>): AutomationOrigin {
  const grezzo = props['origin']
  return isAutomationOrigin(grezzo) ? grezzo : 'manual'
}

/**
 * Da chiamare PRIMA di accendere un'automazione.
 *
 * `origine` e `actionsJson` sono quelli che varranno DOPO l'aggiornamento:
 * chi chiama deve passare le azioni nuove se le sta cambiando, quelle salvate
 * se no. Un controllo sulle azioni vecchie mentre si scrivono le nuove
 * sarebbe un controllo che guarda dall'altra parte.
 */
export function assertAccensioneAmmessa(origine: AutomationOrigin, actionsJson: unknown): void {
  if (origine !== 'ai_proposal') return
  assertAzioniAmmesseDaProposta(actionsJson)
}
