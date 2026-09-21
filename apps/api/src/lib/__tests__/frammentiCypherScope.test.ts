/**
 * I COMPOSITORI DI CYPHER NON DEVONO POTER TAGLIARE LO SCOPE IN SILENZIO
 * (20 set 2026).
 *
 * ## Il difetto da cui nasce
 * `assignTeamCypher` comincia con `WITH e, t`. Un `WITH` non elenca: TAGLIA.
 * Qualunque variabile letta prima del frammento moriva su quella riga, e la
 * query falliva solo a tempo di esecuzione — «Variable `previousTeamName` not
 * defined». Non l'ha visto nessun test, e nemmeno `check-cypher`: le query
 * COMPOSTE con `${…}` sono 368 e restano fuori dal suo perimetro, perché non
 * può mandare in EXPLAIN un testo che non conosce.
 *
 * ## Che cosa fa questo guardiano
 * Non prova a indovinare le query composte. Prende il problema dall'altro
 * capo — **il pezzo che si compone** — e lo chiama per davvero.
 *
 * Tre forme di `WITH` non tagliano lo scope di fuori, e sono riconosciute:
 * `WITH *` porta tutto; un `WITH` dentro un `CALL { … }` vive nella
 * sottoquery; e un compositore che è una query intera taglia per mestiere.
 *
 * ## La metà che lo rende un guardiano e non un test
 * L'ultimo `describe` legge i sorgenti: chi aggiunge un compositore nuovo
 * deve dichiararlo qui, o questo test diventa rosso. Senza quella metà
 * sarebbe solo una prova sui cinque che conoscevo il giorno che l'ho scritto.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const SENTINELLA = '__sentinella'

/**
 * Le quattro categorie non sono etichette: sono quattro affermazioni diverse,
 * e ognuna viene VERIFICATA chiamando la funzione.
 *
 *  - `carry`       porta dall'altra parte quello che gli si affida;
 *  - `frammento`   si infila in una query altrui e NON porta niente: il
 *                  motivo per cui va bene è scritto, e serve a chi lo compone
 *                  dopo aver letto qualcosa;
 *  - `query`       è una query intera, che va dritta a `runQuery`;
 *  - `nonTaglia`   non tocca lo scope di fuori: o è un'espressione, o usa
 *                  `WITH *` (che porta tutto), o i suoi `WITH` vivono dentro
 *                  un `CALL { … }`.
 */
type Categoria = 'carry' | 'frammento' | 'query' | 'nonTaglia'

interface Compositore {
  nome: string
  categoria: Categoria
  chiama: () => Promise<string>
  /** Solo per `frammento`: perché non portare niente va bene. */
  perche?: string
}

