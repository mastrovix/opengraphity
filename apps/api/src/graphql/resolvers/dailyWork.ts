/**
 * GLI AGGREGATI DEL LAVORO QUOTIDIANO — il resolver (20 set 2026).
 *
 * Una query sola che li calcola tutti: chi apre la pagina vuole la fotografia
 * intera, e cinque andate e ritorno per cinque riquadri sono cinque occasioni
 * di vedere numeri di istanti diversi.
 *
 * Permesso: `analysis.read`, lo stesso delle anomalie. Sono misure del lavoro
 * della squadra, non dati di un ticket: chi può guardare le analisi può
 * guardare queste.
 */
import type { GraphQLContext } from '../../context.js'
import { requirePermission } from '../../lib/permissions.js'
import {
  copertura, azioniUmane, tempiNeiPassi, coppieRipetute, adozioneFunzioniAI, SOGLIE,
} from '../../lib/dailyWorkAggregates.js'

const FINESTRA_PREDEFINITA = 30
const FINESTRA_MASSIMA = 365

async function dailyWorkAggregates(
  _: unknown,
  args: { windowDays?: number },
  ctx: GraphQLContext,
) {
  requirePermission(ctx, 'analysis.read')
  const giorni = Math.min(Math.max(args.windowDays ?? FINESTRA_PREDEFINITA, 1), FINESTRA_MASSIMA)

  const [coverage, actions, stepTimes, pairs, aiUsage] = await Promise.all([
    copertura(ctx.tenantId, giorni),
    azioniUmane(ctx.tenantId, giorni),
    tempiNeiPassi(ctx.tenantId, giorni),
    coppieRipetute(ctx.tenantId, giorni),
    adozioneFunzioniAI(ctx.tenantId, giorni),
  ])

  /*
   * LO SCHEMA PARLA INGLESE, IL CODICE INTERNO NO (20 set 2026).
   *
   * Dentro, i nomi sono in italiano come tutto il resto di questo prodotto.
   * Fuori, no: lo schema GraphQL è la superficie pubblica, e un campo
   * `conVoceDiCreazione` obbligherebbe chiunque la usi — noi, un'integrazione,
   * un domani un cliente — a imparare l'italiano per leggere l'API. La prima
   * versione di questo file li aveva in italiano; l'ha visto `check-i18n`.
   */
  return {
    coverage: {
      tickets:           coverage.ticket,
      withCreationEntry: coverage.conVoceDiCreazione,
      entries:           coverage.vociTotali,
      humanEntries:      coverage.vociUmane,
      genericEntries:    coverage.vociGeneriche,
      unreadableActions: coverage.azioniNonLette,
      windowDays:        coverage.finestraGiorni,
    },
    actions: actions.map((r) => ({
      object: r.object, verb: r.verb, n: r.n,
      distinctActors: r.autoriDistinti, distinctObjects: r.oggettiDistinti,
    })),
    /*
     * I passi con poche esecuzioni si tolgono QUI e non nella query: la
     * soglia è una regola del motore, e volerla vedere accanto alle altre
     * (§ `SOGLIE`) vale più di un `WHERE` sparso. Una mediana su tre
     * esecuzioni non è una mediana.
     */
    stepTimes: stepTimes
      .filter((s) => s.n >= SOGLIE.esecuzioniMinimePerPasso)
      .map((s) => ({
        stepName: s.stepName, n: s.n,
        medianHours: s.medianaOre, p90Hours: s.p90Ore,
        over48h: s.oltre48h, discardedZeros: s.zeriScartati,
      })),
    pairs: pairs.map((p) => ({
      first: p.prima, then: p.poi, n: p.n,
      distinctObjects: p.oggettiDistinti, distinctActors: p.autoriDistinti,
    })),
    aiUsage: aiUsage.map((u) => ({
      feature: u.feature, n: u.n, distinctActors: u.autoriDistinti,
    })),
    thresholds: {
      minWindowDays:          SOGLIE.finestraMinimaGiorni,
      minOccurrences:         SOGLIE.occorrenzeMinime,
      minRunsPerStep:         SOGLIE.esecuzioniMinimePerPasso,
      pairMinOccurrences:     SOGLIE.coppia.occorrenze,
      pairMinDistinctObjects: SOGLIE.coppia.oggettiDistinti,
      pairMinDistinctActors:  SOGLIE.coppia.autoriDistinti,
      pairMaxMinutes:         SOGLIE.coppia.minutiMassimi,
    },
  }
}

export const dailyWorkResolvers = {
  Query: { dailyWorkAggregates },
}
