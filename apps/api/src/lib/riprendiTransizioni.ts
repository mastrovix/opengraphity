/**
 * LE CHANGE CHE HANNO PERSO L'OCCASIONE RIPRENDONO A CAMMINARE (22 set 2026).
 *
 * ## Il difetto
 * Le transizioni automatiche si valutano SOLO dentro una mutation sulla change
 * (`evaluateAutoTransitions`, chiamato da chi chiude un assessment, salva o
 * completa un piano, approva). Nessun giro periodico le ripassava: una change
 * che si perdeva la sua occasione — un errore in quell'istante, un cammino che
 * non chiamava il walker, una condizione che allora non era registrata —
 * restava ferma PER SEMPRE, con tutte le condizioni soddisfatte.
 *
 * Trovato su `CHG00000003` di `c-one`: ferma in analisi dal 7 settembre coi
 * tre task completati e `all_assessments_complete` vera. Sarebbe bastato
 * toccarla, ma nessuno sapeva di doverlo fare.
 *
 * Dal 17 settembre la diagnostica lo DICEVA («apri quelle change e fai
 * avanzare il passo: il lavoro è già finito, manca solo il movimento»). È
 * meglio di niente, ed è comunque chiedere a una persona di fare da sveglia a
 * una macchina.
 *
 * ## Perché farlo è legittimo
 * L'arco è `trigger: 'automatic'`: è il CLIENTE ad aver disegnato «questo si
 * muove da solo». Che non si muova è un difetto del prodotto, non una sua
 * scelta da rispettare. E l'insieme delle change che questa passata tocca è
 * ESATTAMENTE quello che il rilievo elencava: stessa funzione, stessa
 * condizione valutata dal motore vero, stesso varco.
 *
 * ## Il varco si riconsulta un istante prima di muovere
 * `changeChePossonoMuoversi` lo ha già chiesto, ma fra la lettura e la mossa
 * passa del tempo — fino a duecento change per tenant — e una finestra di
 * rilascio può chiudersi nel frattempo. Chiederlo due volte costa poco;
 * muovere una change fuori dalla sua finestra costa a chi la subisce.
 *
 * ## Chi risulta aver mosso
 * `ATTORE`, e si legge nella storia della change. Non «un utente»: nessuna
 * persona ha cliccato, e far finta di sì renderebbe l'audit una bugia.
 */
import { getSession } from '@opengraphity/neo4j'
import { changeChePossonoMuoversi } from './changesStuck.js'
import { automaticTransitionOutcome } from '../graphql/resolvers/change/windowGate.js'
import { logger } from './logger.js'
import { transitionTicket } from '../services/ticketTransition.js'

const log = logger.child({ module: 'transizioni-riprese' })

/** L'attore delle transizioni riprese: si legge nella storia della change. */
export const ATTORE = 'sistema:ripresa-automatica'

/**
 * Quante se ne muovono per tenant a ogni passata.
 *
 * Venti e non duecento: una passata che muove duecento change in un colpo fa
 * partire duecento catene di azioni, notifiche e webhook nello stesso istante.
 * Quelle che restano le prende il giro dopo — e se ce ne sono davvero tante, è
 * un'informazione che vale la pena leggere nei log invece di nascondere sotto
 * un lavoro enorme.
 */
export const MAX_PER_GIRO = 20

export interface EsitoRipresa {
  /** Quante ne ha mosse davvero. */
  mosse: number
  /** Quante erano candidate: se è più di `MAX_PER_GIRO`, il resto va al giro dopo. */
  candidate: number
  /** Quante il varco ha rifiutato all'ultimo istante. */
  rifiutateDalVarco: number
}

/**
 * Riprende le change ferme di UN tenant: la passata del tenant, nella sua
 * coda `workflow-jobs@<tenant>` (23 set 2026). Prima una passata di
 * piattaforma leggeva i tenant e li girava uno per uno.
 */
export async function riprendiTransizioniDi(tenantId: string): Promise<EsitoRipresa> {
  const session = getSession(undefined, 'WRITE')
  try {
    const candidate = await changeChePossonoMuoversi(session, tenantId)
    if (candidate.length === 0) return { mosse: 0, candidate: 0, rifiutateDalVarco: 0 }

    let mosse = 0
    let rifiutateDalVarco = 0
    for (const c of candidate.slice(0, MAX_PER_GIRO)) {
      /*
       * Il varco, di nuovo: vedi il perché in testa al file. `Outcome` e non
       * `Allowed` perché quest'ultima conta una metrica a ogni rifiuto, e una
       * passata periodica seppellirebbe i rifiuti veri sotto i suoi.
       */
      const varco = await automaticTransitionOutcome(session, {
        tenantId,
        changeId:    c.changeId,
        changeType:  String(c.props['change_type'] ?? ''),
        currentStep: c.fromStep,
        toStep:      c.toStep,
      })
      if (!varco.allowed) { rifiutateDalVarco++; continue }

      /*
       * Un fallimento non ferma gli altri: questa passata guarda l'intera coda
       * di un cliente, e una change con la configurazione rotta non deve
       * lasciare ferme quelle che vengono dopo. L'errore si scrive per intero.
       */
      try {
        // The pipeline of the transitions (wave 7 · B1): the guards of every
        // path; a refusal is logged and noted on the change by the pipeline.
        const esito = await transitionTicket(session, {
          tenantId, instanceId: c.instanceId, toStep: c.toStep,
          actor: { kind: 'system', path: 'change_auto', userId: ATTORE }, triggerType: 'automatic',
        })
        if (esito.moved) {
          mosse++
          log.info({ tenantId, change: c.code, from: c.fromStep, to: c.toStep },
            'a change that had missed its automatic transition was moved on')
        } else if (esito.refusal.guard === 'change_window') {
          rifiutateDalVarco++
        }
      } catch (err) {
        log.error({ err, tenantId, change: c.code, from: c.fromStep, to: c.toStep },
          'moving this change failed, the others go on')
      }
    }
    return { mosse, candidate: candidate.length, rifiutateDalVarco }
  } finally {
    await session.close()
  }
}
