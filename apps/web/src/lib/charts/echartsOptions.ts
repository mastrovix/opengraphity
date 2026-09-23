/**
 * Builder ECharts condivisi — unica palette, unico tema.
 *
 * Prima esistevano tre renderer (CustomWidgetCard, WidgetPreview,
 * ReportChartRenderer) con palette duplicate (e `var(--color-brand)` ripetuto
 * tre volte nella stessa palette → fette di torta dello stesso colore), gauge
 * scritto due volte e look diverso tra anteprima e widget reale.
 *
 * I token CSS vengono risolti a runtime con `cssVar` perché ECharts vuole
 * numeri/hex, non `var(--…)`.
 */
import { cssVar, cssVarPx } from './cssVar'
import i18n from '@/i18n/i18n'

// ── Dati ─────────────────────────────────────────────────────────────────────

export interface ChartPoint { label: string; value: number }

/** Voci dei report: il server può usare `name` o `label`, `date` per le serie temporali. */
export interface LooseChartPoint { name?: string; label?: string; date?: string; value: number }

export function toPoints(items: LooseChartPoint[]): ChartPoint[] {
  return items.map((it) => ({ label: it.date ?? it.name ?? it.label ?? '—', value: it.value }))
}

// ── Tema (lazy: i token esistono solo nel browser) ───────────────────────────

function theme() {
  return {
    font:        cssVar('--font-family'),
    textDark:    cssVar('--color-slate-dark'),
    text:        cssVar('--color-slate'),
    textLight:   cssVar('--color-slate-light'),
    tooltipBg:   cssVar('--color-slate-dark'),
    tooltipText: cssVar('--color-slate-bg'),
    grid:        cssVar('--color-slate-bg'),
    border:      cssVar('--color-border'),
    brand:       cssVar('--color-brand'),
    fsBody:      cssVarPx('--font-size-body'),
    fsTable:     cssVarPx('--font-size-table'),
    fsTitle:     cssVarPx('--font-size-page-title'),
  }
}

/** Palette categorica unica (10 colori distinti, niente duplicati). */
export function chartPalette(): string[] {
  return [
    cssVar('--color-brand'),
    cssVar('--color-trigger-automatic'),
    cssVar('--color-warning'),
    cssVar('--color-danger'),
    cssVar('--color-purple-light'),
    cssVar('--color-teal-light'),
    cssVar('--color-lime'),
    cssVar('--color-trigger-timer'),
    cssVar('--color-teal'),
    cssVar('--color-pink'),
  ]
}

export interface ChartStyle {
  /** Colore unico della serie (widget); se assente si usa la palette per elemento. */
  color?: string
  /** Etichette valore sulle barre / fette (report). */
  showValueLabels?: boolean
  /** Layout più stretto (card dashboard). */
  compact?: boolean
}

function tooltip(trigger: 'item' | 'axis', extra: Record<string, unknown> = {}) {
  const t = theme()
  return {
    trigger,
    backgroundColor: t.tooltipBg,
    borderColor: t.tooltipBg,
    borderWidth: 1,
    textStyle: { color: t.tooltipText, fontSize: t.fsBody, fontFamily: t.font },
    padding: [8, 12],
    ...extra,
  }
}

function axisLabel(compact: boolean, extra: Record<string, unknown> = {}) {
  const t = theme()
  return { color: t.text, fontSize: compact ? t.fsTable : t.fsBody, fontFamily: t.font, ...extra }
}

/**
 * `passo`: a time axis whose step between two shown labels is known (D5). The
 * labels are drawn at 0, passo, 2·passo… — the same ones `etichetteTemporali`
 * gave the year to — and never rotated. Without it the axis keeps what it did:
 * every label (report) or ECharts' own choice (compact card).
 */
function categoryAxis(labels: string[], compact: boolean, rotate = 0, passo?: number) {
  const t = theme()
  const scelta = passo !== undefined ? { interval: passo - 1, rotate: 0 } : compact ? {} : { interval: 0, rotate }
  return {
    type: 'category' as const,
    data: labels,
    axisLabel: axisLabel(compact, scelta),
    axisLine: { lineStyle: { color: t.border } },
    axisTick: { show: false },
  }
}

