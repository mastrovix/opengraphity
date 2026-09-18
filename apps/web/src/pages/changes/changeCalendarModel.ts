/**
 * IL MODELLO DEL CALENDARIO DELLE CHANGE (17 set 2026).
 *
 * Qui stanno le tre cose che un calendario deve azzeccare e che a occhio non
 * si controllano: quale intervallo si sta guardando, in quali giorni cade una
 * finestra, e quali finestre si pestano i piedi.
 *
 * ## I giorni sono quelli di chi guarda
 * Le finestre arrivano come istanti (ISO con offset esplicito); i giorni del
 * calendario si calcolano con i componenti LOCALI, perché «lunedì» è lunedì
 * per chi legge lo schermo. Un rilascio alle 23:00 del 21 con fine alle 01:00
 * del 22 compare in DUE caselle: è la stessa finestra vista da due giorni, e
 * farla sparire da uno dei due sarebbe peggio che mostrarla in entrambi.
 *
 * ## Le sovrapposizioni si guardano fra i RILASCI
 * Due validazioni contemporanee non fanno male a nessuno: sono verifiche. Due
 * RILASCI nello stesso momento sì, e di due gravità diverse:
 *  - sullo STESSO CI è un conflitto vero — due change che toccano la stessa
 *    macchina insieme, e nessuna delle due sa dell'altra;
 *  - su CI diversi è un avviso: può essere legittimo (due squadre, due
 *    sistemi) o può essere una notte troppo carica, e lo decide chi approva.
 * Una change non si sovrappone a sé stessa: i suoi passi sono un piano, non un
 * conflitto.
 */

/** Una voce come arriva dall'API: una finestra, col suo tipo, task e CI. */
import { finestreSiSovrappongono, intervalliSiSovrappongono } from '@opengraphity/types'

export interface VoceCalendario {
  changeId:    string
  code:        string
  title:       string
  changeType:  string | null
  priority:    string | null
  currentStep: string | null
  kind:        'validation' | 'release'
  start:       string
  end:         string
  stepTitle:   string
  taskCode:    string | null
  ciId:        string
  ciName:      string
}

/** `none` nessun conflitto · `warn` rilasci insieme su CI diversi · `clash` sullo stesso CI. */
export type Sovrapposizione = 'none' | 'warn' | 'clash'

export interface VoceSegnata extends VoceCalendario {
  sovrapposizione: Sovrapposizione
  /** I codici delle change con cui questa finestra si sovrappone, senza ripetizioni. */
  conflittoCon: readonly string[]
}

export type Modo = 'week' | 'month'

/** Mezzanotte locale del giorno di `d`. */
function inizioGiorno(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate())
}

/** Il lunedì della settimana di `d` (la settimana ITSM comincia di lunedì). */
export function inizioSettimana(d: Date): Date {
  const g = inizioGiorno(d)
  // `getDay()` dà 0 per domenica: la si tira indietro di sei, non avanti di uno.
  const scarto = (g.getDay() + 6) % 7
  return new Date(g.getFullYear(), g.getMonth(), g.getDate() - scarto)
}

/**
 * L'intervallo che si sta guardando e i giorni che lo compongono.
 *
 * In modo `month` la griglia parte dal lunedì della settimana in cui cade il
 * primo del mese e arriva alla domenica dell'ultima: sono le caselle che si
 * disegnano, e l'intervallo chiesto all'API deve coprirle tutte — altrimenti i
 * giorni «di coda» del mese precedente resterebbero vuoti per finta.
 */
export function intervallo(modo: Modo, riferimento: Date): { da: Date; a: Date; giorni: Date[] } {
  const da = modo === 'week'
    ? inizioSettimana(riferimento)
    : inizioSettimana(new Date(riferimento.getFullYear(), riferimento.getMonth(), 1))
  const quanti = modo === 'week' ? 7 : (() => {
    const primoDopo = new Date(riferimento.getFullYear(), riferimento.getMonth() + 1, 1)
    const fine = inizioSettimana(new Date(primoDopo.getFullYear(), primoDopo.getMonth(), primoDopo.getDate() - 1))
    // Dal lunedì iniziale alla domenica che chiude la settimana dell'ultimo giorno.
    return Math.round((fine.getTime() - da.getTime()) / 86_400_000) + 7
  })()
  const giorni = Array.from({ length: quanti }, (_, i) =>
    new Date(da.getFullYear(), da.getMonth(), da.getDate() + i))
  const a = new Date(da.getFullYear(), da.getMonth(), da.getDate() + quanti)
  return { da, a, giorni }
}

/** Sposta il riferimento di una settimana o di un mese, avanti o indietro. */
export function scorri(modo: Modo, riferimento: Date, passi: number): Date {
  return modo === 'week'
    ? new Date(riferimento.getFullYear(), riferimento.getMonth(), riferimento.getDate() + 7 * passi)
    : new Date(riferimento.getFullYear(), riferimento.getMonth() + passi, 1)
}