const COMPOSITORI: Compositore[] = [
  // ── Portano quello che gli si affida ────────────────────────────────────
  { nome: 'assignTeamCypher', categoria: 'carry',
    chiama: async () => (await import('../ticketTeamHistory.js')).assignTeamCypher('e', 't', { carry: [SENTINELLA] }) },
  { nome: 'eventRowColumns', categoria: 'carry',
    chiama: async () => (await import('../../graphql/resolvers/events.js')).eventRowColumns([SENTINELLA]) },
  { nome: 'ciMatchCypher', categoria: 'carry',
    chiama: async () => (await import('../../services/events/transitions.js')).ciMatchCypher({ carry: [SENTINELLA] }) },

  // ── Frammenti che non portano niente, col motivo ─────────────────────────
  { nome: 'serviceMapRowColumns', categoria: 'frammento',
    perche: 'apre le colonne di una riga di ServiceMap partendo da `m`: si compone subito dopo il MATCH, mai dopo una lettura che debba sopravvivere',
    chiama: async () => (await import('../../graphql/resolvers/services.js')).serviceMapRowColumns() },
  { nome: 'changeWindowSubqueryCypher', categoria: 'frammento',
    perche: 'è una sottoquery chiusa che parte da `c` e torna `dist`: non sta in mezzo a un cammino di variabili altrui',
    chiama: async () => (await import('../../services/events/suppression.js')).changeWindowSubqueryCypher(1, 'DEPENDS_ON') },

  // ── Query intere: vanno dritte a runQuery ────────────────────────────────
  { nome: 'deployPlanUnitsCypher', categoria: 'query',
    chiama: async () => (await import('../olaChangeUnits.js')).deployPlanUnitsCypher('team') },
  { nome: 'olaOpenTicketsCypher', categoria: 'query',
    chiama: async () => (await import('../olaSweep.js')).olaOpenTicketsCypher('incident') },
  { nome: 'ingestMergeCypher', categoria: 'query',
    chiama: async () => (await import('../../services/events/transitions.js')).ingestMergeCypher() },
  { nome: 'loadServiceMapCypher', categoria: 'query',
    chiama: async () => (await import('../../services/serviceImpact/engine.js')).loadServiceMapCypher(1, 'DEPENDS_ON') },
  { nome: 'evaluationWriteCypher', categoria: 'query',
    chiama: async () => (await import('../../services/serviceImpact/engine.js')).evaluationWriteCypher() },

  // ── Non emettono nessun WITH che tagli ───────────────────────────────────
  { nome: 'firstTeamCypher', categoria: 'nonTaglia',
    chiama: async () => (await import('../ticketTeamHistory.js')).firstTeamCypher('e', 't', '$now') },
  { nome: 'ciHealthCaseCypher', categoria: 'nonTaglia',
    chiama: async () => (await import('../../services/events/ciHealth.js')).ciHealthCaseCypher('sevs', 'flap') },
  { nome: 'createCICypher', categoria: 'nonTaglia',
    chiama: async () => (await import('../../discovery/reconciliationEngine.js')).createCICypher('Server') },
  { nome: 'entityExistsCypher', categoria: 'nonTaglia',
    chiama: async () => (await import('../attachmentValidation.js')).entityExistsCypher(['Incident']) },
  { nome: 'kbArticlePublishedCypher', categoria: 'nonTaglia',
    chiama: async () => (await import('../kbPublished.js')).kbArticlePublishedCypher('a') },
  { nome: 'olaConcludedTicketsCypher', categoria: 'nonTaglia',
    chiama: async () => (await import('../olaAttainment.js')).olaConcludedTicketsCypher('incident') },
  { nome: 'olaTicketFactsCypher', categoria: 'nonTaglia',
    chiama: async () => (await import('../olaAttainment.js')).olaTicketFactsCypher('incident') },
  { nome: 'assessmentUnitsCypher', categoria: 'nonTaglia',
    chiama: async () => (await import('../olaChangeUnits.js')).assessmentUnitsCypher('team') },
  { nome: 'labelTranslationsCypher', categoria: 'nonTaglia',
    chiama: async () => (await import('../workflowLabelTranslations.js')).labelTranslationsCypher('s', '$new') },
  { nome: 'transitionCaseCypher', categoria: 'nonTaglia',
    chiama: async () => (await import('../../services/events/transitions.js')).transitionCaseCypher(() => "'x'") },
  { nome: 'residueClearCypher', categoria: 'nonTaglia',
    chiama: async () => (await import('../../services/events/transitions.js')).residueClearCypher('f', []) },
  { nome: 'transitionSetCypher', categoria: 'nonTaglia',
    chiama: async () => (await import('../../services/events/transitions.js')).transitionSetCypher() },
  { nome: 'evaluationHoldWriteCypher', categoria: 'nonTaglia',
    chiama: async () => (await import('../../services/serviceImpact/engine.js')).evaluationHoldWriteCypher() },
  /*
   * I due registri della storia usano `WITH *`, che porta TUTTO: non tagliano
   * niente. Il loro `imports` non serve a far sopravvivere lo scope di fuori
   * — serve a dire che cosa può vedere la sottoquery `CALL { … }` che potano
   * le voci vecchie, e quello è un altro problema. Li avevo classificati
   * `carry` a occhio, e il guardiano ha detto di no: hanno zero `WITH` che
   * tagliano. È la ragione per cui le categorie si verificano invece di
   * dichiararle.
   */
  { nome: 'historyWriteCypher', categoria: 'nonTaglia',
    chiama: async () => (await import('../../services/events/history.js')).historyWriteCypher({ imports: [SENTINELLA] }) },
  { nome: 'serviceHistoryWriteCypher', categoria: 'nonTaglia',
    chiama: async () => (await import('../../services/serviceImpact/history.js')).serviceHistoryWriteCypher({ imports: [SENTINELLA] }) },
]

/**
 * I `WITH` di un pezzo di Cypher, e se stanno dentro una sottoquery.
 *
 * Una PILA di graffe, non un contatore di `CALL {`: la prima versione contava
 * `CALL {` in apertura e OGNI `}` in chiusura, e cadeva sulla prima mappa di
 * proprietà — `CREATE (:X {id: …})` chiude una graffa che nessuno aveva
 * aperto, la profondità andava sotto zero e da lì in poi un `WITH` dentro una
 * sottoquery sembrava di fuori. Trovato facendo girare il guardiano su
 * `historyWriteCypher`, che ha tutt'e due le cose nello stesso pezzo.
 */
