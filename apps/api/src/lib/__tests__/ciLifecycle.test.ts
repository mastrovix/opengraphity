/**
 * lib/ciLifecycle.ts — la SEMANTICA del ciclo di vita del CI come dato del
 * cliente (ondata 7 · C-4 / A-14).
 *
 * Cosa pinna questo test:
 *  - la semantica viene dalla POLICY del tenant, non da costanti nel codice;
 *  - `isRetiredLifecycle` / `isMaintenanceLifecycle` rispondono su un
 *    vocabolario RINOMINATO — è il caso silenzioso che l'ondata chiude (prima
 *    un CI «dismesso» tornava a pesare nel calcolo della salute dei servizi e
 *    i suoi allarmi tornavano ad aprire incident);
 *  - i sei valori factory si comportano esattamente come prima;
 *  - `lifecyclePolicyReferences` è ciò che rende sicuro tenere la semantica in
 *    due liste sulla policy: dice se un valore che si sta togliendo dal
 *    Dizionario è citato dalla semantica.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GraphQLError } from 'graphql'
import { DEFAULT_EVENT_POLICY } from '../eventPolicy.js'
import { CI_LIFECYCLE_STATUSES } from '../eventVocabularies.js'

const getEventPolicy = vi.fn()
vi.mock('../../services/events/policy.js', () => ({ getEventPolicy: (t: string) => getEventPolicy(t) }))
/** Il vocabolario del cliente, pilotabile dai test (`vocabulary([...])`). */
let tenantVocabulary: string[] = ['active', 'dismesso']
function vocabulary(values: string[]): void { tenantVocabulary = values }

/** Il default DICHIARATO sul vocabolario del cliente (revisione · C·N-2). */
let tenantDefault: string | null = null
function declaredDefault(value: string | null): void { tenantDefault = value }

vi.mock('../domainMatrix.js', () => ({
  domainVocabularyDefault: () => Promise.resolve(tenantDefault),
  assertDomainValue: (_t: string, vocabulary_: string, value: unknown) =>
    (typeof value === 'string' && tenantVocabulary.includes(value)
      ? Promise.resolve(value)
      : Promise.reject(new GraphQLError(`${vocabulary_}: "${String(value)}" is not in the dictionary of this tenant. Allowed: ${tenantVocabulary.join(', ')}.`, { extensions: { code: 'BAD_USER_INPUT' } }))),
  domainVocabulary: () => Promise.resolve(tenantVocabulary),
}))

const {
  CI_STATUS_VOCABULARY, resolveCILifecycleSemantics, isRetiredLifecycle, isMaintenanceLifecycle,
  lifecycleVocabulary, assertTenantLifecycleStatuses, lifecyclePolicyReferences, initialCIStatus,
} = await import('../ciLifecycle.js')

beforeEach(() => { vi.clearAllMocks(); vocabulary(['active', 'dismesso']); declaredDefault(null) })

describe('il nome del vocabolario è tutto ciò che il codice conosce', () => {
  it('CI_STATUS_VOCABULARY è il nome, non i valori', () => {
    expect(CI_STATUS_VOCABULARY).toBe('ci_status')
  })
  it('lifecycleVocabulary legge i valori DEL CLIENTE', async () => {
    await expect(lifecycleVocabulary('acme')).resolves.toEqual(['active', 'dismesso'])
  })
})

