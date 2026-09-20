/**
 * DA ERRORE DEL SERVER A EVENTO DI MONITORAGGIO (20 set 2026, ondata 3).
 *
 * Il terzo prerequisito dell'area D. I primi due erano l'archivio
 * (`lib/serverLogSink.ts`) e i CI della piattaforma (migrazione
 * `20261006_1010`); questo è il pezzo che li fa incontrare.
 *
 * ## Quello che NON fa
 * Non apre incident, non deduplica, non riconosce CI, non gestisce tempeste
 * né sfarfallio, non decide una severità di incident, non chiude niente. Tutte
 * queste cose esistono già e sono fatte bene: `services/events/pipeline.ts` le
 * fa da tre ondate, con lock, soglie di policy, raggruppamento e riapertura.
 * Questo modulo si limita a IMMETTERE eventi normalizzati in `enqueueEvents`,
 * esattamente come farebbe un Alertmanager — solo che parla da dentro.
 *
 * ## Le due domande, e perché sono due
 * Il progetto dice «per firma normalizzata e giorni distinti: un errore su un
 * giorno è un bug chiuso, su venti è un guasto». È vero, e da solo non basta:
 * un'interruzione che sta succedendo ADESSO produce duecento errori in cinque
 * minuti e zero giorni distinti, e aspettare tre giorni per accorgersene
 * renderebbe inutile tutto il resto. Quindi le regole sono due, dichiarate:
 *
 *  - **acuto** — molte occorrenze OGGI: è un guasto in corso, severità
 *    `critical`;
 *  - **cronico** — poche occorrenze ma su molti giorni distinti: è un difetto
 *    che dura e che nessuno ha mai guardato, severità `warning`.
 *
 * Una firma che soddisfa tutt'e due è acuta: la cosa più urgente vince.
 *
 * ## La chiusura
 * Una firma che non si vede più da `ORE_DI_QUIETE` manda un evento
 * `resolved`. Da lì in poi è `autoResolve.ts` a chiudere l'incident, se la
 * policy del tenant lo prevede: la decisione resta dov'era già.
 *
 * ## L'anello, di nuovo
 * Gli errori di QUESTO modulo non entrano nell'archivio — `MODULI_ESCLUSI` in
 * `serverLogSink.ts` contiene `server-log-events`. Senza, un connettore rotto
 * genererebbe errori che diventerebbero eventi che aprirebbero incident sul
 * connettore rotto.
 */
import { getSession, toNumber } from '@opengraphity/neo4j'
import type { NormalizedEvent } from '../services/events/normalize.js'
import { enqueueEvents } from '../jobs/eventIngestWorker.js'
import { aiFeatureEnabled } from './aiSettings.js'
import { logger } from './logger.js'

const log = logger.child({ module: 'server-log-events' })

/** Il tenant della piattaforma: qui vivono i CI di OpenGrafo e qui si aprono i suoi incident. */
export const TENANT_DI_PIATTAFORMA = 'opengrafo'
/** La sorgente interna creata dalla migrazione `20261006_1010`. */
export const SORGENTE_DEI_LOG = 'opengrafo-platform-logs'

/**
 * Le soglie. Stanno qui, tutte insieme, perché chi legge un evento aperto da
 * questo connettore possa risalire in un posto solo al perché è stato aperto.
 */
export const SOGLIE = {
  /** Occorrenze nel giorno corrente oltre le quali è un guasto in corso. */
  acutoOccorrenze: 20,
  /** Giorni distinti, nella finestra, oltre i quali è un difetto che dura. */
  cronicoGiorni: 3,
  /** Quanti giorni indietro si guarda per il cronico. */
  finestraGiorni: 7,
  /** Occorrenze totali minime perché un cronico valga la pena: tre giorni con una riga l'uno non sono un guasto. */
  cronicoOccorrenze: 10,
  /** Dopo quante ore senza vedere una firma la si dichiara rientrata. */
  oreDiQuiete: 24,
} as const

export interface FirmaAggregata {
  fingerprint: string
  service:     string
  module:      string
  level:       string
  template:    string
  stackHead:   string | null
  occorrenzeOggi:  number
  occorrenzeTotali: number
  giorniDistinti:  number
  ultimoGiorno:    string
  ultimoIstante:   string | null
}

/**
 * Gli aggregati per firma nella finestra. Una query sola: sono poche righe
 * (un nodo per firma e giorno) e l'indice `(fingerprint, day)` le copre.
 */
