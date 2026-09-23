/**
 * WHEN THE TICKETS ARRIVE, AND WHICH ONES ARE STILL OPEN (22 Sep 2026).
 *
 * ## The defect this fixes
 * The first version drew two different dates: a closed ticket got a date
 * anywhere in the three years, an open one got a date in the last few days —
 * because an open ticket "must be recent". With 20% of the tickets open, that
 * put three thousand changes into the last fortnight: the "changes per month"
 * chart showed thirty-six months around 350 and then a wall at 2907. The
 * owner of the product saw it in one look: "this distribution is completely
 * unrealistic".
 *
 * ## The model
 * A ticket's arrival and its being open are TWO SEPARATE THINGS, and only the
 * first decides the shape of the chart:
 *
 *  - ARRIVALS are one process over the whole period, with a volume that moves
 *    month by month — periods that grow, periods that fall, August empty,
 *    the odd month out of scale. Nothing about open or closed touches this
 *    curve, so the monthly chart has the shape the arrivals have and nothing
 *    else.
 *  - BEING OPEN is then a matter of the ticket's LIFE: `stillOpen` draws how
 *    long each ticket lasts from the durations of its kind
 *    (`DEMO_RATIOS.lifetimes`), and a ticket is open while its life is not
 *    over. A ticket from last week is often still open, one from last year
 *    almost never — and how many are open is not a share asked for but what
 *    the durations give (Little's law: arrivals a day × the mean life, see
 *    `lifetimes` below). The owner asked for 20% first, and chose the
 *    durations when the arithmetic showed what 20% meant (options.ts).
 */
import type { Rng } from './random.js'
import type { DemoClock } from './clock.js'
import { DAY, HOUR } from './clock.js'

/**
 * THE SHAPE OF A MONTH'S VOLUME.
 *
 * Not a straight line: the owner asked for distributions that move — "there
 * can be trends that grow and trends that fall, depending on the period".
 * Three things move them, and they are the three that move a real service
 * desk:
 *
 *  - a slow WANDER from month to month (a team that grows, a migration that
 *    ends, a contract that changes): a random walk pulled back towards its
 *    own level, so a year can climb and the next can fall back;
 *  - the CALENDAR: August is empty, December ends early, January and
 *    September come back full — the holidays of the country the tenant is in;
 *  - a few MONTHS OUT OF SCALE: a go-live, a data-centre move, a security
 *    campaign. Rare (about one year in ten months) and never a wall.
 */
function monthlyWeights(rng: Rng, months: number): number[] {
  const out: number[] = []
  // Si parte più in basso e si sale: un'azienda che adotta lo strumento ne
  // fa passare sempre di più. Non è una retta — il vagare mese per mese sopra
  // ci mette periodi che scendono — ma la tendenza dei tre anni è in salita.
  /*
   * D2 (tour of 23 Sep 2026): the level could climb fourfold over three
   * years, and September 2026 — the month the demo is shown — had 2,196
   * incidents in 22 days, three times the average, which filled the open
   * queue. The company grows, but by half, not fourfold.
   */
  let level = rng.float(0.7, 0.85)
  let drift = rng.float(0.005, 0.025)
  for (let i = 0; i < months; i++) {
    // The drift itself changes slowly: that is what makes a PERIOD grow and
    // the next one fall, instead of a line that only goes one way.
    if (rng.chance(0.14)) drift = rng.float(-0.04, 0.05)
    level = Math.min(1.5, Math.max(0.6, level * Math.exp(drift + rng.float(-0.05, 0.05))))
    out.push(level)
  }
  return out
}

/**
 * `count` instants over [from, to), spread month by month with the shape
 * above, each one landed inside working hours. Sorted, oldest first.
 *
 * The COUNTS per month come from the weights, so the chart has the shape; the
 * instant inside the month is uniform (and then moved into working hours), so
 * the days inside a month stay plain.
 */