describe('resolveCILifecycleSemantics', () => {
  /**
   * Questo test pinnava «esattamente come le costanti di prima», e per
   * `expired`/`revoked` asseriva NESSUNA semantica. Era la promessa della
   * migrazione 1810 — «il primo giorno non cambia niente» — e per quei due
   * valori quella promessa era un difetto: erano nel vocabolario SPEDITO e in
   * nessuna lista, quindi CI in servizio per il prodotto. Trovato aprendo un
   * tenant creato cinque minuti prima, che nasceva col banner della
   * diagnostica accesso su di loro.
   *
   * Ora il default li classifica fra i ritirati. Chi pinna il vecchio
   * comportamento e la MIGRAZIONE, che ha la sua copia congelata
   * (`POLICY_17_SET`) e il suo test: la storia resta storia.
   */
  it('i valori iniziali classificano tutti e sei gli stati spediti', async () => {
    getEventPolicy.mockResolvedValue(DEFAULT_EVENT_POLICY)
    const sem = await resolveCILifecycleSemantics('acme')
    // Era CI_LIFECYCLE_RETIRED = ['inactive', 'decommissioned'].
    expect(isRetiredLifecycle('inactive', sem)).toBe(true)
    expect(isRetiredLifecycle('decommissioned', sem)).toBe(true)
    expect(isRetiredLifecycle('active', sem)).toBe(false)
    expect(isRetiredLifecycle('maintenance', sem)).toBe(false)
    // Era CI_LIFECYCLE_MAINTENANCE = 'maintenance'.
    expect(isMaintenanceLifecycle('maintenance', sem)).toBe(true)
    expect(isMaintenanceLifecycle('inactive', sem)).toBe(false)
    // Un certificato scaduto o revocato NON e in servizio: ritirato, e non in
    // manutenzione (la manutenzione e temporanea, questi sono stati finali).
    for (const s of ['expired', 'revoked']) {
      expect(isRetiredLifecycle(s, sem)).toBe(true)
      expect(isMaintenanceLifecycle(s, sem)).toBe(false)
    }
    // Nessuno stato spedito resta senza semantica: e la condizione che il
    // banner della diagnostica verifica su ogni cliente.
    expect(CI_LIFECYCLE_STATUSES).toHaveLength(6)
    for (const s of CI_LIFECYCLE_STATUSES) {
      const classificato = s === 'active' || isRetiredLifecycle(s, sem) || isMaintenanceLifecycle(s, sem)
      expect(classificato, `lo stato "${s}" non e classificato da nessuna lista`).toBe(true)
    }
  })

  it('status assente → né ritirato né in manutenzione (mai un default)', async () => {
    getEventPolicy.mockResolvedValue(DEFAULT_EVENT_POLICY)
    const sem = await resolveCILifecycleSemantics('acme')
    for (const s of [null, undefined, '']) {
      expect(isRetiredLifecycle(s, sem)).toBe(false)
      expect(isMaintenanceLifecycle(s, sem)).toBe(false)
    }
  })

  /**
   * Il difetto, in una riga: prima `decommissioned` era scritto nel codice.
   * Un cliente che lo rinominava in `dismesso` si ritrovava i CI dismessi
   * dentro il calcolo della salute dei servizi, e i loro allarmi ad aprire
   * incident, **senza che nessuno lo dicesse**.
   */
  it('vocabolario RINOMINATO dal cliente: la semantica segue il dato', async () => {
    getEventPolicy.mockResolvedValue({
      ...DEFAULT_EVENT_POLICY,
      retired_statuses:     ['dismesso'],
      maintenance_statuses: ['in_manutenzione', 'fermo_programmato'],
      ignore_lifecycle_statuses: ['dismesso'],
    })
    const sem = await resolveCILifecycleSemantics('acme')
    expect(isRetiredLifecycle('dismesso', sem)).toBe(true)
    expect(isRetiredLifecycle('decommissioned', sem)).toBe(false)   // non è più del cliente
    expect(isMaintenanceLifecycle('in_manutenzione', sem)).toBe(true)
    expect(isMaintenanceLifecycle('fermo_programmato', sem)).toBe(true)
    expect(isMaintenanceLifecycle('maintenance', sem)).toBe(false)
    expect([...sem.ignored]).toEqual(['dismesso'])
  })

  it('liste vuote = nessuna semantica, e non si ripiega su niente', async () => {
    getEventPolicy.mockResolvedValue({ ...DEFAULT_EVENT_POLICY, retired_statuses: [], maintenance_statuses: [], ignore_lifecycle_statuses: [] })
    const sem = await resolveCILifecycleSemantics('acme')
    for (const s of CI_LIFECYCLE_STATUSES) {
      expect(isRetiredLifecycle(s, sem)).toBe(false)
      expect(isMaintenanceLifecycle(s, sem)).toBe(false)
    }
  })
})

