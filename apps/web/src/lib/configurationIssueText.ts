/**
 * LA FRASE della diagnostica, composta DAL CLIENT.
 *
 * L'API manda fatti: una `kind` — che è la chiave — e i soli `params` da
 * interpolare. Non manda frasi, e non potrebbe: non sa in che lingua guarda chi
 * legge (non c'è `Accept-Language`, e l'utente non porta una lingua). Il difetto
 * misurato in un browser in inglese era esattamente questo: interfaccia
 * inglese, banner della diagnostica in italiano.
 *
 * Qui si risolve la chiave, in un posto solo, perché la stessa diagnostica la
 * mostrano due schermate (il banner in cima e la pagina dei workflow) e due
 * copie divergerebbero.
 */
import type { TFunction } from 'i18next'

export interface IssueParam { name: string; value: string }
export interface GapData { kind: string; params: IssueParam[] }
export interface IssueData {
  kind: string
  severity: string
  params: IssueParam[]
  gaps?: GapData[] | null
  where: string | null
}

/** Le coppie come oggetto, che è la forma che vuole l'interpolazione. */
function valori(params: readonly IssueParam[] | null | undefined): Record<string, string | number> {
  const out: Record<string, string | number> = {}
  for (const p of params ?? []) out[p.name] = p.value
  /*
    `count` deve arrivare NUMERO: è quello che i18next usa per scegliere il
    plurale, e una stringa gli fa scegliere sempre `_other` («Ci sono 1 cose»).
    Nel trasporto è una stringa perché i parametri sono coppie di stringhe —
    non c'è uno scalare JSON nello schema, e non serve.
  */
  if (typeof out['count'] === 'string' && out['count'].trim() !== '') out['count'] = Number(out['count'])
  return out
}

/**
 * «La chiave esiste?» va chiesto CON i parametri.
 *
 * `i18n.exists('…matrix_stale_keys')` è **falso** quando la frase esiste solo
 * nelle sue due forme plurali (`_one`/`_other`), perché senza `count` i18next
 * non sa quale forma cercare. Chiesto senza parametri, il ripiego scattava su
 * ogni frase al plurale: il banner mostrava la chiave grezza al posto di una
 * traduzione che c'era. Visto in un test, che è il posto giusto.
 */
export type EsisteChiave = (chiave: string, params?: Record<string, string | number>) => boolean

/**
 * Una chiave che non c'è non si nasconde: si legge la chiave grezza.
 *
 * È il caso di un'API più nuova del bundle — un `kind` aggiunto ieri che questo
 * client non conosce. Mostrare niente sarebbe il peggiore dei due mali: l'admin
 * vedrebbe «C'è 1 cosa da sistemare» e sotto una riga vuota. Così invece si
 * legge male ma si legge, e si capisce che manca una traduzione.
 */
function risolvi(
  t: TFunction, esiste: EsisteChiave, chiave: string, params: Record<string, string | number>,
): string {
  if (!esiste(chiave, params)) {
    const extra = Object.entries(params).map(([k, v]) => `${k}=${String(v)}`).join(', ')
    return extra ? `${chiave} (${extra})` : chiave
  }
  return t(chiave, params)
}

/** Un buco di configurazione, nella lingua di chi guarda. */
export function gapText(t: TFunction, esiste: EsisteChiave, gap: GapData): string {
  return risolvi(t, esiste, `configurationIssues.gap.${gap.kind}`, valori(gap.params))
}

/** Una voce della diagnostica, nella lingua di chi guarda. */
export function issueText(t: TFunction, esiste: EsisteChiave, issue: IssueData): string {
  const params = valori(issue.params)
  // `reason` può mancare (lo schema degradato non sempre sa dire perché): il
  // ripiego è una frase TRADOTTA, non una italiana scritta nell'API.
  // «(e altri N)» si dice solo se N > 0: con 3 team su 3 in elenco, «e altri
  // 0» e una frase sbagliata. Il frammento e tradotto, non composto qui.
  if (issue.kind === 'teams_without_sourcing') {
    const altri = Number(params['others'] ?? 0)
    params['more'] = altri > 0 ? t('configurationIssues.andMore', { count: altri }) : ''
  }
  if (issue.kind === 'schema_degraded' && params['reason'] === undefined) {
    params['reason'] = t('configurationIssues.reasonUnavailable')
  }
  // I buchi sono un elenco di chiavi, non una frase già cucita: la cuce qui chi
  // sa anche come si separa un elenco nella sua lingua.
  if (issue.gaps && issue.gaps.length > 0) {
    params['gaps'] = issue.gaps.map((g) => gapText(t, esiste, g)).join('; ')
  }
  return risolvi(t, esiste, `configurationIssues.issue.${issue.kind}`, params)
}