export function arrivalInstants(rng: Rng, clock: DemoClock, count: number, from: number, to: number): number[] {
  if (count <= 0) return []
  if (!(to > from)) throw new Error('arrivalInstants: the window is empty')
  // The month boundaries of the window, in the tenant's own zone.
  const edges: number[] = [from]
  const d = new Date(from)
  let cursor = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)
  while (cursor < to) { edges.push(cursor); cursor = new Date(Date.UTC(new Date(cursor).getUTCFullYear(), new Date(cursor).getUTCMonth() + 1, 1)).getTime() }
  edges.push(to)
  const months = edges.length - 1
  const SEASON = [1.08, 1.02, 1.05, 0.96, 1.0, 0.94, 0.86, 0.55, 1.12, 1.06, 1.02, 0.78]
  const wander = monthlyWeights(rng, months)
  const weights = wander.map((w, i) => {
    const start = edges[i]!, end = edges[i + 1]!
    const season = SEASON[new Date(start).getUTCMonth()]!
    // A partial month at either edge carries its own fraction, so the first
    // and the last column of the chart are short, as they really are.
    const fraction = (end - start) / (31 * DAY)
    // A month out of scale belongs to the past: the months the demo is shown in are ordinary (D2).
    const recent = i >= months - 2
    const surge = !recent && rng.chance(0.09) ? rng.float(1.35, 1.9) : 1
    return Math.max(0.02, w * season * surge * Math.min(1, fraction * (31 / 30.4)))
  })
  const total = weights.reduce((a, b) => a + b, 0)
  // Counts per month, largest remainder so they add up to exactly `count`.
  const exact = weights.map((w) => (w / total) * count)
  const counts = exact.map((x) => Math.floor(x))
  const left = count - counts.reduce((a, b) => a + b, 0)
  const order = exact.map((x, i) => ({ i, rest: x - Math.floor(x) })).sort((a, b) => b.rest - a.rest)
  for (let k = 0; k < left; k++) counts[order[k % order.length]!.i] = counts[order[k % order.length]!.i]! + 1

  const out: number[] = []
  for (let i = 0; i < months; i++) {
    const start = edges[i]!, end = edges[i + 1]!
    for (let k = 0; k < counts[i]!; k++) {
      const at = start + rng.next() * (end - start)
      out.push(clock.workInstant(rng, Math.max(start, at - 6 * HOUR), Math.min(end, at + 6 * HOUR)))
    }
  }
  return out.sort((a, b) => a - b)
}

/**
 * QUANTO DURA UN TICKET, E DA LÌ QUANTI SONO APERTI.
 *
 * Due tentativi sbagliati prima di questo, e vale la pena scriverli perché
 * sono lo stesso errore in due forme:
 *
 *  1. «il 20% è aperto» con una data recente per gli aperti → tremila change
 *     nell'ultima quindicina, e il grafico dei mesi con un muro alla fine;
 *  2. «il 20% è aperto» scegliendo gli aperti fra i più recenti → il grafico
 *     tornava liscio, ma TUTTO quello che era arrivato negli ultimi mesi
 *     risultava aperto, e la coda era di duecento giorni di arrivi.
 *
 * L'errore, in tutte e due, è trattare «quanti sono aperti» come un parametro.
 * Non lo è: è una CONSEGUENZA. In una coda in equilibrio vale la legge di
 * Little — aperti ≈ arrivi al giorno × durata media — e la durata è la cosa
 * che si conosce davvero di un processo: un incident si chiude in ore, una
 * change ci mette settimane fra valutazione, CAB e finestra.
 *
 * Quindi qui si estrae la DURATA di ogni ticket, e aperto è quello la cui
 * durata non è ancora finita. Ne segue tutto il resto da sé: il numero degli
 * aperti, la loro età, e il fatto che fra i ticket di ieri ce ne siano di
 * chiusi e di aperti, che è come sono fatti i giorni veri.
 *
 * La coda INCAGLIATA (`stuckShare`) è la parte che un demo deve mostrare: il
 * ticket fermo in attesa di un fornitore, la change che aspetta la finestra
 * del trimestre. È una seconda popolazione con la sua durata, dichiarata
 * invece che nascosta in un numero tondo.
 */
export interface Lifetime {
  /** La durata tipica di chi si chiude normalmente. */
  medianHours: number
  /** Quanto è larga la coda di quella durata (log-normale). */
  spread: number
  /** La quota che si incaglia. */
  stuckShare: number
  /** La durata tipica di chi si incaglia. */
  stuckMedianDays: number
}

/** La durata di ogni ticket, in millisecondi. */
export function lifetimes(rng: Rng, n: number, l: Lifetime): number[] {
  const out: number[] = []
  for (let i = 0; i < n; i++) {
    out.push(rng.chance(l.stuckShare)
      ? rng.logNormal(l.stuckMedianDays * DAY, 0.85)
      : rng.logNormal(l.medianHours * HOUR, l.spread))
  }
  return out
}

/**
 * Chi è ancora aperto: quello la cui durata non è finita. Restituisce un
 * flag per ticket, nell'ordine delle date.
 */
export function stillOpen(rng: Rng, createdAt: readonly number[], nowMs: number, l: Lifetime): boolean[] {
  const lives = lifetimes(rng, createdAt.length, l)
  return createdAt.map((at, i) => at + lives[i]! > nowMs)
}