describe('assertTenantLifecycleStatuses', () => {
  it('accetta i valori del cliente e rifiuta gli altri, nominando il campo', async () => {
    await expect(assertTenantLifecycleStatuses('acme', ['active', 'dismesso'], 'retired_statuses'))
      .resolves.toEqual(['active', 'dismesso'])
    await expect(assertTenantLifecycleStatuses('acme', ['decommissioned'], 'retired_statuses'))
      .rejects.toThrow(/retired_statuses: ci_status: "decommissioned" is not in the dictionary of this tenant/)
  })
})

describe('lifecyclePolicyReferences (ciò che rende sicure le due liste)', () => {
  const session = (raw: unknown) => ({
    executeRead: (fn: (tx: { run: () => Promise<unknown> }) => unknown) =>
      fn({ run: async () => ({ records: [{ get: () => raw }] }) }),
  })

  it('dice quali liste della policy citano il valore', async () => {
    const raw = JSON.stringify({
      ignore_lifecycle_statuses: ['decommissioned'],
      retired_statuses:          ['inactive', 'decommissioned', 'expired', 'revoked'],
      maintenance_statuses:      ['maintenance'],
    })
    await expect(lifecyclePolicyReferences(session(raw) as never, 'acme', 'decommissioned'))
      .resolves.toEqual(['ignore_lifecycle_statuses', 'retired_statuses'])
    await expect(lifecyclePolicyReferences(session(raw) as never, 'acme', 'maintenance'))
      .resolves.toEqual(['maintenance_statuses'])
    await expect(lifecyclePolicyReferences(session(raw) as never, 'acme', 'active'))
      .resolves.toEqual([])
  })

  it('policy assente, corrotta o di una versione precedente → non cita nulla, ed è vero (non è un errore da sollevare qui)', async () => {
    for (const raw of [null, '', '{nope', 42, JSON.stringify({ open_incident_from: 'critical' })]) {
      await expect(lifecyclePolicyReferences(session(raw) as never, 'acme', 'decommissioned')).resolves.toEqual([])
    }
  })
})

describe('initialCIStatus — lo stato con cui nasce un CI', () => {
  it('il DEFAULT DICHIARATO vince sulla posizione (revisione · C·N-2)', async () => {
    // Il difetto: `initialCIStatus` prendeva il primo valore della lista, e il
    // Dizionario sapeva solo aggiungere in coda — quindi rinominare `active` in
    // `attivo` lo spostava in fondo e un CI nuovo nasceva `inactive`, cioè in
    // `retired_statuses`: subito fuori dalla salute dei servizi, e i suoi
    // allarmi non aprivano più incident. Dichiarare il default toglie la regola
    // dalla posizione.
    vocabulary(['inactive', 'in_manutenzione', 'attivo'])
    declaredDefault('attivo')
    expect(await initialCIStatus('c-two')).toBe('attivo')
  })

  it('un default dichiarato ma FUORI vocabolario è un errore che lo nomina', async () => {
    vocabulary(['attivo', 'dismesso'])
    declaredDefault('active')
    await expect(initialCIStatus('c-two')).rejects.toThrow(/declares "active" as the initial state, but that value is not \(any more\) among its own/)
  })

  it('senza default dichiarato resta il primo valore, come prima (tenant non ancora migrato)', async () => {
    vocabulary(['attivo', 'in_manutenzione', 'dismesso'])
    expect(await initialCIStatus('c-two')).toBe('attivo')
    vocabulary(['active', 'inactive'])
    expect(await initialCIStatus('c-one')).toBe('active')
  })

  it('un vocabolario vuoto è un errore, non un ripiego', async () => {
    vocabulary([])
    await expect(initialCIStatus('c-two')).rejects.toThrow(/is empty: there is no state to create a CI with/)
  })
})
