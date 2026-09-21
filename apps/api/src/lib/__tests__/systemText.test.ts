import { describe, it, expect, vi } from 'vitest'

vi.mock('../tenantLanguage.js', () => ({ languageFor: vi.fn(async () => 'it'), languageForUser: vi.fn(async () => 'it') }))

const { SYSTEM_TEXTS, systemTextIn, systemText, formatInstantIn, LINGUE, reportSectionErrorIn } = await import('../systemText.js')

describe('systemText: i testi che il prodotto scrive nei ticket', () => {
  it('ogni chiave ha ogni lingua, e gli stessi parametri in ogni lingua', () => {
    for (const [key, byLang] of Object.entries(SYSTEM_TEXTS)) {
      const params = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort()
      for (const l of LINGUE) {
        expect((byLang as Record<string, string>)[l], `${key}.${l}`).toBeTruthy()
        expect(params((byLang as Record<string, string>)[l]!), `${key}.${l}`).toEqual(params(byLang.en))
      }
    }
  })

  it('risolve nella lingua del cliente e sostituisce i parametri', async () => {
    expect(systemTextIn('en', 'incident.reassignedTeam', { team: 'Service Desk' })).toBe('Reassigned to team Service Desk')
    expect(await systemText('t1', 'incident.reassignedTeam', { team: 'Service Desk' })).toBe('Riassegnato al team Service Desk')
  })

  it('un parametro mancante è un errore', () => {
    expect(() => systemTextIn('en', 'incident.reassignedTeam')).toThrow(/missing parameter "team"/)
  })

  it('le date nella lingua e nel fuso del cliente, non ISO', () => {
    // Giro del 14 set 2026 (#51): «Sep 14, 2026, 1:07 AM» era la convenzione americana.
    expect(formatInstantIn('en', '2026-09-13T11:30:11.938Z', 'Europe/Rome')).toMatch(/^13 Sept? 2026, 13:30$/)
    expect(formatInstantIn('it', '2026-09-13T11:30:11.938Z', 'Europe/Rome')).toBe('13 set 2026, 13:30')
  })

  /**
   * LA STESSA FRASE IN DUE POSTI DIVERGE (20 set 2026).
   *
   * L'errore di una sezione di report si legge in TRE cammini: l'anteprima e
   * la pagina del report lo prendono dal browser (`errors.report.*`), il PDF
   * e il foglio dal server (`report.error.*`), perché un documento lo compone
   * l'API. Sono due copie della stessa frase, e due copie divergono: è già
   * successo oggi con l'elenco dei campi data, scritto a mano in due file che
   * non dicevano la stessa cosa.
   *
   * Questo test non permette la divergenza: chi cambia la frase in un posto
   * la cambia in tutti e due, o il test cade e dice quale.
   */
  it('gli errori di sezione dicono la STESSA cosa nel documento e nel browser', async () => {
    const leggi = async (f: string): Promise<Record<string, string>> => {
      const { readFileSync } = await import('node:fs')
      const { join, dirname } = await import('node:path')
      const { fileURLToPath } = await import('node:url')
      const qui = dirname(fileURLToPath(import.meta.url))
      const j = JSON.parse(readFileSync(join(qui, '../../../../../apps/web/src/i18n/locales/' + f), 'utf8')) as {
        errors: { report: Record<string, string> }
      }
      return j.errors.report
    }
    const web = { en: await leggi('en.json'), it: await leggi('it.json') }

    const nostre = Object.keys(SYSTEM_TEXTS).filter((k) => k.startsWith('report.error.'))
    expect(nostre.length, 'nessuna frase di errore di sezione: il test non sta guardando niente').toBeGreaterThan(0)

    for (const chiave of nostre) {
      const nome = chiave.slice('report.error.'.length)
      for (const l of ['en', 'it'] as const) {
        expect(web[l][nome], `errors.report.${nome} manca nel web (${l})`).toBeTruthy()
        expect(systemTextIn(l, chiave as never), `${chiave} (${l})`).toBe(web[l][nome])
      }
    }
  })

  it('una chiave che non conosciamo non si inventa: resta il messaggio tecnico', () => {
    expect(reportSectionErrorIn('it', 'errors.report.granularityNeedsDate'))
      .toBe('Per raggruppare per periodo serve un campo data, e quello scelto non lo è. Scegli un campo data, oppure togli il periodo.')
    expect(reportSectionErrorIn('it', 'errors.report.chiaveCheNonEsiste')).toBeNull()
    expect(reportSectionErrorIn('it', 'errors.qualcosAltro')).toBeNull()
    expect(reportSectionErrorIn('it', null)).toBeNull()
  })
})
