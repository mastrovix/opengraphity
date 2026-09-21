/**
 * IL CLIENT CHE C'ERA GIÀ (20 set 2026, trovato dal vivo).
 *
 * Il proprietario ha creato il tenant `opengrafo` dalla console. La console
 * ha detto «created», il nodo `:Tenant` è nato, l'utente amministratore pure
 * — e aprendo `opengrafo.localhost` Keycloak rispondeva **«Invalid parameter:
 * redirect_uri»**. Il realm `opengrafo` esisteva da un'installazione
 * precedente (è l'unico che porta ancora un client `opengrafo-api`, che
 * l'onboarding di oggi non crea più), e il suo `opengrafo-web` aveva addosso
 * gli indirizzi di ritorno dell'epoca dei server di sviluppo:
 * `http://localhost:5173/*` e basta.
 *
 * L'onboarding è ADDITIVO per scelta — «nessun passo riallinea quello che
 * trova, perché potrebbe essere una personalizzazione del cliente» — e quella
 * regola resta. Ma gli indirizzi di ritorno sono la cosa senza la quale il
 * tenant non si apre affatto: lasciarli com'erano produceva un tenant che
 * **sembrava creato e non esisteva per chi doveva usarlo**.
 *
 * La correzione resta dentro la regola: non si sostituisce niente, si
 * AGGIUNGE ciò che manca. Questi test tengono fermo esattamente quel confine.
 */
import { describe, it, expect } from 'vitest'

interface ClientKc { id: string; redirectUris?: string[]; webOrigins?: string[] }

/**
 * Un Keycloak finto che risponde come quello vero: `post` su un client già
 * presente dà 409 (`created: false`), `get` restituisce quello che c'è, `put`
 * si registra.
 */
function keycloakFinto(clientEsistenti: Record<string, ClientKc>) {
  const put: Array<{ path: string; body: Record<string, unknown> }> = []
  return {
    put,
    kc: {
      baseUrl: 'http://kc',
      getAdminToken: async () => 'tok',
      get: async <T,>(_t: string, path: string): Promise<T> => {
        const m = /clientId=([^&]+)/.exec(path)
        const nome = m ? decodeURIComponent(m[1]!) : ''
        const c = clientEsistenti[nome]
        return (c ? [c] : []) as T
      },
      exists: async () => true,
      post: async (_t: string, path: string, body: unknown) => {
        const id = (body as { clientId?: string }).clientId
        if (path.endsWith('/clients') && id != null && id in clientEsistenti) return { created: false }
        return { id: 'nuovo', created: true }
      },
      put: async (_t: string, path: string, body: unknown) => {
        put.push({ path, body: body as Record<string, unknown> })
      },
      delete: async () => undefined,
      setPassword: async () => undefined,
    },
  }
}

/**
 * La funzione sotto prova è annidata in `onboardTenant`, che fa molte altre
 * cose (Neo4j, workflow, password). Qui si riproduce ESATTAMENTE la sua
 * logica di unione: se un giorno diverge, diverge anche il commento accanto
 * al codice, ed è lì che si guarda.
 */
async function assicuraRitorni(
  kc: ReturnType<typeof keycloakFinto>['kc'],
  slug: string,
  clientId: string,
  redirectUris: readonly string[],
  webOrigins: readonly string[],
  passo: (s: string) => void,
): Promise<void> {
  const trovati = await kc.get<ClientKc[]>('tok', `/admin/realms/${slug}/clients?clientId=${encodeURIComponent(clientId)}`)
  const cliente = trovati[0]
  if (cliente == null) { passo(`client "${clientId}" not found after creation — nothing to reconcile`); return }
  const mancanti = redirectUris.filter((u) => !(cliente.redirectUris ?? []).includes(u))
  const originiMancanti = webOrigins.filter((o) => !(cliente.webOrigins ?? []).includes(o))
  if (mancanti.length === 0 && originiMancanti.length === 0) { passo(`client "${clientId}": redirect URIs already complete`); return }
  await kc.put('tok', `/admin/realms/${slug}/clients/${cliente.id}`, {
    redirectUris: [...(cliente.redirectUris ?? []), ...mancanti],
    webOrigins:   [...(cliente.webOrigins ?? []), ...originiMancanti],
  })
  passo(`client "${clientId}": ${mancanti.length} redirect URI(s) added — it existed with a different configuration and the tenant would not have been reachable`)
}

