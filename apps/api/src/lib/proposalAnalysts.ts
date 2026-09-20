/**
 * GLI ANALISTI — ondata 1: uno solo, e senza AI (20 set 2026).
 *
 * Un analista è una funzione che guarda i dati di un cliente e consegna
 * proposte. Niente di più: chi le scrive, chi applica i tetti e chi tiene la
 * memoria dei rifiuti è `proposals.ts`.
 *
 * ## Perché il primo analista non chiama nessun modello
 * La parte rischiosa della spina è il cammino accetta → esegui → disfa, non
 * la generazione. Provarlo con un modello nel mezzo significherebbe non
 * sapere, quando qualcosa va storto, se ha sbagliato la spina o il modello.
 * Perciò le prime proposte le scrive la DIAGNOSTICA, che è codice
 * deterministico e gira già per ogni cliente.
 *
 * ## Il pezzo che la revisione ha trovato mancante
 * Un rilievo della diagnostica NON è una proposta: è `{kind, severity,
 * params, where}` dove i `params` sono stringhe da mostrare
 * (`values: "critical, blocker"`), non identificatori. Fra i due c'è un
 * ADATTATORE per ciascun `kind` che si vuole coprire, e l'adattatore è dove
 * sta il lavoro vero. Qui ce n'è uno, dichiarato: gli altri entrano
 * nell'ondata 2, uno per volta, ognuno col suo test.
 */
import { configurationIssues, type ConfigurationIssue } from './configurationIssues.js'
import { portalSeverityOptions } from './portalSeverityOptions.js'
import type { ProposalToWrite } from './proposals.js'
import { logger } from './logger.js'

/**
 * Gli adattatori: da un rilievo a una proposta.
 *
 * Chi restituisce `null` dice «questo rilievo non è chiudibile con un'azione»
 * — e la maggior parte non lo è, perché la correzione è una decisione umana:
 * quale fuso, quale calendario, quale cella di una matrice impatto×urgenza.
 * Quelli restano nella diagnostica, che è il posto giusto per loro.
 */
type Adattatore = (tenantId: string, issue: ConfigurationIssue) => Promise<ProposalToWrite | null>

/**
 * `portal_severities_stale` → «togli dal portale le severità che il
 * Dizionario non ha più».
 *
 * È il primo e per ora l'unico, e la scelta è motivata: è l'unico rilievo
 * che si chiude in modo deterministico (non serve decidere niente: quei
 * valori non esistono più) e in modo totalmente reversibile (un campo unico
 * sul tenant, il cui stato precedente si cattura per intero).
 *
 * L'impronta non porta i valori stantii: il SOGGETTO è «le severità del
 * portale di questo cliente», e resta lo stesso se domani il Dizionario ne
 * rende stantia un'altra. Se ci mettessimo i valori, ogni cambiamento del
 * vocabolario farebbe nascere una proposta nuova mentre la vecchia è ancora
 * aperta — e due proposte per lo stesso problema sono un difetto, non due
 * informazioni.
 */
const severitaStantie: Adattatore = async (tenantId, issue) => {
  if (issue.kind !== 'portal_severities_stale') return null
  const options = await portalSeverityOptions(tenantId)
  if (options === null) return null

  const values = String(issue.params['values'] ?? '')
  const stantie = values.split(',').map((v) => v.trim()).filter((v) => v !== '')
  if (stantie.length === 0) return null

  /*
   * Non si propone di svuotare il portale: se togliendole non resta niente,
   * il rilievo va risolto da una persona scegliendo le severità nuove. Lo
   * dice la diagnostica, che per questo non smette di segnalarlo.
   */
  if (stantie.length >= options.length) return null

  return {
    tenantId,
    area:  'configuration',
    kind:  'proposal.portalSeveritiesStale',
    params: {
      values: stantie.join(', '),
      count:  String(stantie.length),
    },
    scope: 'portal_severities',
    evidence: {
      // Le prove di un rilievo di configurazione sono lo stato, non una serie
      // storica: `n` è quante severità sono stantie, la finestra è zero
      // perché la fotografia è di adesso.
      n: stantie.length,
      windowDays: 0,
      refs: [],
      extra: { stale: stantie.join(', '), remaining: options.length - stantie.length },
    },
    action: { type: 'portal_severities.remove_stale', params: {} },
  }
}

const ADATTATORI: readonly Adattatore[] = [severitaStantie]

/**
 * L'analista della configurazione, versione senza AI.
 *
 * Legge i rilievi che la diagnostica produce già e ne trasforma in proposte
 * quelli per cui esiste un'azione. Gli altri non li tocca: restano dove sono.
 */
export async function analizzaConfigurazione(tenantId: string): Promise<ProposalToWrite[]> {
  const issues = await configurationIssues(tenantId)
  const out: ProposalToWrite[] = []
  for (const issue of issues) {
    for (const adatta of ADATTATORI) {
      try {
        const p = await adatta(tenantId, issue)
        if (p) { out.push(p); break }
      } catch (err) {
        /*
         * Un adattatore che cade non ferma gli altri, e non fa cadere il giro
         * di questo cliente: si dice e si va avanti. Ma non si tace: un
         * adattatore rotto è un difetto nostro, e se nessuno lo vede resta
         * rotto.
         */
        logger.error(
          { module: 'proposals', tenantId, kind: issue.kind, err: err instanceof Error ? err.message : String(err) },
          'proposals: adattatore fallito',
        )
      }
    }
  }
  return out
}
