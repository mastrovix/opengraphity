/**
 * IL RUNNER DEGLI SCRIPT (22 set 2026).
 *
 * ## Perché non c'erano
 * `runner.ts` stava a ZERO: diciotto istruzioni, nessuna toccata. È il file
 * che decide se uno script del cliente viene eseguito — e le tre porte che
 * mette prima della sandbox (la validazione statica, l'interruttore, e il
 * contesto arricchito) non le verificava niente.
 *
 * ## E la nota di codice morto si verifica anche lei
 * Il file dichiara che `runScriptsForTrigger` e l'innesco `ScriptTrigger`
 * NON hanno chiamanti: «un amministratore che scrivesse uno script su
 * `incident.updated` non vedrebbe mai eseguirlo». Non si cancella — il tipo è
 * nell'interfaccia pubblica e i dati potrebbero portare `trigger` — ma allora
 * la funzione deve almeno FUNZIONARE, perché il giorno in cui qualcuno le
 * scrive il chiamante non deve trovare una sorpresa. Qui si verifica che
 * filtri per tenant, per innesco e per interruttore, e che un fallimento non
 * fermi gli altri.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const run = vi.fn()
vi.mock('../sandbox.js', () => ({
  Sandbox: vi.fn(function Sandbox(this: Record<string, unknown>, opts: unknown) {
    this['opts'] = opts
    this['run'] = run
  }),
}))

const validateScript = vi.fn()
vi.mock('../validate.js', () => ({ validateScript: (...a: unknown[]) => validateScript(...a) }))

const { runScript, runScriptsForTrigger } = await import('../runner.js')
const { Sandbox } = await import('../sandbox.js')

const script = (over: Record<string, unknown> = {}) => ({
  id: 's1', tenant_id: 't1', name: 'Chiudi i duplicati', trigger: 'manual' as const,
  code: 'return 1', enabled: true, created_at: 'ieri', updated_at: 'ieri', ...over,
})

const ESITO = { success: true, logs: [], output: 1, duration_ms: 3 }

beforeEach(() => {
  vi.clearAllMocks()
  validateScript.mockReturnValue({ valid: true, errors: [] })
  run.mockResolvedValue(ESITO)
  vi.spyOn(console, 'log').mockImplementation(() => undefined)
})

// ══════════════════════════════════════════════════════════════════════════════
describe('runScript — le tre porte prima della sandbox', () => {
  it('uno script che non passa la validazione non arriva alla sandbox, e il motivo esce', async () => {
    validateScript.mockReturnValue({ valid: false, errors: ['eval vietato', 'require vietato'] })
    const out = await runScript(script(), {})
    expect(out).toMatchObject({ success: false, duration_ms: 0 })
    expect(out.error).toContain('eval vietato; require vietato')
    expect(Sandbox).not.toHaveBeenCalled()
  })

  it('`skipValidation` la salta davvero — è l\'unico modo per eseguire codice non validato', async () => {
    validateScript.mockReturnValue({ valid: false, errors: ['x'] })
    await runScript(script(), {}, { skipValidation: true })
    expect(validateScript).not.toHaveBeenCalled()
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('uno script SPENTO non si esegue, e lo dice col suo nome', async () => {
    const out = await runScript(script({ enabled: false }), {})
    expect(out.error).toBe('Script "Chiudi i duplicati" is disabled')
    expect(Sandbox).not.toHaveBeenCalled()
  })

  it('l\'interruttore si guarda DOPO la validazione: un codice rotto lo è comunque', async () => {
    validateScript.mockReturnValue({ valid: false, errors: ['sintassi'] })
    expect((await runScript(script({ enabled: false }), {})).error).toContain('validation failed')
  })
})

describe('runScript — quello che arriva alla sandbox', () => {
  it('i limiti dello script scavalcano quelli di fabbrica', async () => {
    await runScript(script({ memory_limit_mb: 32, timeout_ms: 9000 }), {})
    expect(Sandbox).toHaveBeenCalledWith({ memoryLimitMb: 32, timeoutMs: 9000 })
  })

  it('senza limiti propri si lascia decidere alla sandbox, non si inventa un numero', async () => {
    await runScript(script(), {})
    expect(Sandbox).toHaveBeenCalledWith({ memoryLimitMb: undefined, timeoutMs: undefined })
  })

  it('il contesto arriva con `_script` accanto: chi scrive lo script sa dove sta girando', async () => {
    await runScript(script(), { incident: { id: 'i1' } })
    const [codice, contesto] = run.mock.calls[0] as [string, Record<string, unknown>]
    expect(codice).toBe('return 1')
    expect(contesto['incident']).toEqual({ id: 'i1' })
    expect(contesto['_script']).toEqual({ id: 's1', name: 'Chiudi i duplicati', trigger: 'manual' })
  })

  it('e `_script` non può essere falsificato dal contesto di chi chiama', async () => {
    await runScript(script(), { _script: { id: 'un-altro' } })
    const contesto = run.mock.calls[0]![1] as Record<string, unknown>
    expect(contesto['_script']).toMatchObject({ id: 's1' })
  })

  it('l\'esito della sandbox esce com\'è: il runner non lo reinterpreta', async () => {
    run.mockResolvedValue({ success: false, logs: ['riga'], error: 'timeout', duration_ms: 5000 })
    expect(await runScript(script(), {})).toEqual({ success: false, logs: ['riga'], error: 'timeout', duration_ms: 5000 })
  })
})

describe('runScriptsForTrigger — senza chiamanti, ma deve funzionare lo stesso', () => {
  const tre = [
    script({ id: 'a', trigger: 'incident.created' }),
    script({ id: 'b', trigger: 'incident.updated' }),
    script({ id: 'c', trigger: 'incident.created', enabled: false }),
  ]

  it('filtra per innesco, per interruttore e per TENANT', async () => {
    const conAltroTenant = [...tre, script({ id: 'd', trigger: 'incident.created', tenant_id: 't9' })]
    const out = await runScriptsForTrigger(conAltroTenant, 'incident.created', 't1', {})
    expect([...out.keys()]).toEqual(['a'])
  })

  it('nessuno che corrisponde: mappa vuota, non un errore', async () => {
    const out = await runScriptsForTrigger(tre, 'change.approved', 't1', {})
    expect(out.size).toBe(0)
    expect(run).not.toHaveBeenCalled()
  })

  it('un fallimento NON ferma gli altri: ognuno ha il suo esito', async () => {
    const due = [script({ id: 'a' }), script({ id: 'b' })]
    run.mockResolvedValueOnce({ success: false, logs: [], error: 'crash', duration_ms: 1 })
    run.mockResolvedValueOnce(ESITO)
    const out = await runScriptsForTrigger(due, 'manual', 't1', {})
    expect(out.get('a')).toMatchObject({ success: false, error: 'crash' })
    expect(out.get('b')).toMatchObject({ success: true })
  })

  it('e passano tutti dalla validazione: qui non c\'è nessuno `skipValidation`', async () => {
    validateScript.mockReturnValue({ valid: false, errors: ['vietato'] })
    const out = await runScriptsForTrigger([script()], 'manual', 't1', {})
    expect(out.get('s1')).toMatchObject({ success: false })
    expect(run).not.toHaveBeenCalled()
  })
})
