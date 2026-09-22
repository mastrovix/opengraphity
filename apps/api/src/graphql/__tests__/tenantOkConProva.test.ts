/**
 * OGNI ECCEZIONE ALLO SCOPING PORTA UNA PROVA, NON UNA FRASE (22 set 2026).
 *
 * ## Da dove nasce
 * `tenantScoping.test.ts` pretende il `tenant_id` su ogni query e lascia
 * passare quelle marcate `// tenant-ok: …`. Erano SETTANTASETTE, e ognuna era
 * giustificata da una frase in italiano: «gli id vengono dalla selezione qui
 * sopra», «i passi sono quelli della definizione già scopata». Frasi vere
 * quando sono state scritte, e che nessuno rilegge quando la query cambia.
 *
 * Il repository questa lezione l'ha già imparata altrove: `changeWindowGate`
 * pretende che ogni esenzione porti un PREDICATO, «se la ragione smette di
 * essere vera, il test cade», perché un elenco giustificato a parole conteneva
 * un'affermazione che il codice smentiva. Per l'isolamento fra clienti —
 * l'invariante più importante del prodotto — erano rimaste parole.
 *
 * ## Come funziona adesso
 * Il marcatore dichiara un GENERE: `// tenant-ok(<genere>): perché`. I generi
 * sono un insieme chiuso, e ognuno ha qui sotto un predicato che si esegue sul
 * testo della query e del file. Un'eccezione che non combacia più con la forma
 * che dichiara diventa rossa, col suo file e la sua riga.
 *
 * Questo NON dimostra l'isolamento: dimostra che la ragione scritta è ancora
 * quella del codice. È la differenza fra «qualcuno ci aveva pensato» e
 * «qualcosa se ne accorge».
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const RADICI = [join(process.cwd(), 'src'), join(process.cwd(), '../../packages')]

/*
 * LA QUERY INTERA, non una finestra di righe.
 *
 * La prima stesura guardava le 16 righe DOPO il marcatore, e sbagliava: il
 * marcatore sta quasi sempre in mezzo a una query, e la `MATCH` che porta il
 * `tenant_id` è più SOPRA. Risultato, tredici eccezioni corrette dichiarate
 * cadute. Ora si prende il template literal che contiene il marcatore —
 * cioè la query per intero, com'è scritta.
 */
/** Il primo backtick NON scappato a partire da `da`. */
function backtickDopo(testo: string, da: number): number {
  for (let k = Math.max(0, da); k < testo.length; k++) {
    if (testo[k] === '`' && testo[k - 1] !== '\\') return k
  }
  return -1
}

/** L'ultimo backtick NON scappato prima di `fino`. */
function backtickPrima(testo: string, fino: number): number {
  for (let k = Math.min(fino, testo.length - 1); k >= 0; k--) {
    if (testo[k] === '`' && testo[k - 1] !== '\\') return k
  }
  return -1
}

