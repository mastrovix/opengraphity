/**
 * IL FASCICOLO CHE ARRIVA SU GITHUB (21 set 2026).
 *
 * Quello che va pinnato qui non è «chiama fetch»: è che il prodotto NON
 * faccia finta di essere una persona, e che quando GitHub dice di no il
 * perché arrivi a chi deve sistemare il token.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../logger.js', () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
}))

const { configurazioneAutoanalisi, apriIssueDelFascicolo, chiediAnalisi, statoDellAnalisi, EVENTO_DISPATCH } =
  await import('../autoanalisiGitHub.js')
const { resetConfigCache } = await import('../config.js')

const CFG = { repo: 'mastrovix/opengraphity', token: 'ghp_finto' }

/** Una risposta di `fetch` finta, con il corpo che serve al caso. */
const risposta = (stato: number, corpo: unknown) => ({
  ok:         stato >= 200 && stato < 300,
  status:     stato,
  statusText: stato === 403 ? 'Forbidden' : 'OK',
  json:       async () => corpo,
  text:       async () => (typeof corpo === 'string' ? corpo : JSON.stringify(corpo)),
}) as unknown as Response

let chiamate: Array<{ url: string; init?: RequestInit }> = []
const finto = vi.fn()

beforeEach(() => {
  chiamate = []
  finto.mockReset()
  vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
    chiamate.push({ url, init })
    return finto(url, init)
  })
  resetConfigCache()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  resetConfigCache()
})

describe('configurazioneAutoanalisi', () => {
  it('senza repository o senza token è null, e null non è un errore', () => {
    vi.stubEnv('AUTOANALISI_GITHUB_REPO', '')
    vi.stubEnv('AUTOANALISI_GITHUB_TOKEN', '')
    resetConfigCache()
    expect(configurazioneAutoanalisi()).toBeNull()
  })

  it('una sola delle due non basta: metà configurazione è configurazione assente', () => {
    vi.stubEnv('AUTOANALISI_GITHUB_REPO', 'mastrovix/opengraphity')
    vi.stubEnv('AUTOANALISI_GITHUB_TOKEN', '')
    resetConfigCache()
    expect(configurazioneAutoanalisi()).toBeNull()
  })

  it('con entrambe restituisce le due cose e basta', () => {
    vi.stubEnv('AUTOANALISI_GITHUB_REPO', 'mastrovix/opengraphity')
    vi.stubEnv('AUTOANALISI_GITHUB_TOKEN', 'ghp_finto')
    resetConfigCache()
    expect(configurazioneAutoanalisi()).toEqual({ repo: 'mastrovix/opengraphity', token: 'ghp_finto' })
  })
})

describe('apriIssueDelFascicolo', () => {
  it('apre la issue col fascicolo e SENZA etichetta: il prodotto non finge di essere una persona', async () => {
    finto.mockResolvedValue(risposta(201, { number: 42 }))
    const n = await apriIssueDelFascicolo(CFG, {
      problemNumber: 'PRB00000003', titolo: 'metamodel-bus', fascicolo: '## Firme\n…',
    })
    expect(n).toBe(42)
    expect(chiamate[0]!.url).toBe('https://api.github.com/repos/mastrovix/opengraphity/issues')
    const body = JSON.parse(String(chiamate[0]!.init!.body))
    expect(body).toEqual({ title: 'Autoanalisi PRB00000003 — metamodel-bus', body: '## Firme\n…' })
    expect(body).not.toHaveProperty('labels')
  })

  it('quando GitHub dice di no, il CORPO della risposta finisce nel messaggio', async () => {
    finto.mockResolvedValue(risposta(403, { message: 'Resource not accessible by personal access token' }))
    await expect(apriIssueDelFascicolo(CFG, { problemNumber: 'PRB00000003', titolo: 't', fascicolo: 'f' }))
      .rejects.toThrow(/403 Forbidden — .*not accessible by personal access token/)
  })

  it('una issue creata senza numero è un errore, non un numero inventato', async () => {
    finto.mockResolvedValue(risposta(201, { url: 'https://…' }))
    await expect(apriIssueDelFascicolo(CFG, { problemNumber: 'PRB00000003', titolo: 't', fascicolo: 'f' }))
      .rejects.toThrow(/did not return its number/)
  })
})

