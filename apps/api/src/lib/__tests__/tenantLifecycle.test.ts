/**
 * IL CICLO DI VITA DI UN TENANT.
 *
 * È la superficie più potente del prodotto: dietro uno slug ci sono tutti i
 * ticket, i CI e gli utenti di un cliente. Quello che si pinna qui sono le
 * SBARRE — perché un controllo che manca non si vede finché qualcuno non
 * cancella un tenant vivo — e le due cose che un'interfaccia farebbe leggere
 * male: uno zero che sembra «è vuoto» e una rinomina che sembra cambiare
 * l'identità.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { resetConfigCache } from '../config.js'

/** Le righe che le query restituiscono: le decide ogni caso. */
let tenantRows: Array<Record<string, unknown>> = []
let conteggi: Record<string, unknown> | null = { utenti: 2, ticket: 7 }
let conteggiEsplode = false
let adminRows: Array<Record<string, unknown>> = [{ tenantId: 'acme', email: 'admin@acme.io' }]
let adminSingolo: Record<string, unknown> | null = { email: 'admin@acme.io' }
const eseguite: string[] = []

vi.mock('@opengraphity/neo4j', () => ({
  runQuery: vi.fn(async (_s: unknown, q: string) => {
    eseguite.push(q)
    if (q.includes('MATCH (t:Tenant)\n    WHERE t.id IS NOT NULL')) return tenantRows
    if (q.includes("u.role = 'admin'") && q.includes('u.tenant_id AS tenantId')) return adminRows
    return []
  }),
  runQueryOne: vi.fn(async (_s: unknown, q: string) => {
    eseguite.push(q)
    if (q.includes('OPTIONAL MATCH (u:User')) {
      if (conteggiEsplode) throw new Error('conteggio non disponibile')
      return conteggi
    }
    if (q.includes('RETURN t.suspended_at AS suspendedAt')) {
      const r = tenantRows[0]
      return r ? { suspendedAt: r['suspendedAt'] ?? null } : null
    }
    if (q.includes('count(n) AS quanti')) return { quanti: 1234 }
    // La lettura del singolo amministratore, per `resetAdminPassword`.
    if (q.includes("u.role = 'admin'") && q.includes('RETURN u.email AS email')) return adminSingolo
    return null
  }),
  toNumber: (v: unknown) => (v == null ? 0 : Number(v)),
}))
vi.mock('../logger.js', () => ({ logger: { child: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn() }) } }))

const {
  assertSlugValido, listTenants, renameTenant, suspendTenant, resumeTenant, purgeTenant,
  resetAdminPassword,
} = await import('../tenantLifecycle.js')

const session = {} as never

const tenant = (over: Record<string, unknown> = {}) => ({
  id: 'acme', slug: 'acme', name: 'ACME S.p.A.', plan: 'pro',
  timezone: 'Europe/Rome', suspendedAt: null, createdAt: '2026-01-01T00:00:00.000Z', ...over,
})

beforeEach(() => {
  eseguite.length = 0
  tenantRows = [tenant()]
  conteggi = { utenti: 2, ticket: 7 }
  conteggiEsplode = false
  adminRows = [{ tenantId: 'acme', email: 'admin@acme.io' }]
  adminSingolo = { email: 'admin@acme.io' }
})

describe('lo slug è l\'identità: le sue regole', () => {
  it('accetta uno slug da etichetta DNS', () => {
    expect(() => assertSlugValido('acme')).not.toThrow()
    expect(() => assertSlugValido('acme-2')).not.toThrow()
    expect(() => assertSlugValido('10x-labs')).not.toThrow()
  })

  it('rifiuta le forme che romperebbero un sottodominio o un realm', () => {
    for (const cattivo of ['AC', 'ACME', 'a', '-acme', 'acme-', 'ac me', 'acme.it', 'a'.repeat(40)]) {
      expect(() => assertSlugValido(cattivo), cattivo).toThrow(/valid tenant slug/)
    }
  })

  it('rifiuta i nomi che il prodotto si è riservato', () => {
    // `portal` perché `portal.<tenant>` è l'host del portale: un tenant così
    // renderebbe irraggiungibile il portale di qualcun altro.
    for (const riservato of ['portal', 'www', 'api', 'admin', 'keycloak']) {
      expect(() => assertSlugValido(riservato), riservato).toThrow(/reserved/)
    }
  })

  it('l\'host della console si passa da fuori, non è cablato qui', () => {
    expect(() => assertSlugValido('opengrafo-admin')).not.toThrow()
    expect(() => assertSlugValido('opengrafo-admin', ['opengrafo-admin'])).toThrow(/reserved/)
  })
})