export const AGGREGATI_CYPHER = `
  MATCH (l:ServerLogEntry) WHERE l.day >= $dalGiorno
  WITH l.fingerprint AS fingerprint,
       collect(l) AS nodi,
       sum(l.count) AS occorrenzeTotali,
       count(DISTINCT l.day) AS giorniDistinti,
       max(l.day) AS ultimoGiorno,
       sum(CASE WHEN l.day = $oggi THEN l.count ELSE 0 END) AS occorrenzeOggi
  WITH fingerprint, occorrenzeTotali, giorniDistinti, ultimoGiorno, occorrenzeOggi,
       head([n IN nodi WHERE n.day = ultimoGiorno]) AS recente
  RETURN fingerprint, occorrenzeTotali, giorniDistinti, ultimoGiorno, occorrenzeOggi,
         recente.service AS service, recente.module AS module, recente.level AS level,
         recente.template AS template, recente.stack_head AS stackHead,
         recente.last_at AS ultimoIstante
  ORDER BY occorrenzeTotali DESC
`

export async function aggregatiPerFirma(adessoMs: number = Date.now()): Promise<FirmaAggregata[]> {
  const dalGiorno = new Date(adessoMs - SOGLIE.finestraGiorni * 86_400_000).toISOString().slice(0, 10)
  const oggi      = new Date(adessoMs).toISOString().slice(0, 10)
  const session = getSession()
  try {
    const r = await session.run(AGGREGATI_CYPHER, { dalGiorno, oggi })
    return r.records.map((rec) => ({
      fingerprint:      rec.get('fingerprint') as string,
      service:          rec.get('service') as string,
      module:           rec.get('module') as string,
      level:            rec.get('level') as string,
      template:         rec.get('template') as string,
      stackHead:        (rec.get('stackHead') as string | null) ?? null,
      occorrenzeOggi:   toNumber(rec.get('occorrenzeOggi')),
      occorrenzeTotali: toNumber(rec.get('occorrenzeTotali')),
      giorniDistinti:   toNumber(rec.get('giorniDistinti')),
      ultimoGiorno:     rec.get('ultimoGiorno') as string,
      ultimoIstante:    (rec.get('ultimoIstante') as string | null) ?? null,
    }))
  } finally {
    await session.close()
  }
}

export type Verdetto =
  | { stato: 'firing'; severita: 'critical' | 'warning'; motivo: 'acuto' | 'cronico' }
  | { stato: 'resolved' }
  | null

/**
 * Le tre regole, in una funzione pura — così si provano senza database e si
 * leggono senza seguire una query.
 *
 * L'ordine è deliberato: prima l'acuto (un guasto in corso batte tutto), poi
 * la quiete (se non si vede più, è rientrato), poi il cronico. Mettere la
 * quiete prima dell'acuto vorrebbe dire non accorgersi mai di un guasto
 * cominciato ieri sera e ancora in corso.
 */
export function verdettoPerFirma(f: FirmaAggregata, adessoMs: number = Date.now()): Verdetto {
  if (f.occorrenzeOggi >= SOGLIE.acutoOccorrenze) {
    return { stato: 'firing', severita: 'critical', motivo: 'acuto' }
  }
  const eta = f.ultimoIstante ? adessoMs - Date.parse(f.ultimoIstante) : Number.POSITIVE_INFINITY
  if (eta >= SOGLIE.oreDiQuiete * 3_600_000) return { stato: 'resolved' }
  if (f.giorniDistinti >= SOGLIE.cronicoGiorni && f.occorrenzeTotali >= SOGLIE.cronicoOccorrenze) {
    return { stato: 'firing', severita: 'warning', motivo: 'cronico' }
  }
  return null
}

/**
 * Da firma a evento.
 *
 * `externalId` è la firma: entra nell'impronta dell'evento
 * (`fingerprintOf`), quindi lo stesso errore ripreso domani ritrova il
 * proprio `:Event` e ne incrementa il `count` invece di crearne un altro.
 *
 * `resource` è il nome del PROCESSO, ed è lo stesso nome con cui la
 * migrazione ha censito il CI: il match avviene per `name_key`, senza alias.
 *
 * Il titolo porta il template, mai il messaggio grezzo: è l'unica cosa che
 * l'archivio conserva, e va bene così — un incident che dice «`Variable
 * <str> not defined` in graphql, 340 volte in 4 giorni» è più utile di uno
 * che riporta una occorrenza per intero.
 */