function valueAxis(compact: boolean) {
  const t = theme()
  return {
    type: 'value' as const,
    axisLabel: axisLabel(compact),
    splitLine: { lineStyle: { color: t.grid, type: 'dashed' as const } },
    axisLine: { show: false },
    axisTick: { show: false },
  }
}

function legend(compact: boolean) {
  const t = theme()
  return {
    bottom: 0,
    type: 'scroll' as const,
    icon: 'circle',
    itemWidth: 8,
    itemHeight: 8,
    textStyle: { color: t.text, fontSize: compact ? t.fsTable : t.fsBody, fontFamily: t.font },
  }
}

function itemColor(style: ChartStyle, i: number, palette: string[]): string {
  return style.color ?? palette[i % palette.length]!
}


/*
 * SPAZIO PER L'ETICHETTA DEL VALORE (20 set 2026, dal giro nel browser: «la
 * linea mostra i valori ma non si vedono bene, alcuni tagliati»).
 *
 * L'etichetta sta SOPRA il punto, e la griglia arrivava fin sotto il bordo:
 * il valore del punto più alto finiva mezzo fuori. Con le etichette accese
 * la griglia si abbassa di una riga di testo — e ai lati un po' d'aria, se
 * no il primo e l'ultimo valore escono dal riquadro.
 */
function grigliaConEtichette(
  griglia: Record<string, unknown>, mostraValori: boolean | undefined,
): Record<string, unknown> {
  if (!mostraValori) return griglia
  return {
    ...griglia,
    top:   Number(griglia['top'] ?? 0) + 20,
    left:  Number(griglia['left'] ?? 0) + 8,
    right: Number(griglia['right'] ?? 0) + 8,
  }
}

// ── Assi temporali: quante etichette ci stanno (D5) ─────────────────────────

/**
 * HOW MANY TIME LABELS FIT (D5, tour of 23 Sep 2026).
 *
 * «Incidents per month» — a full-width widget — showed month and year without
 * overlapping; «Requests per month», the same chart at half the width, drew
 * all its forty labels on top of each other: a report chart forces every
 * label (`interval: 0`), and forty «Sep» do not fit in 450px.
 *
 * The step is chosen from the WIDTH the chart really has, measured by the
 * component that draws it: every label that fits is shown, one in two, three,
 * four, six or twelve when they do not. The step is a round number of
 * periods, so the labels fall on the same months every year, and
 * `etichetteTemporali` gives the year to the first SHOWN label of each year
 * — with ECharts' automatic thinning the label carrying the year could be
 * the one that disappeared.
 */
const PASSI_TONDI = [1, 2, 3, 4, 6, 12, 24] as const
/** The plot area is the chart minus the value axis and the margins. */
const MARGINI_ASSE = 72
/** Room between two labels, in px. */
const SPAZIO_FRA_ETICHETTE = 12
/** Average width of a character, as a share of the font size. */
const LARGHEZZA_CARATTERE = 0.62

export function passoEtichette(quante: number, larghezza: number | undefined, caratteri: number, fontPx: number): number {
  if (!larghezza || larghezza <= 0 || quante <= 1 || !(fontPx > 0)) return 1
  const posto = caratteri * fontPx * LARGHEZZA_CARATTERE + SPAZIO_FRA_ETICHETTE
  const massimo = Math.max(1, Math.floor(Math.max(larghezza - MARGINI_ASSE, posto) / posto))
  if (quante <= massimo) return 1
  const minimo = Math.ceil(quante / massimo)
  return PASSI_TONDI.find((p) => p >= minimo) ?? minimo
}

/** The longest line of the labels (a two-line label counts its longest line). */
function caratteriMassimi(etichette: readonly string[]): number {
  return Math.max(1, ...etichette.flatMap((e) => e.split('\n')).map((r) => r.length))
}

/**
 * The labels of a category axis and, when they are dates and the width is
 * known, the step between the shown ones. `passo` undefined = not a time axis,
 * or a width nobody measured: the axis keeps its old behaviour.
 */