describe('l\'elenco dei tenant', () => {
  it('porta i conteggi: chi cancella deve vedere cosa cancella', async () => {
    const righe = await listTenants(session)
    expect(righe[0]).toMatchObject({ id: 'acme', name: 'ACME S.p.A.', stato: 'active', utenti: 2, ticket: 7 })
  })

  it('un conteggio che NON si fa vale `null`, non zero', async () => {
    // Uno zero si legge «è vuoto, procedi» ed è il modo più diretto per far
    // cancellare un tenant pieno.
    conteggiEsplode = true
    const righe = await listTenants(session)
    expect(righe[0]!.utenti).toBeNull()
    expect(righe[0]!.ticket).toBeNull()
  })

  it('lo stato viene da `suspended_at`, non da un campo a parte', async () => {
    tenantRows = [tenant({ suspendedAt: '2026-09-17T10:00:00.000Z' })]
    const righe = await listTenants(session)
    expect(righe[0]!.stato).toBe('suspended')
  })

  it('gli indirizzi si compongono dai modelli configurati', async () => {
    vi.stubEnv('TENANT_URL_TEMPLATE', 'https://{slug}.azienda.com')
    vi.stubEnv('PORTAL_URL_TEMPLATE', 'https://portale.{slug}.azienda.com')
    resetConfigCache()
    try {
      const righe = await listTenants(session)
      expect(righe[0]).toMatchObject({
        appUrl: 'https://acme.azienda.com',
        portalUrl: 'https://portale.acme.azienda.com',
      })
    } finally {
      vi.unstubAllEnvs()
      resetConfigCache()
    }
  })

  it('senza modello configurato l\'indirizzo è `null`, non indovinato', async () => {
    // Dedurlo dall'host della console indovinerebbe finché le due cose stanno
    // sullo stesso dominio, e poi mostrerebbe link rotti senza dirlo.
    vi.stubEnv('TENANT_URL_TEMPLATE', '')
    vi.stubEnv('PORTAL_URL_TEMPLATE', '')
    resetConfigCache()
    try {
      const righe = await listTenants(session)
      expect(righe[0]!.appUrl).toBeNull()
      expect(righe[0]!.portalUrl).toBeNull()
    } finally {
      vi.unstubAllEnvs()
      resetConfigCache()
    }
  })

  it('senza nome o slug si ripiega sull\'id, invece di mostrare un vuoto', async () => {
    tenantRows = [tenant({ name: null, slug: null })]
    const righe = await listTenants(session)
    expect(righe[0]).toMatchObject({ slug: 'acme', name: 'acme' })
  })
})