function queryIntorno(testo: string, posizione: number): string {
  /*
   * DENTRO O FUORI DALLA QUERY: si decide contando i backtick.
   *
   * Il marcatore sta a volte DENTRO il template (in mezzo alla query) e a
   * volte sulla riga PRIMA che si apra. Le due euristiche ingenue — guarda
   * indietro, guarda avanti — sbagliano l'una il caso dell'altra, e
   * sbagliando prendono la query accanto: si finirebbe per giudicare
   * un'eccezione sul testo di un'altra.
   *
   * E i backtick SCAPPATI non contano, né per la parità né per i confini:
   * nei commenti di questo repository si citano le variabili fra apici
   * inversi, e prenderli sul serio troncava la query al primo commento.
   */
  const backtickVeri = testo.slice(0, posizione).match(/(?<!\\)`/g) ?? []
  const dentro = backtickVeri.length % 2 === 1
  const apre = dentro ? backtickPrima(testo, posizione) : backtickDopo(testo, posizione)
  if (apre === -1 || (!dentro && apre - posizione > 400)) return testo.slice(posizione, posizione + 900)
  const chiude = backtickDopo(testo, dentro ? posizione : apre + 1)
  const span = testo.slice(apre + 1, chiude === -1 ? apre + 900 : chiude)
  /*
   * Non tutte le query stanno fra backtick: ce n'è qualcuna fra apici
   * semplici, su una riga sola. Se quello che abbiamo preso non SEMBRA una
   * query, il template più vicino è di qualcun altro: meglio le righe subito
   * dopo il marcatore che il testo sbagliato.
   */
  return /\b(MATCH|MERGE|CREATE|DETACH|RETURN)\b/.test(span) ? span : testo.slice(posizione, posizione + 900)
}

interface Sito { file: string; riga: number; genere: string; motivo: string; query: string; sorgente: string }

interface Genere {
  /** Che cosa dichiara chi usa questo genere. */
  dichiara: string
  /** La prova. Falsa ⇒ l'eccezione non vale più. */
  prova: (s: Sito) => boolean
}

/**
 * I file dove il tenant NON È ANCORA NOTO quando si interroga: è proprio ciò
 * che si sta cercando. Un elenco chiuso, perché è l'unico genere in cui la
 * query non può essere scopata nemmeno in teoria.
 */
const PRE_AUTH = ['apiKeyAuth.ts', 'resolveAuth.ts', 'platformAuth.ts', 'webhooks-inbound.ts', 'slackInstallation.ts']

/**
 * I moduli che guardano DI MESTIERE tutti i clienti: metriche di processo,
 * passate di manutenzione, retention, tetti di spesa di piattaforma. Chiuso
 * anche questo: un resolver non ci finisce per sbaglio.
 */
const PIATTAFORMA = [
  'gauges.ts', 'passes.ts', 'serverLogRetention.ts', 'aiBudget.ts', 'formDraftPurge.ts',
  'engine.ts', 'anomalyEngine.ts', 'proposalScanner.ts', 'metrics.ts', 'platformAnalyst.ts',
  'tenantOnboarding.ts', 'maintenance.worker.ts', 'seed-common.ts', 'autoanalisiWorker.ts',
  'reportScheduler.ts', 'olaSweep.ts', 'problemDossier.ts', 'stepDeadlines.ts',
  'tenantLifecycle.ts', 'eventRetention.ts', 'storm.ts', 'sync.ts',
]

const GENERI: Record<string, Genere> = {
  'pre-auth': {
    dichiara: 'il tenant non è ancora noto: è quello che si sta cercando',
    prova: (s) => PRE_AUTH.some((n) => s.file.endsWith(n)),
  },
  piattaforma: {
    dichiara: 'guarda di mestiere tutti i clienti (metrica, manutenzione, retention)',
    prova: (s) => PIATTAFORMA.some((n) => s.file.endsWith(n)),
  },
  unicita: {
    dichiara: 'controlla proprio GLI ALTRI tenant, per imporre un\'unicità globale',
    prova: (s) => /tenant_id\s*<>|tenant_id\s+IN\s*\[/.test(s.query),
  },
  condivisi: {
    dichiara: 'tocca righe CONDIVISE (base / system), che non sono di nessun cliente',
    /*
     * Lo scope può essere un LETTERALE nella query, oppure un parametro: in
     * quel caso la prova è che il file leghi quel parametro a scope condivisi
     * e a nient'altro. Senza la seconda metà, `tenantOnboarding` — che cicla
     * su `['base', 'itil']` e passa `$scope` — risultava caduta pur essendo
     * corretta; con un `scope = $qualcosa` accettato alla cieca, invece,
     * basterebbe un parametro per aggirare la regola.
     */
    prova: (s) =>
      /scope\s*(=|IN)\s*\[?\s*'(base|itil|system)'|scope:\s*'base'|'system'|__base__/.test(s.query)
      || (/scope\s*=\s*\$\w+/.test(s.query) && /'base'/.test(s.sorgente) && /'itil'|'system'/.test(s.sorgente)),
  },
  traversal: {
    dichiara: 'ci si arriva CAMMINANDO da un nodo scopato nella stessa query',
    prova: (s) => /tenant_id/.test(s.query),
  },
  'where-scopato': {
    dichiara: 'il WHERE interpolato comincia dal tenant',
    prova: (s) => /tenant_id\s*=\s*\$tenantId/.test(s.sorgente),
  },
  'per-id': {
    dichiara: 'si aggancia a un id che viene da una lettura già scopata',
    prova: (s) => /\{\s*\w*[Ii]d:\s*\$\w+|IN\s+\$\w*[Ii]ds|id:\s*\w+\b/.test(s.query),
  },
  'verificato-prima': {
    dichiara: 'una funzione di controllo ha già imposto l\'ambito',
    prova: (s) => {
      const chiamata = /\b(assert\w+)/.exec(s.motivo)?.[1]
      return chiamata !== undefined && new RegExp(`${chiamata}\\s*\\(`).test(s.sorgente)
    },
  },
}

function sorgenti(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n)
    if (statSync(p).isDirectory()) {
      if (['node_modules', 'dist', '__tests__'].includes(n)) continue
      sorgenti(p, out)
    } else if (n.endsWith('.ts') && !n.includes('.test.')) out.push(p)
  }
  return out
}

const siti: Sito[] = []
const senzaGenere: string[] = []
for (const radice of RADICI) {
  for (const f of sorgenti(radice)) {
    const testo = readFileSync(f, 'utf8')
    if (!testo.includes('tenant-ok')) continue
    const righe = testo.split('\n')
    righe.forEach((r, i) => {
      if (!r.includes('tenant-ok')) return
      // L'apice inverso di chiusura è ammesso: in questo repository il
      // marcatore si scrive anche come `tenant-ok(genere)` dentro una frase.
      const m = /tenant-ok\(([a-z-]+)\)`?:\s*(.*)$/.exec(r)
      const dove = `${relative(process.cwd(), f)}:${i + 1}`
      if (!m) { senzaGenere.push(`${dove}  ${r.trim().slice(0, 80)}`); return }
      const posizione = righe.slice(0, i).join('\n').length
      siti.push({
        file: relative(process.cwd(), f), riga: i + 1, genere: m[1]!, motivo: m[2]!,
        query: queryIntorno(testo, posizione), sorgente: testo,
      })
    })
  }
}