const RICHIESTI = ['http://opengrafo.localhost/*', 'http://*.localhost/*']

describe('gli indirizzi di ritorno di un client che esisteva già', () => {
  it('IL CASO VERO: il client dell\'epoca dei dev server riceve gli indirizzi che mancano', async () => {
    const { kc, put } = keycloakFinto({
      'opengrafo-web': { id: 'c1', redirectUris: ['http://localhost:5173/*'], webOrigins: [] },
    })
    const passi: string[] = []
    await assicuraRitorni(kc, 'opengrafo', 'opengrafo-web', RICHIESTI, ['+'], (s) => passi.push(s))

    expect(put).toHaveLength(1)
    expect(put[0]!.body['redirectUris']).toEqual([
      'http://localhost:5173/*', 'http://opengrafo.localhost/*', 'http://*.localhost/*',
    ])
  })

  it('NON TOGLIE NIENTE: quello che il cliente aveva resta, in testa', async () => {
    const { kc, put } = keycloakFinto({
      'opengrafo-web': { id: 'c1', redirectUris: ['https://un-indirizzo-del-cliente.it/*'], webOrigins: ['https://un-indirizzo-del-cliente.it'] },
    })
    await assicuraRitorni(kc, 'opengrafo', 'opengrafo-web', RICHIESTI, ['+'], () => {})

    const scritti = put[0]!.body['redirectUris'] as string[]
    expect(scritti[0], 'la personalizzazione non si tocca e non si sposta').toBe('https://un-indirizzo-del-cliente.it/*')
    expect(scritti).toContain('http://opengrafo.localhost/*')
    expect(put[0]!.body['webOrigins']).toContain('https://un-indirizzo-del-cliente.it')
  })

  it('se non manca niente NON SCRIVE: un onboarding rilanciato non tocca Keycloak', async () => {
    const { kc, put } = keycloakFinto({
      'opengrafo-web': { id: 'c1', redirectUris: [...RICHIESTI], webOrigins: ['+'] },
    })
    const passi: string[] = []
    await assicuraRitorni(kc, 'opengrafo', 'opengrafo-web', RICHIESTI, ['+'], (s) => passi.push(s))

    expect(put).toHaveLength(0)
    expect(passi[0]).toContain('already complete')
  })

  it('LO DICE: un onboarding che tocca qualcosa in silenzio è peggio di uno che non tocca', async () => {
    const { kc } = keycloakFinto({
      'opengrafo-web': { id: 'c1', redirectUris: ['http://localhost:5173/*'], webOrigins: [] },
    })
    const passi: string[] = []
    await assicuraRitorni(kc, 'opengrafo', 'opengrafo-web', RICHIESTI, ['+'], (s) => passi.push(s))

    expect(passi[0]).toContain('redirect URI(s) added')
    expect(passi[0], 'e dice la conseguenza, non solo il fatto').toContain('would not have been reachable')
  })

  it('un client che non c\'è non fa crollare l\'onboarding', async () => {
    const { kc, put } = keycloakFinto({})
    const passi: string[] = []
    await assicuraRitorni(kc, 'opengrafo', 'opengrafo-web', RICHIESTI, ['+'], (s) => passi.push(s))
    expect(put).toHaveLength(0)
    expect(passi[0]).toContain('nothing to reconcile')
  })

  it('il finto risponde come il vero: `post` su un client presente dà created=false', async () => {
    const { kc } = keycloakFinto({ 'opengrafo-web': { id: 'c1' } })
    expect(await kc.post('tok', '/admin/realms/opengrafo/clients', { clientId: 'opengrafo-web' })).toEqual({ created: false })
    expect((await kc.post('tok', '/admin/realms/opengrafo/clients', { clientId: 'altro' })).created).toBe(true)
  })
})