/*
 * La regola della sovrapposizione è in `@opengraphity/types`
 * (`finestreSiSovrappongono`), perché la usa anche l'API per i conflitti sul
 * DETTAGLIO di una change (18 set 2026): due copie avrebbero risposto in modo
 * diverso alla domanda «un rilascio che finisce nell'istante in cui l'altro
 * comincia è un conflitto?». Qui resta la parte che riguarda il calendario:
 * quale livello, e su quali voci.
 */

/**
 * Segna ogni voce con la sua sovrapposizione. Si confrontano solo i RILASCI, e
 * solo fra change DIVERSE.
 */
export function conSovrapposizioni(voci: readonly VoceCalendario[]): VoceSegnata[] {
  const ms = (s: string) => Date.parse(s)
  const segnate: VoceSegnata[] = voci.map((v) => ({ ...v, sovrapposizione: 'none', conflittoCon: [] }))

  const rilasci = segnate
    .map((v, i) => ({ v, i }))
    .filter(({ v }) => v.kind === 'release' && !Number.isNaN(ms(v.start)) && !Number.isNaN(ms(v.end)))

  const conflitti = new Map<number, Set<string>>()
  const livelli = new Map<number, Sovrapposizione>()

  for (let x = 0; x < rilasci.length; x++) {
    for (let y = x + 1; y < rilasci.length; y++) {
      const a = rilasci[x]!, b = rilasci[y]!
      if (a.v.changeId === b.v.changeId) continue
      if (!finestreSiSovrappongono({ start: a.v.start, end: a.v.end }, { start: b.v.start, end: b.v.end })) continue
      // Lo stesso CI è un conflitto, CI diversi un avviso. Il livello di una
      // voce è il PEGGIORE dei suoi: una change che urta due volte, di cui una
      // sullo stesso CI, si legge come conflitto.
      const livello: Sovrapposizione = a.v.ciId !== '' && a.v.ciId === b.v.ciId ? 'clash' : 'warn'
      for (const [uno, altro] of [[a, b], [b, a]] as const) {
        if (!conflitti.has(uno.i)) conflitti.set(uno.i, new Set())
        conflitti.get(uno.i)!.add(altro.v.code)
        if (livelli.get(uno.i) !== 'clash') livelli.set(uno.i, livello)
      }
    }
  }

  for (const [i, codici] of conflitti) {
    segnate[i]!.conflittoCon = [...codici].sort()
    segnate[i]!.sovrapposizione = livelli.get(i) ?? 'warn'
  }
  return segnate
}

/** Quante change distinte e quante finestre in conflitto: il riassunto in testa. */
export function riassunto(voci: readonly VoceSegnata[]): {
  change: number; finestre: number; rilasci: number; conflitti: number; avvisi: number
} {
  return {
    change:    new Set(voci.map((v) => v.changeId)).size,
    finestre:  voci.length,
    rilasci:   voci.filter((v) => v.kind === 'release').length,
    conflitti: voci.filter((v) => v.sovrapposizione === 'clash').length,
    avvisi:    voci.filter((v) => v.sovrapposizione === 'warn').length,
  }
}

/**
 * LE BARRE DI UNA SETTIMANA (17 set 2026).
 *
 * Con una casella per giorno, una finestra di ventiquattro ore compariva due
 * volte — il 9 e il 10 — e le due caselle non dicevano di essere la stessa
 * cosa: tre rilasci accavallati si leggevano come sei momenti distinti, e il
 * calendario risultava incomprensibile (detto dal proprietario guardandolo).
 *
 * Una finestra è una BARRA che attraversa i giorni che occupa. Così
 * l'accavallamento si vede dalla forma: tre barre impilate sotto le stesse
 * colonne sono tre rilasci nello stesso momento, e non serve leggere le ore.
 *
 * `continuaPrima` e `continuaDopo` dicono che la finestra esce dalla settimana:
 * la barra si disegna col bordo piatto da quel lato, invece di far credere che
 * cominci il lunedì o finisca la domenica.
 *
 * Le CORSIE si assegnano per settimana, non una per voce: due finestre che non
 * si toccano stanno sulla stessa riga, e la griglia resta bassa. L'ordine è per
 * colonna e poi per durata, così le barre lunghe finiscono in alto — è l'ordine
 * in cui l'occhio le legge.
 */
export interface BarraDiCalendario {
  v:             VoceSegnata
  /** La colonna in cui la barra comincia dentro questa settimana (0 = lunedì). */
  colonna:       number
  /** Quante colonne occupa, almeno una. */
  span:          number
  continuaPrima: boolean
  continuaDopo:  boolean
  corsia:        number
}