describe('le eccezioni allo scoping per tenant portano una prova', () => {
  it('ce ne sono, e il test le vede tutte', () => {
    expect(siti.length, 'nessuna eccezione trovata: il test non guarda più niente').toBeGreaterThan(60)
  })

  it('ognuna DICHIARA un genere, e il genere è dell\'insieme chiuso', () => {
    expect(senzaGenere,
      'Queste eccezioni non dichiarano un genere. La forma è `// tenant-ok(<genere>): perché`, '
      + `e i generi sono: ${Object.keys(GENERI).join(', ')}.`,
    ).toEqual([])

    const sconosciuti = siti.filter((s) => !(s.genere in GENERI))
      .map((s) => `${s.file}:${s.riga} → "${s.genere}"`)
    expect(sconosciuti,
      `Genere non riconosciuto. Quelli ammessi: ${Object.keys(GENERI).map((k) => `${k} (${GENERI[k]!.dichiara})`).join('; ')}.`,
    ).toEqual([])
  })

  it('e la PROVA del genere che dichiara regge ancora', () => {
    const cadute: string[] = []
    for (const s of siti) {
      const g = GENERI[s.genere]
      if (!g) continue
      if (!g.prova(s)) cadute.push(`${s.file}:${s.riga} — dichiara «${s.genere}» (${g.dichiara}) ma la query non ne ha più la forma. Motivo scritto: ${s.motivo.slice(0, 70)}`)
    }
    expect(cadute,
      'La ragione per cui queste query possono NON portare il tenant non è più vera nel codice. '
      + 'O si rimette lo scoping, o si cambia il genere a quello giusto — ma non si lascia una frase che il codice smentisce.',
    ).toEqual([])
  })

  it('i due elenchi chiusi restano piccoli: se crescono, qualcuno ci si sta infilando', () => {
    expect(PRE_AUTH.length).toBeLessThanOrEqual(6)
    expect(PIATTAFORMA.length).toBeLessThanOrEqual(24)
  })
})