function etichetteAsse(
  labels: string[], style: { locale?: string; granularita?: string | null; larghezza?: number; compact?: boolean },
): { etichette: string[]; passo: number | undefined } {
  const locale = style.locale ?? 'en'
  const tutte = etichetteTemporali(labels, locale, { granularita: style.granularita })
  if (tutte === null) return { etichette: labels, passo: undefined }
  if (!style.larghezza) return { etichette: tutte, passo: undefined }
  const t = theme()
  const passo = passoEtichette(labels.length, style.larghezza, caratteriMassimi(tutte), style.compact ? t.fsTable : t.fsBody)
  return { etichette: passo > 1 ? (etichetteTemporali(labels, locale, { granularita: style.granularita, passo }) ?? tutte) : tutte, passo }
}

// ── Builder ──────────────────────────────────────────────────────────────────

export function buildBarOption(points: ChartPoint[], style: ChartStyle & { locale?: string; granularita?: string | null; larghezza?: number } = {}) {
  const t = theme()
  const compact = style.compact ?? false
  const palette = chartPalette()
  // Anche un istogramma può essere raggruppato per mese: stesse etichette, e
  // lo stesso diradamento quando non ci stanno tutte (D5).
  const { etichette, passo } = etichetteAsse(points.map((p) => p.label), style)
  return {
    tooltip: tooltip('axis', { axisPointer: { type: 'shadow' } }),
    grid: grigliaConEtichette(compact
      ? { top: 12, right: 12, bottom: 20, left: 40, containLabel: true }
      : { left: 16, right: 16, bottom: 48, top: 16, containLabel: true }, style.showValueLabels),
    xAxis: categoryAxis(etichette, compact, points.length > 6 ? 30 : 0, passo),
    yAxis: valueAxis(compact),
    series: [{
      type: 'bar',
      data: points.map((p, i) => ({ value: p.value, itemStyle: { color: itemColor(style, i, palette), borderRadius: [4, 4, 0, 0] } })),
      barMaxWidth: 48,
      label: style.showValueLabels
        ? { show: true, position: 'top', color: t.text, fontSize: t.fsBody, fontWeight: 600, fontFamily: t.font }
        : { show: false },
    }],
  }
}

export function buildHorizontalBarOption(points: ChartPoint[], style: ChartStyle & { locale?: string; granularita?: string | null } = {}) {
  const t = theme()
  const compact = style.compact ?? false
  const palette = chartPalette()
  const etichette = etichetteTemporali(points.map((p) => p.label), style.locale ?? 'en', { unaRiga: true, granularita: style.granularita })
  const conEtichette = etichette === null ? points : points.map((p, i) => ({ ...p, label: etichette[i]! }))
  const rev = [...conEtichette].reverse()
  return {
    tooltip: tooltip('axis', { axisPointer: { type: 'shadow' } }),
    grid: { left: 16, right: 60, bottom: 16, top: 16, containLabel: true },
    xAxis: valueAxis(compact),
    yAxis: { ...categoryAxis(rev.map((p) => p.label), compact), axisLine: { lineStyle: { color: t.border } } },
    series: [{
      type: 'bar',
      data: rev.map((p, i) => ({ value: p.value, itemStyle: { color: itemColor(style, rev.length - 1 - i, palette), borderRadius: [0, 4, 4, 0] } })),
      barMaxWidth: 32,
      label: style.showValueLabels
        ? { show: true, position: 'right', color: t.text, fontSize: t.fsBody, fontWeight: 600, fontFamily: t.font }
        : { show: false },
    }],
  }
}

/**
 * LE ETICHETTE DI UN ASSE TEMPORALE, come le scrive un foglio di calcolo
 * (19 set 2026).
 *
 * Il server manda date ISO — `2026-01-01`, `2026-02-01`, … — e l'asse le
 * stampava tutte per intero, una sopra l'altra: nove etichette da dieci
 * caratteri in uno spazio da tre. Il proprietario: «non si capisce nulla, in
 * questi casi l'anno dovrebbe stare in basso e ogni mese mostrare solo il
 * mese, come farebbe Excel».
 *
 * Quindi: il PERIODO sulla prima riga (gen, feb… oppure «6 apr» per i giorni)
 * e l'ANNO sulla seconda, ma SOLO quando cambia — cioè sul primo punto e a
 * ogni capodanno. È esattamente l'asse a due livelli dei fogli di calcolo, e
 * si ottiene con un `\n` dentro l'etichetta.
 *
 * Il periodo si riconosce dai DATI e non da un parametro: se ogni data è il
 * primo del mese la serie è mensile. Così vale anche per un grafico salvato
 * prima che il periodo esistesse, e per i widget della dashboard, che la
 * configurazione della sezione non ce l'hanno.
 */