export function eventoPerFirma(f: FirmaAggregata, v: Exclude<Verdetto, null>): NormalizedEvent {
  const comune = {
    externalId:   f.fingerprint,
    title:        `${f.service} · ${f.module}: ${f.template}`,
    resource:     f.service,
    resourceKind: 'name' as const,
    labels: {
      source:      'server-log',
      fingerprint: f.fingerprint,
      module:      f.module,
      level:       f.level,
    },
  }
  if (v.stato === 'resolved') {
    return { ...comune, status: 'resolved', severity: 'info' }
  }
  return {
    ...comune,
    status:   'firing',
    severity: v.severita,
    /*
     * IN INGLESE, come ogni testo composto dall'API (guardiani
     * `noItalianInApiTexts` e `userFacingItalian`). Questa descrizione finisce
     * dentro un incident che una persona legge, e la lingua di un testo che
     * l'API compone non è mai l'italiano cablato — qui per giunta il tenant
     * di piattaforma è configurato in inglese. Non passa da i18n perché non è
     * un testo dell'interfaccia: è il CORPO di un ticket, scritto una volta e
     * conservato com'è, come la descrizione di qualunque altro incident
     * aperto dal monitoraggio.
     */
    description: [
      `Reason: ${v.motivo === 'acuto'
        ? `${String(f.occorrenzeOggi)} occurrences today (threshold ${String(SOGLIE.acutoOccorrenze)})`
        : `${String(f.giorniDistinti)} distinct days out of ${String(SOGLIE.finestraGiorni)} (threshold ${String(SOGLIE.cronicoGiorni)})`}`,
      `Occurrences in the window: ${String(f.occorrenzeTotali)}`,
      `Last seen: ${f.ultimoIstante ?? f.ultimoGiorno}`,
      f.stackHead ? `Where: ${f.stackHead}` : null,
      '',
      'The text above is a TEMPLATE: variable parts were replaced before the line',
      'was stored (lib/serverLogScrub.ts). The original message is NOT kept in the',
      'graph — read it in the process logs.',
    ].filter((r) => r !== null).join('\n'),
    labels: { ...comune.labels, motivo: v.motivo },
  }
}

/**
 * La passata. La chiama un job periodico; torna quanti eventi ha immesso.
 *
 * Non fa nulla se il tenant di piattaforma non esiste: su un'installazione di
 * un cliente questo connettore semplicemente non ha un posto dove scrivere, e
 * non è un errore.
 */
export async function immettiEventiDaiLog(adessoMs: number = Date.now()): Promise<{ immessi: number; esaminate: number }> {
  const session = getSession()
  try {
    const t = await session.run('MATCH (t:Tenant {id: $tenant}) RETURN count(t) AS n', { tenant: TENANT_DI_PIATTAFORMA })
    if (toNumber(t.records[0]?.get('n') ?? 0) === 0) return { immessi: 0, esaminate: 0 }
  } finally {
    await session.close()
  }

  /*
   * IL SECONDO VARCO (20 set 2026, rimedio a).
   *
   * Il primo sta nel sink: a interruttore spento l'archivio non si scrive.
   * Questo serve per l'archivio che ESISTE GIÀ — chi spegne `platformSelfAnalysis`
   * dopo averlo tenuto acceso si aspetta che il prodotto smetta di aprire
   * incident su di sé, non che continui a farlo per novanta giorni con quello
   * che aveva raccolto prima. Spegnere deve fermare, non solo smettere di
   * raccogliere.
   */
  if (!(await aiFeatureEnabled(TENANT_DI_PIATTAFORMA, 'platformSelfAnalysis'))) {
    log.info('server-log-events: platform self-analysis is off, no events enqueued')
    return { immessi: 0, esaminate: 0 }
  }

  const firme = await aggregatiPerFirma(adessoMs)
  const eventi: NormalizedEvent[] = []
  for (const f of firme) {
    const v = verdettoPerFirma(f, adessoMs)
    if (v) eventi.push(eventoPerFirma(f, v))
  }
  if (eventi.length === 0) {
    log.info({ esaminate: firme.length }, 'server-log-events: no signature over threshold')
    return { immessi: 0, esaminate: firme.length }
  }

  const immessi = await enqueueEvents(
    TENANT_DI_PIATTAFORMA, SORGENTE_DEI_LOG, eventi, new Date(adessoMs).toISOString(),
  )
  log.info({ immessi, esaminate: firme.length }, 'server-log-events: events enqueued')
  return { immessi, esaminate: firme.length }
}