export function withDelFrammento(cypher: string): { riga: string; dentroSottoquery: boolean }[] {
  const out: { riga: string; dentroSottoquery: boolean }[] = []
  const pila: boolean[] = []
  for (const grezza of cypher.split('\n')) {
    const riga = grezza.trim()
    if (/^WITH\b/i.test(riga)) out.push({ riga, dentroSottoquery: pila.includes(true) })
    for (let i = 0; i < riga.length; i++) {
      if (riga[i] === '{') pila.push(/\bCALL$/i.test(riga.slice(0, i).trimEnd()))
      else if (riga[i] === '}') pila.pop()
    }
  }
  return out
}

/** I `WITH` che tagliano lo scope di FUORI: non quelli di una sottoquery, non `WITH *`. */
function tagliano(cypher: string) {
  return withDelFrammento(cypher).filter((w) => !w.dentroSottoquery && !/^WITH\s+\*/i.test(w.riga))
}

const per = (c: Categoria) => COMPOSITORI.filter((x) => x.categoria === c).map((x) => [x.nome, x] as const)

describe('un frammento porta dall\'altra parte quello che gli si affida', () => {
  it.each(per('carry'))('%s', async (_nome, f) => {
    const withs = tagliano(await f.chiama())
    expect(withs.length, 'un compositore «carry» deve avere almeno un WITH che taglia').toBeGreaterThan(0)
    const perdono = withs.filter((w) => !w.riga.includes(SENTINELLA))
    expect(perdono.map((w) => w.riga), 'questi WITH perdono quello che era stato letto prima').toEqual([])
  })
})

describe('le altre tre categorie sono VERIFICATE, non dichiarate', () => {
  it.each(per('nonTaglia'))('%s non tocca lo scope di fuori', async (_nome, f) => {
    expect(tagliano(await f.chiama()).map((w) => w.riga)).toEqual([])
  })

  it.each(per('query'))('%s è una query intera, non un pezzo da infilare in mezzo', async (_nome, f) => {
    // Tagliare lo scope è il mestiere di una query. Quello che va verificato
    // è che sia davvero una query, altrimenti la categoria è un alibi.
    expect((await f.chiama()).trim()).toMatch(/^(MATCH|OPTIONAL MATCH|MERGE|CREATE|UNWIND|CALL)\b/i)
  })

  it.each(per('frammento'))('%s porta scritto PERCHÉ non porta niente', (_nome, f) => {
    expect((f.perche ?? '').length, `${f.nome}: il motivo va scritto, serve a chi lo compone`).toBeGreaterThan(40)
  })
})

describe('il lettore dei WITH', () => {
  it('riconosce un WITH dentro una sottoquery', () => {
    const letti = withDelFrammento(['WITH a', 'CALL {', '  WITH b', '}', 'WITH c'].join('\n'))
    expect(letti.map((w) => [w.riga, w.dentroSottoquery])).toEqual([
      ['WITH a', false], ['WITH b', true], ['WITH c', false],
    ])
  })

  it('una MAPPA DI PROPRIETÀ non viene scambiata per una sottoquery', () => {
    const letti = withDelFrammento([
      'CREATE (:X {id: $a, name: $b})', 'WITH a', 'CALL {', '  WITH b', '}', 'WITH c',
    ].join('\n'))
    expect(letti.map((w) => [w.riga, w.dentroSottoquery])).toEqual([
      ['WITH a', false], ['WITH b', true], ['WITH c', false],
    ])
  })
})

function sorgenti(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) { if (e.name !== '__tests__') sorgenti(p, out); continue }
    if (e.name.endsWith('.ts') && !e.name.endsWith('.test.ts')) out.push(p)
  }
  return out
}

describe('ogni compositore di Cypher è dichiarato qui', () => {
  it('nessuno nuovo può entrare senza dire se taglia lo scope', () => {
    const dichiarati = new Set(COMPOSITORI.map((f) => f.nome))
    const trovati: string[] = []
    for (const file of sorgenti(SRC)) {
      for (const m of fs.readFileSync(file, 'utf8').matchAll(/export function ([A-Za-z0-9_]*(?:Cypher|Columns))\s*\(/g)) {
        const nome = m[1]!
        // `assert*` non compone Cypher: lo controlla (lib/cypherGuard.ts).
        if (nome.startsWith('assert') || dichiarati.has(nome)) continue
        trovati.push(`${path.relative(SRC, file)}: ${nome}`)
      }
    }
    expect(trovati,
      'questi compongono Cypher e non sono dichiarati: aggiungili a COMPOSITORI con la loro categoria',
    ).toEqual([])
  })

  it('e nessuno è dichiarato due volte', () => {
    const nomi = COMPOSITORI.map((f) => f.nome)
    expect(nomi).toHaveLength(new Set(nomi).size)
  })
})