describe('chiediAnalisi', () => {
  it('usa repository_dispatch, che dichiara «l\'ha chiesto il prodotto»', async () => {
    finto.mockResolvedValue(risposta(204, ''))
    await chiediAnalisi(CFG, { issue: 42, problemNumber: 'PRB00000003' })
    expect(chiamate[0]!.url).toBe('https://api.github.com/repos/mastrovix/opengraphity/dispatches')
    expect(JSON.parse(String(chiamate[0]!.init!.body))).toEqual({
      event_type: EVENTO_DISPATCH,
      client_payload: { issue: 42, problem: 'PRB00000003' },
    })
    expect(EVENTO_DISPATCH).toBe('autoanalisi')
  })

  it('un dispatch rifiutato non passa per buono', async () => {
    finto.mockResolvedValue(risposta(403, 'no'))
    await expect(chiediAnalisi(CFG, { issue: 42, problemNumber: 'PRB00000003' }))
      .rejects.toThrow(/the analysis of PRB00000003 was not requested/)
  })
})

describe('statoDellAnalisi', () => {
  /** Una cronologia in una pagina sola. */
  const timeline = (eventi: unknown[]) => () => Promise.resolve(risposta(200, eventi))
  const prUnita   = (n: number) => ({ event: 'cross-referenced', source: { issue: { number: n, pull_request: { merged_at: '2026-09-21T07:48:38Z' } } } })
  const prAperta  = (n: number) => ({ event: 'cross-referenced', source: { issue: { number: n, pull_request: { merged_at: null } } } })

  it('trova la PR collegata e dice se è stata UNITA, non solo chiusa', async () => {
    finto.mockImplementation(timeline([prUnita(26)]))
    expect(await statoDellAnalisi(CFG, 25)).toEqual({ pr: 26, prUnita: true })
  })

  it('una PR chiusa senza unire non è una soluzione', async () => {
    finto.mockImplementation(timeline([prAperta(26)]))
    expect(await statoDellAnalisi(CFG, 25)).toEqual({ pr: 26, prUnita: false })
  })

  it('UNA PR UNITA VINCE SU UN RIFERIMENTO SUCCESSIVO', async () => {
    /*
     * Il caso che la prima stesura sbagliava: prendeva l'ultimo evento, così
     * bastava un «vedi anche» da un'altra PR dopo quella buona e il giro non
     * si chiudeva più.
     */
    finto.mockImplementation(timeline([prUnita(26), prAperta(99)]))
    expect(await statoDellAnalisi(CFG, 25)).toEqual({ pr: 26, prUnita: true })
  })

  it('una issue soltanto CITATA da un\'altra issue non è una PR', async () => {
    finto.mockImplementation(timeline([
      { event: 'cross-referenced', source: { issue: { number: 99, pull_request: null } } },
      { event: 'labeled' },
    ]))
    expect(await statoDellAnalisi(CFG, 25)).toEqual({ pr: null, prUnita: null })
  })

  it('senza nessun evento collegato non c\'è nessuna PR: niente indovinato', async () => {
    finto.mockImplementation(timeline([]))
    expect(await statoDellAnalisi(CFG, 25)).toEqual({ pr: null, prUnita: null })
  })

  it('segue le PAGINE: la PR unita nella seconda pagina non si perde', async () => {
    const piena = Array.from({ length: 100 }, () => ({ event: 'labeled' }))
    finto.mockImplementationOnce(() => Promise.resolve(risposta(200, piena)))
    finto.mockImplementationOnce(() => Promise.resolve(risposta(200, [prUnita(26)])))
    expect(await statoDellAnalisi(CFG, 25)).toEqual({ pr: 26, prUnita: true })
    expect(chiamate.map((c) => /[?&]page=(\d+)/.exec(c.url)?.[1])).toEqual(['1', '2'])
  })

  it('una cronologia sterminata lo DICE, invece di rispondere «nessuna PR»', async () => {
    const piena = Array.from({ length: 100 }, () => ({ event: 'labeled' }))
    finto.mockImplementation(() => Promise.resolve(risposta(200, piena)))
    await expect(statoDellAnalisi(CFG, 25)).rejects.toThrow(/more than 300 timeline events/)
  })
})
