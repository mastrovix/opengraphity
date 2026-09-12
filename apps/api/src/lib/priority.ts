/**
 * Priorità ITIL = Impatto × Urgenza, **dalla matrice del cliente**.
 *
 * ## Com'era, e perché era un difetto
 * La matrice era un `Record` 3×3 nel codice, `isImpactUrgency` accettava
 * esattamente `high | medium | low`, e `impactUrgencyFromPriority` aveva un
 * `default → medium`. Ma il Dizionario permette di rinominare i valori di
 * `impact`, `urgency`, `severity` e `priority` — è una decisione presa — e
 * allora:
 *  - un impatto rinominato veniva **rifiutato** alla creazione (rumoroso, ma
 *    sbagliato: era una configurazione legittima);
 *  - una `severity` fuori dalle quattro veniva accettata e `impact`/`urgency`
 *    ricostruiti a `medium|medium` **in silenzio**, cioè P3 su un ticket che
 *    il cliente aveva chiamato P1.
 *
 * ## Com'è adesso
 * Un solo punto di validazione (`assertDomainValue`, nel nucleo
 * `lib/domainMatrix.ts`) e una sola traduzione (`resolveDomainMatrix` sulla
 * matrice `priority`, dato del cliente). Nessuna lista qui, nessun ripiego:
 * una combinazione che la matrice non copre è un errore che dice quale.
 *
 * L'**inverso** (da una `severity` sola ricostruire impatto e urgenza, che
 * serve a chi passa la sola severità via API) si calcola dalla matrice stessa
 * invece che da una tabella parallela: si cercano le celle che producono quel
 * valore e si sceglie in modo deterministico (vedi `invertPriority`). Così
 * anche l'inverso segue il cliente quando rinomina, e non c'è una seconda
 * tabella che può divergere dalla prima.
 */
import { ValidationError } from './errors.js'
import { assertDomainValue, loadDomainMatrix, matrixKey } from './domainMatrix.js'
import { resolveDomainValue } from './domainValue.js'

/**
 * Priorità dall'impatto e dall'urgenza. Entrambi validati contro i vocabolari
 * del cliente prima di cercare la cella, così il messaggio distingue «valore
 * che non esiste» da «combinazione che la matrice non copre».
 */
export async function derivePriority(tenantId: string, impact: unknown, urgency: unknown): Promise<string> {
  const i = await assertDomainValue(tenantId, 'impact', impact)
  const u = await assertDomainValue(tenantId, 'urgency', urgency)
  return resolveDomainValue(tenantId, 'priority', i, u)
}

/**
 * L'inverso della matrice: da una priorità alla coppia (impatto, urgenza) che
 * la produce. Serve a chi passa la sola `severity` (client API, import) e deve
 * comunque salvare un ticket coerente con l'invariante ITIL.
 *
 * Più celle possono produrre la stessa priorità (con la matrice di fabbrica
 * `high` viene sia da `high|medium` sia da `medium|high`). La scelta è
 * deterministica e dichiarata:
 *  1. la cella con **tutti gli ingressi uguali** fra loro, se esiste — è la
 *    lettura più neutra («impatto medio, urgenza media → P3»), ed è quella che
 *    il vecchio `impactUrgencyFromPriority` restituiva per `critical`,
 *    `medium` e `low`;
 *  2. altrimenti la **prima** cella nell'ordine della matrice — che sulla
 *    matrice di fabbrica dà `high → high|medium`, di nuovo come prima.
 *
 * Una priorità che nessuna cella produce è un errore: significa che il cliente
 * ha una priorità che la sua matrice non sa raggiungere, e inventare
 * `medium|medium` la nasconderebbe.
 */
export async function invertPriority(tenantId: string, priority: unknown): Promise<{ impact: string; urgency: string }> {
  const p = await assertDomainValue(tenantId, 'priority', priority)
  const matrix = await loadDomainMatrix(tenantId, 'priority')
  const candidates = Object.keys(matrix.entries).filter((k) => matrix.entries[k] === p)
  if (!candidates.length) {
    throw new ValidationError(
      `Matrice "priority" del cliente ${tenantId}: nessuna combinazione di impatto e urgenza produce "${p}". ` +
      `Completa la matrice in Impostazioni → Matrici di dominio` +
      (matrix.isDefault ? ' (ora è quella di fabbrica: è possibile che tu abbia rinominato un valore del vocabolario senza aggiornarla).' : '.'),
    )
  }
  const chosen = candidates.find((k) => { const parts = k.split('|'); return parts.every((v) => v === parts[0]) }) ?? candidates[0]!
  const [impact, urgency] = chosen.split('|')
  if (impact === undefined || urgency === undefined) {
    throw new Error(`Matrice "priority": la cella "${chosen}" non ha due dimensioni`)
  }
  return { impact, urgency }
}