export function etichetteTemporali(
  labels: readonly string[], locale: string,
  opts: { unaRiga?: boolean; granularita?: string | null; passo?: number } = {},
): string[] | null {
  const ISO = /^(\d{4})-(\d{2})-(\d{2})$/
  const pezzi = labels.map((l) => ISO.exec(l))
  if (labels.length === 0 || pezzi.some((m) => m === null)) return null

  /*
   * IL PERIODO, SE LO SAPPIAMO, LO DICE CHI CHIAMA.
   *
   * Il costruttore e il dettaglio del report conoscono `groupByGranularity`:
   * passarlo toglie ogni indovinello. Con un solo punto l'inferenza sbagliava
   * — una torta raggruppata PER ANNO con un anno solo di dati mostrava «gen
   * 2026» invece di «2026» (visto nel browser il 19 set).
   *
   * L'inferenza resta per chi quel dato non ce l'ha: i widget della dashboard
   * e le sezioni salvate prima che il periodo esistesse.
   */
  const annuale = opts.granularita === 'year'
    || (opts.granularita == null && pezzi.length >= 2 && pezzi.every((m) => m![2] === '01' && m![3] === '01'))
  const mensile = !annuale && (opts.granularita === 'month'
    || (opts.granularita == null && pezzi.every((m) => m![3] === '01')))
  let annoPrecedente = ''
  // D5: with a step, only the labels at 0, passo, 2·passo… are drawn, and the
  // year goes to the first DRAWN label of each year, not to one that is hidden.
  const passo = Math.max(1, Math.floor(opts.passo ?? 1))
  return pezzi.map((m, i) => {
    const [, anno, mese, giorno] = m!
    if (annuale) return anno!
    // Mezzogiorno UTC: costruire la data a mezzanotte la farebbe scivolare al
    // giorno prima nei fusi a ovest, e un «1 gennaio» diventerebbe dicembre.
    const d = new Date(Date.UTC(Number(anno), Number(mese) - 1, Number(giorno), 12))
    const periodo = mensile
      ? d.toLocaleDateString(locale, { month: 'short', timeZone: 'UTC' })
      : d.toLocaleDateString(locale, { day: 'numeric', month: 'short', timeZone: 'UTC' })
    /*
     * Due righe solo dove c'è un ASSE condiviso (linea, barre verticali): lì
     * l'anno vale per tutte le etichette che seguono. In una torta o in una
     * barra orizzontale ogni etichetta sta per conto suo — una riga, con
     * l'anno sempre, altrimenti «gen» da solo non dice di quale anno è.
     */
    if (opts.unaRiga === true) return `${periodo} ${anno!}`
    if (i % passo !== 0) return periodo
    const nuovo = anno !== annoPrecedente
    annoPrecedente = anno!
    return nuovo ? `${periodo}\n${anno!}` : periodo
  })
}

