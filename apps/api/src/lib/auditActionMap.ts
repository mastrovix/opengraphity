/**
 * DUE CONVENZIONI, UN VOCABOLARIO (20 set 2026).
 *
 * Programma «Miglioramento continuo», ondata 2.
 *
 * ## Il problema, misurato
 * Le azioni del registro sono ~186 stringhe scritte a mano in due convenzioni
 * mescolate: `comment.added`, `incident.assigned`, `tenant.ai_settings.updated`
 * accanto a `change_created`, `change_transition`, `whatif_analysis`. Più le
 * voci generiche `mutation.<nome>` che il registro scrive per le ~120 mutation
 * senza una `audit()` su misura.
 *
 * Contare coppie di azioni ripetute su quell'insieme produce coppie che
 * riflettono **la storia del codice**, non il lavoro delle persone: la stessa
 * operazione reale compare sotto due nomi a seconda che qualcuno, anni fa,
 * avesse scritto una chiamata dedicata.
 *
 * ## La regola, e le eccezioni dichiarate
 * La regola copre la quasi totalità: `<oggetto>.<verbo>` — e dove ci sono più
 * punti, l'oggetto è tutto ciò che precede l'ultimo. Le eccezioni sono poche,
 * stanno scritte qui sotto con il loro perché, e il guardiano
 * `auditActionMap.test.ts` pretende che OGNI azione conosciuta si normalizzi:
 * una stringa nuova senza casa fa cadere il test, invece di diventare una
 * coppia sbagliata che nessuno controlla.
 *
 * Non si inventa un valore di ripiego. Un'azione che la regola non sa leggere
 * torna `null`, e chi aggrega la salta CONTANDOLA: un aggregato che nasconde
 * quello che non ha capito è peggio di uno che non c'è.
 */

/** Verbo e oggetto canonici di un'azione del registro. */
export interface AzioneNormalizzata {
  /** Su cosa si è agito: `incident`, `change`, `catalog_form`… */
  object: string
  /** Che cosa si è fatto: `created`, `assigned`, `transitioned`… */
  verb:   string
}

/**
 * Le azioni che la regola non sa leggere, e cosa sono davvero.
 *
 * Sono tutte anteriori alla convenzione col punto: si tengono perché un
 * registro non si riscrive — le voci storiche portano quei nomi per sempre.
 */
const ECCEZIONI: Readonly<Record<string, AzioneNormalizzata>> = {
  change_created:        { object: 'change',       verb: 'created' },
  change_transition:     { object: 'change',       verb: 'transitioned' },
  domain_matrix_updated: { object: 'domain_matrix', verb: 'updated' },
  /** Scritta da `onStepEntered` per qualunque entità: l'oggetto vero sta in `entity_type`. */
  stepEntered:           { object: 'workflow',     verb: 'step_entered' },
  whatif_analysis:       { object: 'what_if',      verb: 'analysed' },
}

/**
 * Le voci generiche del registro delle mutation.
 *
 * `mutation.createIncident` non dice l'oggetto in modo affidabile — il nome
 * della mutation è camelCase e la sua entità la deduce il plugin — quindi si
 * normalizza a un oggetto dichiarato `mutation` con il nome come verbo. È
 * onesto: sono voci di seconda qualità, e chi aggrega deve poterle distinguere
 * da quelle scritte su misura.
 */
const PREFISSO_MUTATION = 'mutation.'

export function isGenericMutationAction(action: string): boolean {
  return action.startsWith(PREFISSO_MUTATION)
}

/**
 * Normalizza un'azione del registro, o `null` se non sa leggerla.
 *
 * `null` non è un errore: è un'informazione che chi aggrega deve riportare.
 */
export function normalizeAuditAction(action: string): AzioneNormalizzata | null {
  const a = action.trim()
  if (a === '') return null

  const eccezione = ECCEZIONI[a]
  if (eccezione) return eccezione

  if (isGenericMutationAction(a)) {
    const nome = a.slice(PREFISSO_MUTATION.length)
    return nome === '' ? null : { object: 'mutation', verb: nome }
  }

  const ultimo = a.lastIndexOf('.')
  if (ultimo <= 0 || ultimo === a.length - 1) return null
  return { object: a.slice(0, ultimo), verb: a.slice(ultimo + 1) }
}

/**
 * La chiave con cui due azioni si confrontano in una sequenza.
 *
 * Si usa l'oggetto + il verbo e non la stringa grezza, perché è l'unica forma
 * in cui `change_created` e un eventuale `change.created` sono la stessa cosa.
 */
export function actionKey(action: string): string | null {
  const n = normalizeAuditAction(action)
  return n ? `${n.object}.${n.verb}` : null
}