/**
 * Impatto e urgenza da salvare su un ticket nuovo, dati impatto+urgenza
 * oppure la sola severità. È la logica condivisa da `createIncident` e
 * `createProblem`, che la ripetevano identica.
 */
export async function resolveNewTicketPriority(
  tenantId: string,
  input: { severity?: string | null; impact?: string | null; urgency?: string | null },
  /** Come si chiama il campo a una dimensione nell'API del chiamante: `severity` per l'incident, `priority` per il problem. */
  singleField = 'severity',
): Promise<{ severity: string; impact: string; urgency: string }> {
  const hasImpact  = input.impact  != null && input.impact  !== ''
  const hasUrgency = input.urgency != null && input.urgency !== ''
  if (hasImpact !== hasUrgency) {
    // Prima uno solo dei due veniva ignorato in silenzio e la priorità
    // ricostruita dalla severità: metà del dato dell'utente sparita.
    throw new ValidationError(`Impatto e urgenza si passano insieme: fornire entrambi, oppure la sola priorità (${singleField})`)
  }
  if (hasImpact && hasUrgency) {
    const severity = await derivePriority(tenantId, input.impact, input.urgency)
    return { severity, impact: input.impact!, urgency: input.urgency! }
  }
  if (input.severity != null && input.severity !== '') {
    const severity = await assertDomainValue(tenantId, 'priority', input.severity)
    const iu = await invertPriority(tenantId, severity)
    return { severity, impact: iu.impact, urgency: iu.urgency }
  }
  throw new ValidationError(`Fornire impact+urgency oppure ${singleField}`)
}

/**
 * Patch coerente di (priority, impact, urgency) su un aggiornamento parziale
 * di incident/problem, mantenendo l'invariante «priorità = impatto × urgenza»:
 *  - impatto e/o urgenza nella patch → merge col corrente e priorità
 *    ricalcolata;
 *  - solo la priorità nella patch → impatto e urgenza riallineati per
 *    inversione della matrice;
 *  - valori fuori vocabolario → `ValidationError` che elenca gli ammessi.
 * Ritorna `null` per i campi da non toccare (il chiamante usa coalesce).
 */
export async function resolvePriorityPatch(
  tenantId: string,
  current: { impact: string | null | undefined; urgency: string | null | undefined },
  patch: { priority?: string | null; impact?: string | null; urgency?: string | null },
): Promise<{ severity: string | null; impact: string | null; urgency: string | null }> {
  const hasIU = patch.impact != null || patch.urgency != null
  if (hasIU) {
    if (patch.impact  != null) await assertDomainValue(tenantId, 'impact',  patch.impact)
    if (patch.urgency != null) await assertDomainValue(tenantId, 'urgency', patch.urgency)
    const mImpact  = patch.impact  ?? current.impact
    const mUrgency = patch.urgency ?? current.urgency
    if (mImpact != null && mImpact !== '' && mUrgency != null && mUrgency !== '') {
      return { severity: await derivePriority(tenantId, mImpact, mUrgency), impact: mImpact, urgency: mUrgency }
    }
    // Manca la controparte (dato storico incompleto): si salva il valore dato,
    // la priorità resta quella corrente.
    return { severity: null, impact: patch.impact ?? null, urgency: patch.urgency ?? null }
  }
  if (patch.priority != null) {
    const priority = await assertDomainValue(tenantId, 'priority', patch.priority)
    const iu = await invertPriority(tenantId, priority)
    return { severity: priority, impact: iu.impact, urgency: iu.urgency }
  }
  return { severity: null, impact: null, urgency: null }
}

/** Riesportata per chi compone una chiave di matrice (test e pagina). */
export { matrixKey }