export function buildLineOption(points: ChartPoint[], style: ChartStyle & { area?: boolean; locale?: string; granularita?: string | null; larghezza?: number } = {}) {
  const t = theme()
  const compact = style.compact ?? false
  const color = style.color ?? t.brand
  // D5: month and year, and as many labels as the measured width holds.
  const { etichette, passo } = etichetteAsse(points.map((p) => p.label), style)
  return {
    tooltip: tooltip('axis'),
    grid: grigliaConEtichette(compact
      ? { top: 12, right: 12, bottom: 20, left: 40, containLabel: true }
      : { left: 16, right: 16, bottom: 48, top: 16, containLabel: true }, style.showValueLabels),
    xAxis: categoryAxis(etichette, compact, 0, passo),
    yAxis: valueAxis(compact),
    series: [{
      type: 'line',
      data: points.map((p) => p.value),
      smooth: true,
      symbol: 'circle',
      symbolSize: 6,
      /*
       * IL VALORE SUI PUNTI (20 set 2026, dal giro nel browser: «nella linea
       * dove ci sono i puntini dovrebbe esserci anche il valore»).
       *
       * `showValueLabels` arriva acceso da ogni sezione di report
       * (`ReportChartRenderer`) e la linea era l'unico grafico che lo
       * ignorava: barre e torte scrivevano il numero, la linea no. Lo stesso
       * dato cambiava leggibilità cambiando disegno, e su una serie di pochi
       * punti — che è il caso normale di un report mensile — il numero è
       * proprio quello che si va a leggere.
       */
      label: style.showValueLabels
        ? { show: true, position: 'top', distance: 8, color: t.text, fontSize: t.fsBody, fontWeight: 600, fontFamily: t.font }
        : { show: false },
      // Fuori dal riquadro non si taglia, e due valori vicini non si
      // sovrappongono: sparisce il secondo invece di diventare illeggibili
      // tutti e due.
      labelLayout: { hideOverlap: true },
      clip: false,
      lineStyle: { color, width: 2.5 },
      itemStyle: { color, borderWidth: 2, borderColor: cssVar('--color-white') },
      ...(style.area
        ? { areaStyle: { color: { type: 'linear', x: 0, y: 0, x2: 0, y2: 1, colorStops: [{ offset: 0, color: `${color}33` }, { offset: 1, color: `${color}05` }] } } }
        : {}),
    }],
  }
}

export function buildPieOption(points: ChartPoint[], style: ChartStyle & { donut?: boolean; centerText?: string; locale?: string; granularita?: string | null } = {}) {
  const t = theme()
  const compact = style.compact ?? false
  const palette = chartPalette()
  const donut = style.donut ?? false
  const etichette = etichetteTemporali(points.map((p) => p.label), style.locale ?? 'en', { unaRiga: true, granularita: style.granularita })
  return {
    tooltip: tooltip('item', { formatter: '{b}: {c} ({d}%)' }),
    legend: legend(compact),
    ...(donut && style.centerText !== undefined
      ? {
          graphic: [
            { type: 'text', left: 'center', top: '40%', style: { text: style.centerText, fontSize: t.fsTitle, fontWeight: 700, fill: t.textDark, fontFamily: t.font } },
            { type: 'text', left: 'center', top: '50%', style: { text: i18n.t('reportChart.total'), fontSize: t.fsBody, fill: t.text, fontFamily: t.font } },
          ],
        }
      : {}),
    series: [{
      type: 'pie',
      radius: donut ? (compact ? ['40%', '70%'] : ['40%', '65%']) : (compact ? '65%' : ['0%', '65%']),
      center: ['50%', '45%'],
      data: points.map((p, i) => ({
        // Le fette non hanno un asse: l'etichetta temporale va su una riga
        // sola, con l'anno (vedi `etichetteTemporali`).
        name: etichette?.[i] ?? p.label,
        value: p.value,
        itemStyle: { color: palette[i % palette.length], borderRadius: 4, borderWidth: 2, borderColor: cssVar('--color-white') },
      })),
      label: style.showValueLabels
        ? { show: true, formatter: '{b}\n{d}%', fontSize: t.fsBody, color: t.text, fontFamily: t.font }
        : { show: false },
      labelLine: { show: style.showValueLabels ?? false },
      emphasis: { itemStyle: { shadowBlur: 10, shadowColor: cssVar('--color-black-a20') } },
    }],
  }
}

/** Percentuale 0–100 su arco a 220°. */
export function buildGaugeOption(value: number | null, style: ChartStyle = {}) {
  const t = theme()
  const val = Math.min(100, Math.max(0, value ?? 0))
  const color = style.color ?? t.brand
  return {
    series: [{
      type: 'gauge', startAngle: 200, endAngle: -20,
      min: 0, max: 100, splitNumber: 5,
      axisLine: { lineStyle: { width: 18, color: [[val / 100, color], [1, t.border]] } },
      pointer: { show: false }, axisTick: { show: false }, splitLine: { show: false }, axisLabel: { show: false },
      detail: { fontSize: t.fsTitle, fontWeight: 600, color: t.textDark, fontFamily: t.font, formatter: `${Math.round(val)}%`, offsetCenter: [0, '20%'] },
      data: [{ value: val }],
    }],
  }
}