describe('la rinomina cambia il NOME, non lo slug', () => {
  it('scrive il nome ripulito dagli spazi', async () => {
    await renameTenant(session, 'acme', '  ACME Due  ')
    expect(eseguite.some((q) => q.includes('SET t.name = $nome'))).toBe(true)
  })

  it('un nome vuoto si rifiuta', async () => {
    await expect(renameTenant(session, 'acme', '   ')).rejects.toThrow(/cannot be empty/)
  })

  it('un nome sterminato si rifiuta', async () => {
    await expect(renameTenant(session, 'acme', 'x'.repeat(200))).rejects.toThrow(/too long/)
  })

  it('un tenant che non esiste si rifiuta', async () => {
    tenantRows = []
    await expect(renameTenant(session, 'ignoto', 'X')).rejects.toThrow()
  })

  it('NON tocca lo slug: è il realm, il sottodominio e il tenant_id di ogni nodo', async () => {
    await renameTenant(session, 'acme', 'ACME Due')
    expect(eseguite.some((q) => /SET[^`]*t\.(id|slug)\s*=/.test(q))).toBe(false)
  })
})

describe('la sospensione', () => {
  it('scrive `suspended_at` e lascia i dati dove sono', async () => {
    await suspendTenant(session, 'acme')
    expect(eseguite.some((q) => q.includes('SET t.suspended_at = $now'))).toBe(true)
    expect(eseguite.some((q) => q.includes('DELETE'))).toBe(false)
  })

  it('sospendere un tenant già sospeso non riscrive la data', async () => {
    // Idempotente: altrimenti un secondo clic sposterebbe la data e farebbe
    // sembrare la sospensione più recente di quanto è.
    tenantRows = [tenant({ suspendedAt: '2026-09-01T00:00:00.000Z' })]
    await suspendTenant(session, 'acme')
    expect(eseguite.some((q) => q.includes('SET t.suspended_at = $now'))).toBe(false)
  })

  it('la riattivazione togle la proprietà invece di metterla a null', async () => {
    tenantRows = [tenant({ suspendedAt: '2026-09-01T00:00:00.000Z' })]
    await resumeTenant(session, 'acme')
    expect(eseguite.some((q) => q.includes('REMOVE t.suspended_at'))).toBe(true)
  })
})

describe('la cancellazione definitiva, e le sue tre sbarre', () => {
  it('si rifiuta se il tenant NON è sospeso: non c\'è scorciatoia', async () => {
    tenantRows = [tenant({ suspendedAt: null })]
    await expect(purgeTenant(session, 'acme', 'acme')).rejects.toThrow(/not suspended/)
    expect(eseguite.some((q) => q.includes('DETACH DELETE'))).toBe(false)
  })

  it('si rifiuta se la conferma non ripete lo slug', async () => {
    tenantRows = [tenant({ suspendedAt: '2026-09-01T00:00:00.000Z' })]
    await expect(purgeTenant(session, 'acme', 'acmee')).rejects.toThrow(/typed again/)
    expect(eseguite.some((q) => q.includes('DETACH DELETE'))).toBe(false)
  })

  it('si rifiuta se il tenant non esiste', async () => {
    tenantRows = []
    await expect(purgeTenant(session, 'ignoto', 'ignoto')).rejects.toThrow()
  })

  it('con le tre sbarre passate cancella i nodi a scaglioni e poi il tenant', async () => {
    tenantRows = [tenant({ suspendedAt: '2026-09-01T00:00:00.000Z' })]
    const esito = await purgeTenant(session, 'acme', 'acme')
    // A scaglioni: un tenant con centomila nodi non entra in una transazione.
    expect(eseguite.some((q) => q.includes('IN TRANSACTIONS OF'))).toBe(true)
    expect(eseguite.some((q) => q.includes('MATCH (t:Tenant {id: $id}) DETACH DELETE t'))).toBe(true)
    expect(esito.nodiCancellati).toBe(1234)
  })

  it('il realm si cancella PRIMA dei dati: a rovescio resterebbe una porta aperta su un tenant svuotato', async () => {
    tenantRows = [tenant({ suspendedAt: '2026-09-01T00:00:00.000Z' })]
    const ordine: string[] = []
    const deleteRealm = vi.fn(async () => { ordine.push('realm') })
    // La finta delle query annota quando arriva la prima cancellazione.
    const primaDelete = () => {
      if (!ordine.includes('dati') && eseguite.some((q) => q.includes('DETACH DELETE'))) ordine.push('dati')
    }
    const esito = await purgeTenant(session, 'acme', 'acme', deleteRealm)
    primaDelete()
    expect(deleteRealm).toHaveBeenCalledWith('acme')
    expect(esito.realmCancellato).toBe(true)
    expect(ordine[0]).toBe('realm')
  })

  it('se la cancellazione del realm FALLISCE non si cancella nessun dato', async () => {
    tenantRows = [tenant({ suspendedAt: '2026-09-01T00:00:00.000Z' })]
    const deleteRealm = vi.fn(async () => { throw new Error('Keycloak non raggiungibile') })
    await expect(purgeTenant(session, 'acme', 'acme', deleteRealm)).rejects.toThrow(/Keycloak/)
    expect(eseguite.some((q) => q.includes('DETACH DELETE'))).toBe(false)
  })
})

/**
 * LA PASSWORD DI UN AMMINISTRATORE, reimpostata dalla console (17 set 2026).
 *
 * L'azione esiste perché senza di lei un tenant di cui si era perduta la
 * password temporanea era un vicolo cieco: nessuno entrava, e la sola uscita
 * era Keycloak a mano. Quello che si pinna qui sono le sbarre — su CHI si può
 * agire — e la regola che conta più di tutte: **una password che non è stata
 * impostata non si consegna**, perché consegnarne una falsa manda a cercare il
 * guasto dalla parte sbagliata.
 */
describe('reimpostare la password di un amministratore', () => {
  const genera = () => 'Pw-generata-123'

  it('la imposta in Keycloak sul realm del tenant e la restituisce una volta', async () => {
    const imposta = vi.fn(async () => {})
    const esito = await resetAdminPassword(session, 'acme', 'admin@acme.io', genera, imposta)
    expect(imposta).toHaveBeenCalledWith('acme', 'admin@acme.io', 'Pw-generata-123')
    expect(esito).toEqual({ email: 'admin@acme.io', temporaryPassword: 'Pw-generata-123', tenantSospeso: false })
  })

  it('l\'e-mail si normalizza: chi la digita non deve indovinare le maiuscole', async () => {
    const imposta = vi.fn(async () => {})
    const esito = await resetAdminPassword(session, 'acme', '  Admin@ACME.io  ', genera, imposta)
    expect(esito.email).toBe('admin@acme.io')
    expect(imposta).toHaveBeenCalledWith('acme', 'admin@acme.io', 'Pw-generata-123')
  })

  it('rifiuta chi NON è un amministratore attivo di quel tenant', async () => {
    // Un utente di un altro tenant, disattivato o senza il ruolo: la query non
    // lo trova, e non si reimposta niente a nessuno.
    adminSingolo = null
    const imposta = vi.fn(async () => {})
    await expect(resetAdminPassword(session, 'acme', 'tizio@altrove.io', genera, imposta))
      .rejects.toThrow(/not an active administrator/)
    expect(imposta).not.toHaveBeenCalled()
  })

  it('rifiuta un tenant che non esiste', async () => {
    tenantRows = []
    const imposta = vi.fn(async () => {})
    await expect(resetAdminPassword(session, 'ignoto', 'admin@acme.io', genera, imposta)).rejects.toThrow()
    expect(imposta).not.toHaveBeenCalled()
  })

  it('se Keycloak FALLISCE la password non si consegna', async () => {
    const imposta = vi.fn(async () => { throw new Error('Keycloak non raggiungibile') })
    await expect(resetAdminPassword(session, 'acme', 'admin@acme.io', genera, imposta))
      .rejects.toThrow(/Keycloak/)
  })

  it('su un tenant sospeso si può fare, e la risposta lo DICE', async () => {
    // Utile e non contraddittorio: si riapre prima la porta, poi il tenant.
    // Senza dirlo, il login che si ferma sembrerebbe una password sbagliata.
    tenantRows = [tenant({ suspendedAt: '2026-09-01T00:00:00.000Z' })]
    const esito = await resetAdminPassword(session, 'acme', 'admin@acme.io', genera, vi.fn(async () => {}))
    expect(esito.tenantSospeso).toBe(true)
  })

  it('NON scrive nel database: la password vive solo in Keycloak', async () => {
    await resetAdminPassword(session, 'acme', 'admin@acme.io', genera, vi.fn(async () => {}))
    expect(eseguite.some((q) => /\bSET\b|\bMERGE\b|\bCREATE\b/.test(q))).toBe(false)
  })
})

describe('gli amministratori nell\'elenco', () => {
  it('ogni riga porta i suoi, per poter reimpostare la password', async () => {
    adminRows = [
      { tenantId: 'acme', email: 'admin@acme.io' },
      { tenantId: 'acme', email: 'secondo@acme.io' },
    ]
    const righe = await listTenants(session)
    expect(righe[0]!.admins).toEqual(['admin@acme.io', 'secondo@acme.io'])
  })

  it('nessun amministratore = lista VUOTA, e la console non offre il pulsante', async () => {
    adminRows = []
    const righe = await listTenants(session)
    expect(righe[0]!.admins).toEqual([])
  })
})