export function barreDellaSettimana(
  voci: readonly VoceSegnata[],
  giorni: readonly Date[],
): BarraDiCalendario[] {
  if (giorni.length === 0) return []
  const primo = giorni[0]!.getTime()
  const ultimo = new Date(
    giorni[giorni.length - 1]!.getFullYear(),
    giorni[giorni.length - 1]!.getMonth(),
    giorni[giorni.length - 1]!.getDate() + 1,
  ).getTime()

  const grezze = voci
    .map((v) => {
      const da = Date.parse(v.start)
      const a  = Date.parse(v.end)
      if (Number.isNaN(da) || Number.isNaN(a) || a <= da) return null
      if (!intervalliSiSovrappongono(da, a, primo, ultimo)) return null
      /*
       * La prima e l'ultima colonna che la finestra tocca dentro la settimana.
       * `colonna` parte a -1 e non a 0: con lo zero non si distingue «tocca il
       * lunedì» da «non ho ancora trovato niente», e una finestra che comincia
       * di mercoledì veniva disegnata dal lunedì.
       */
      let colonna = -1
      let fine = -1
      giorni.forEach((g, i) => {
        const gDa = g.getTime()
        const gA  = new Date(g.getFullYear(), g.getMonth(), g.getDate() + 1).getTime()
        if (!intervalliSiSovrappongono(da, a, gDa, gA)) return
        if (colonna === -1) colonna = i
        fine = i
      })
      if (colonna === -1) return null
      return {
        v, colonna, span: fine - colonna + 1,
        continuaPrima: da < primo,
        continuaDopo:  a > ultimo,
        corsia: 0,
      }
    })
    .filter((b): b is BarraDiCalendario => b !== null)
    .sort((x, y) => x.colonna - y.colonna || y.span - x.span || x.v.code.localeCompare(y.v.code))

  // Corsie: la prima libera in cui la barra non si accavalla a nessun'altra.
  const occupate: Array<Array<{ da: number; a: number }>> = []
  for (const b of grezze) {
    const da = b.colonna
    const a  = b.colonna + b.span - 1
    let corsia = 0
    while (occupate[corsia]?.some((o) => da <= o.a && o.da <= a)) corsia += 1
    if (!occupate[corsia]) occupate[corsia] = []
    occupate[corsia]!.push({ da, a })
    b.corsia = corsia
  }
  return grezze
}

/** I giorni divisi in settimane da sette: sono le righe della griglia. */
export function settimane(giorni: readonly Date[]): Date[][] {
  const out: Date[][] = []
  for (let i = 0; i < giorni.length; i += 7) out.push(giorni.slice(i, i + 7))
  return out
}

/** Il filtro del calendario: solo rilasci, solo validazioni, o tutto. */
export type FiltroTipo = 'all' | 'release' | 'validation'

/**
 * Le voci del tipo scelto — e si applica DOPO `conSovrapposizioni`, non prima.
 *
 * Le sovrapposizioni si calcolano fra i rilasci: filtrando prima, «solo
 * validazioni» non avrebbe nulla da confrontare (giusto), ma «solo rilasci»
 * darebbe lo stesso risultato solo per caso, e un filtro futuro (per squadra,
 * per ambiente) nasconderebbe un conflitto vero senza dirlo. Un filtro di
 * VISTA non deve cambiare i fatti: decide cosa si disegna, non cosa è vero.
 */
export function soloDelTipo(voci: readonly VoceSegnata[], tipo: FiltroTipo): VoceSegnata[] {
  return tipo === 'all' ? [...voci] : voci.filter((v) => v.kind === tipo)
}

/** Il filtro sullo stato della change: in corso, concluse, o tutte. */
export type FiltroStato = 'all' | 'open' | 'done'

/**
 * Le CATEGORIE di passo che vogliono dire «questa change è finita».
 *
 * Si guarda la CATEGORIA del passo e non il suo nome: è un vocabolario chiuso
 * (`WORKFLOW_STEP_CATEGORIES`) e un cliente che rinomina «Closed» in «Chiusa e
 * archiviata» non deve sparire dal filtro — è il difetto che questo prodotto ha
 * già pagato altrove, con le guardie delle change che riconoscevano i passi dal
 * nome.
 *
 * `failed` sta qui accanto a `closed` e `resolved`: una change annullata,
 * rifiutata o non riuscita è finita, e metterla fra quelle «in corso»
 * gonfierebbe il calendario di lavoro che nessuno farà.
 */
export const CATEGORIE_CONCLUSE: readonly string[] = ['closed', 'resolved', 'failed']

/**
 * Le voci delle change nello stato scelto. `categoriaDi` arriva da chi chiama
 * (nel web è `useWorkflowSteps('change').categoryOf`), così questo modulo resta
 * puro e provabile senza montare un componente.
 *
 * Una categoria SCONOSCIUTA — passo non trovato, o change senza istanza di
 * workflow, come le più vecchie — conta come «in corso»: non è chiusa da
 * nessun passo, e farla sparire da entrambi i filtri la renderebbe invisibile
 * tranne che in «tutte», dove nessuno la cercherebbe.
 */
export function soloDelloStato(
  voci: readonly VoceSegnata[],
  stato: FiltroStato,
  categoriaDi: (step: string | null) => string | null,
): VoceSegnata[] {
  if (stato === 'all') return [...voci]
  const conclusa = (v: VoceSegnata) => CATEGORIE_CONCLUSE.includes(categoriaDi(v.currentStep) ?? '')
  return voci.filter((v) => (stato === 'done' ? conclusa(v) : !conclusa(v)))
}
