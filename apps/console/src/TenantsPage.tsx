/**
 * LA PAGINA DEI TENANT.
 *
 * In INGLESE, e per una ragione dichiarata: la regola sulla lingua di questo
 * prodotto esiste perché è il CLIENTE a scegliere la sua, e questa pagina non
 * la vede nessun cliente — è lo strumento di chi gestisce la piattaforma. Non
 * c'è i18n per una pagina sola, e non si finge che ci sia.
 *
 * ## Le tre cose che l'interfaccia deve far capire
 *  1. cosa si sta per distruggere: la riga porta utenti e ticket, e il riquadro
 *     di cancellazione l'elenco dei nodi per etichetta. Un conteggio che non si
 *     è potuto fare dice «unknown», non zero — «0 tickets» si legge «è vuoto».
 *  2. che sospendere NON è cancellare: sono due comandi diversi, in due posti
 *     diversi, e il secondo pretende il primo.
 *  3. che la cancellazione è definitiva: riquadro rosso a sé, lo slug da
 *     ridigitare, e il conto dei nodi davanti agli occhi.
 */
import { useCallback, useEffect, useState } from 'react'
import { api, messaggio, type Tenant, type NuovoTenant, type EsitoCreazione, type EsitoResetPassword } from './api'
import { LogOut, Plus } from 'lucide-react'
import { getKeycloak } from './keycloak'
import { collegaAvvisi } from './tokenRefresh'
import { QueuesPanel } from './QueuesPanel'
import { IntegrityPanel } from './IntegrityPanel'

function Conteggio({ n }: { n: number | null }) {
  // `null` non è zero: dirlo «0» manderebbe a cancellare un tenant pieno.
  if (n === null) return <span className="unknown">unknown</span>
  return <>{n.toLocaleString('en-GB')}</>
}

function Riga({ t, onRename, onSuspend, onResume, onPurge, onPassword, occupato }: {
  t: Tenant
  onRename: (slug: string, nome: string) => void
  onSuspend: (slug: string) => void
  onResume: (slug: string) => void
  onPurge: (slug: string) => void
  onPassword: (t: Tenant) => void
  occupato: boolean
}) {
  const [inModifica, setInModifica] = useState(false)
  const [bozza, setBozza] = useState(t.name)

  return (
    <tr className={t.stato === 'suspended' ? 'suspended' : undefined}>
      <td className="slug">{t.slug}</td>
      <td>
        {inModifica ? (
          <span className="riga">
            <input
              value={bozza}
              onChange={(e) => setBozza(e.target.value)}
              aria-label={`New name for ${t.slug}`}
              size={24}
            />
            <button onClick={() => { onRename(t.slug, bozza); setInModifica(false) }} disabled={occupato}>Save</button>
            <button onClick={() => { setBozza(t.name); setInModifica(false) }}>Cancel</button>
          </span>
        ) : t.name}
      </td>
      <td>{t.plan ?? <span className="unknown">not set</span>}</td>
      {/* I due indirizzi del tenant. Si aprono in una scheda nuova: la console
          non deve perdersi perché qualcuno è andato a guardare un'app. Un
          tenant SOSPESO conserva i link — portano al login e si fermano lì, ed
          è il modo più diretto per verificare che la sospensione funzioni. */}
      <td className="urls">
        {t.appUrl
          ? <a href={t.appUrl} target="_blank" rel="noreferrer noopener">{t.appUrl.replace(/^https?:\/\//, '')}</a>
          : <span className="unknown">not configured</span>}
        {t.portalUrl && (
          <a href={t.portalUrl} target="_blank" rel="noreferrer noopener" className="portale">
            portal
          </a>
        )}
      </td>
      <td className="num"><Conteggio n={t.utenti} /></td>
      <td className="num"><Conteggio n={t.ticket} /></td>
      <td>
        <span className={`pill ${t.stato}`}>{t.stato === 'active' ? 'active' : 'suspended'}</span>
        {/* Un tenant senza amministratori attivi è un tenant in cui NESSUNO
            entra, e non si vede da nessun'altra colonna: gli utenti possono
            essere dieci e nessuno di loro un admin. Si dice qui, dove si
            guarda lo stato. */}
        {t.admins.length === 0 && <span className="pill senzaAdmin" title="No active administrator: nobody can sign in">no admin</span>}
      </td>
      <td>
        <div className="azioni">
          {!inModifica && <button onClick={() => setInModifica(true)} disabled={occupato}>Rename</button>}
          {t.stato === 'active'
            ? <button onClick={() => onSuspend(t.slug)} disabled={occupato}>Suspend</button>
            : <button onClick={() => onResume(t.slug)} disabled={occupato}>Resume</button>}
          {/* La password: offerta solo se c'è un amministratore su cui agire —
              come la cancellazione, il pulsante non c'è invece di esserci e
              rifiutare. Questa azione esiste perché senza di lei un tenant di
              cui si è perduta la password era un vicolo cieco, riapribile solo
              a mano da Keycloak (17 set 2026). */}
          {t.admins.length > 0 && (
            <button onClick={() => onPassword(t)} disabled={occupato}>Reset password…</button>
          )}
          {/* La cancellazione si offre SOLO su un tenant sospeso: il pulsante
              non c'è, invece di esserci e rifiutare. Un'azione offerta e poi
              negata insegna che l'interfaccia mente. */}
          {t.stato === 'suspended' && (
            <button className="danger" onClick={() => onPurge(t.slug)} disabled={occupato}>Delete…</button>
          )}
        </div>
      </td>
    </tr>
  )
}

function RiquadroCancellazione({ slug, onFatto, onAnnulla, setErrore }: {
  slug: string
  onFatto: (messaggio: string) => void
  onAnnulla: () => void
  setErrore: (e: string | null) => void
}) {
  const [nodi, setNodi] = useState<Record<string, number> | null>(null)
  const [conferma, setConferma] = useState('')
  const [inCorso, setInCorso] = useState(false)

  useEffect(() => {
    let vivo = true
    api.footprint(slug)
      .then((r) => { if (vivo) setNodi(r.nodes) })
      .catch((e: unknown) => setErrore(messaggio(e)))
    return () => { vivo = false }
  }, [slug, setErrore])

  const totale = nodi ? Object.values(nodi).reduce((a, b) => a + b, 0) : null

  return (
    <div className="purge">
      <h2>Delete “{slug}” permanently</h2>
      <p>
        This removes the Keycloak realm and every node of this tenant — tickets, CIs, users, attachments
        metadata, audit. It cannot be undone, and there is no export step: take a backup first if the data
        matters.
      </p>
      <div className="footprint">
        {nodi === null
          ? 'counting what would be deleted…'
          : Object.keys(nodi).length === 0
            ? 'no nodes carry this tenant id'
            : (
              <>
                {Object.entries(nodi).map(([etichetta, quanti]) => (
                  <div key={etichetta}>{etichetta}: {quanti.toLocaleString('en-GB')}</div>
                ))}
                <div style={{ marginTop: 6, fontWeight: 600 }}>total: {totale?.toLocaleString('en-GB')}</div>
              </>
            )}
      </div>
      <div className="riga">
        <label htmlFor="conferma">Type <strong>{slug}</strong> to confirm:</label>
        <input
          id="conferma"
          value={conferma}
          onChange={(e) => setConferma(e.target.value)}
          autoComplete="off"
          size={20}
        />
        <button
          className="danger"
          disabled={conferma !== slug || inCorso}
          onClick={() => {
            setInCorso(true)
            setErrore(null)
            api.purge(slug, conferma)
              .then((r) => onFatto(`“${slug}” deleted: ${r.nodiCancellati.toLocaleString('en-GB')} nodes removed${r.realmCancellato ? ', Keycloak realm removed' : ''}.`))
              .catch((e: unknown) => setErrore(messaggio(e)))
              .finally(() => setInCorso(false))
          }}
        >
          {inCorso ? 'Deleting…' : 'Delete permanently'}
        </button>
        <button onClick={onAnnulla} disabled={inCorso}>Keep it</button>
      </div>
    </div>
  )
}

/**
 * CREARE UN TENANT.
 *
 * Lo slug è l'unico campo che non si potrà cambiare dopo — è il realm, il
 * sottodominio e il `tenant_id` di ogni nodo — quindi è il primo, con scritto
 * accanto che è definitivo. Tutto il resto ha un valore ragionevole già dentro.
 *
 * La password del primo amministratore la genera Keycloak, è temporanea e si
 * vede UNA volta: il riquadro con la password non si chiude da sé e lo dice a
 * chiare lettere, perché chi la perde non la recupera — si reimposta da
 * Keycloak.
 */
function Creazione({ onCreato, setErrore }: {
  onCreato: (esito: EsitoCreazione) => void
  setErrore: (e: string | null) => void
}) {
  const [aperto, setAperto] = useState(false)
  const [inCorso, setInCorso] = useState(false)
  const [c, setC] = useState<NuovoTenant>({
    slug: '', name: '', plan: 'starter',
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    adminEmail: '', adminFirstName: '', adminLastName: '',
  })

  const campo = (k: keyof NuovoTenant) => ({
    value: c[k],
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => setC((p) => ({ ...p, [k]: e.target.value })),
  })

  if (!aperto) {
    return (
      <div style={{ marginBottom: 18 }}>
        <button className="primario" onClick={() => { setAperto(true); setErrore(null) }}>
          <Plus size={14} style={{ verticalAlign: -2, marginRight: 4 }} aria-hidden="true" />
          New tenant
        </button>
      </div>
    )
  }

  const pronto = c.slug.trim() !== '' && c.adminEmail.trim() !== ''

  return (
    <div className="creazione">
      <h2>New tenant</h2>
      <div className="campi">
        <label>
          Slug
          <input {...campo('slug')} placeholder="acme" autoComplete="off" spellCheck={false} />
          <span className="aiuto">
            Permanent: it is the Keycloak realm, the subdomain and the tenant id of every node.
            Lowercase letters, digits and hyphens.
          </span>
        </label>
        <label>
          Display name
          <input {...campo('name')} placeholder="ACME S.p.A." />
          <span className="aiuto">Shown in the app. This one can be changed later.</span>
        </label>
        <label>
          Plan
          <select
            value={c.plan}
            onChange={(e) => setC((p) => ({ ...p, plan: e.target.value }))}
          >
            <option value="starter">starter</option>
            <option value="pro">pro</option>
            <option value="enterprise">enterprise</option>
          </select>
        </label>
        <label>
          Timezone
          <input {...campo('timezone')} placeholder="Europe/Rome" spellCheck={false} />
          <span className="aiuto">An IANA zone. SLA clocks are counted in it.</span>
        </label>
        <label>
          First administrator — email
          <input {...campo('adminEmail')} type="email" placeholder="mario@acme.com" autoComplete="off" />
          <span className="aiuto">How they sign in. A one-time password is generated and shown once.</span>
        </label>
        <label>
          First name
          <input {...campo('adminFirstName')} placeholder="Mario" />
        </label>
        <label>
          Last name
          <input {...campo('adminLastName')} placeholder="Rossi" />
        </label>
      </div>
      <div className="riga" style={{ marginTop: 14 }}>
        <button
          className="primario"
          disabled={!pronto || inCorso}
          onClick={() => {
            setInCorso(true)
            setErrore(null)
            api.create(c)
              .then((esito) => { setAperto(false); onCreato(esito) })
              .catch((e: unknown) => setErrore(messaggio(e)))
              .finally(() => setInCorso(false))
          }}
        >
          {inCorso ? 'Creating…' : 'Create tenant'}
        </button>
        <button onClick={() => setAperto(false)} disabled={inCorso}>Cancel</button>
        {inCorso && (
          <span className="aiuto">
            Keycloak realm, clients, the first administrator, then the workflows: it takes a few seconds.
          </span>
        )}
      </div>
    </div>
  )
}

/**
 * LA PASSWORD, UNA VOLTA SOLA.
 *
 * Non è scritta da nessuna parte e non si può richiedere: questo riquadro è
 * l'unico posto in cui compare. Per questo non si chiude da sé, non sparisce
 * caricando l'elenco, e lo dice.
 *
 * Serve a DUE momenti — un tenant appena creato e una password reimpostata —
 * e sono lo stesso momento visto due volte: qualcuno sta guardando l'unica
 * copia di un segreto. Una seconda versione del riquadro avrebbe finito per
 * divergere proprio qui.
 */
function PasswordUnaVolta({ titolo, spiegazione, password, onChiudi }: {
  titolo: string
  spiegazione: string
  password: string
  onChiudi: () => void
}) {
  const [copiata, setCopiata] = useState(false)
  return (
    <div className="password">
      <h2>{titolo}</h2>
      <p>{spiegazione}</p>
      <div className="riga">
        <code>{password}</code>
        <button onClick={() => { void navigator.clipboard.writeText(password).then(() => setCopiata(true)) }}>
          {copiata ? 'Copied' : 'Copy'}
        </button>
        <button onClick={onChiudi}>I have it</button>
      </div>
    </div>
  )
}

/**
 * REIMPOSTARE LA PASSWORD DI UN AMMINISTRATORE.
 *
 * Chiude il vicolo cieco che questa console aveva: la password si vedeva una
 * volta alla creazione e, se la si perdeva, in quel tenant non entrava più
 * nessuno — la sola via d'uscita era Keycloak a mano. Il riquadro della
 * creazione lo diceva pure, «if it is lost, reset it in Keycloak»: una frase
 * che ammetteva il pezzo mancante invece di essere il pezzo.
 *
 * CHI si sceglie, non si indovina: l'elenco arriva dal server (amministratori
 * attivi di quel tenant) e con più di uno la scelta è esplicita. Reimpostare
 * «il primo admin» avrebbe, prima o poi, cambiato la password alla persona
 * sbagliata.
 */
function RiquadroPassword({ t, onFatta, onAnnulla, setErrore }: {
  t: Tenant
  onFatta: (esito: EsitoResetPassword) => void
  onAnnulla: () => void
  setErrore: (m: string | null) => void
}) {
  const [email, setEmail] = useState(t.admins[0] ?? '')
  const [inCorso, setInCorso] = useState(false)

  return (
    <div className="riquadro">
      <h2>New temporary password for “{t.slug}”</h2>
      <p>
        The chosen administrator gets a new temporary password and must change it at first sign-in.
        The current password stops working immediately. The new one is shown here once.
      </p>

      {t.admins.length === 1 ? (
        <p className="chi"><strong>{t.admins[0]}</strong></p>
      ) : (
        <label className="campo">
          Administrator
          <select value={email} onChange={(e) => setEmail(e.target.value)} disabled={inCorso}>
            {t.admins.map((a) => <option key={a} value={a}>{a}</option>)}
          </select>
        </label>
      )}

      {/* Un tenant sospeso si può comunque riaprire: la password sarà valida
          quando lo riattivi. Dirlo qui evita la conclusione sbagliata («la
          password non funziona») quando il login si fermerà. */}
      {t.stato === 'suspended' && (
        <p className="nota">
          This tenant is suspended: the password will be valid, but nobody can sign in until you resume it.
        </p>
      )}

      <div className="riga">
        <button
          className="primario"
          disabled={inCorso || email === ''}
          onClick={() => {
            setInCorso(true)
            setErrore(null)
            api.resetPassword(t.slug, email)
              .then(onFatta)
              .catch((e: unknown) => { setErrore(messaggio(e)); setInCorso(false) })
          }}
        >
          {inCorso ? 'Resetting…' : 'Reset password'}
        </button>
        <button onClick={onAnnulla} disabled={inCorso}>Cancel</button>
      </div>
    </div>
  )
}

export function TenantsPage() {
  const [tenants, setTenants] = useState<Tenant[] | null>(null)
  const [errore, setErrore] = useState<string | null>(null)
  const [esito, setEsito] = useState<string | null>(null)
  const [daCancellare, setDaCancellare] = useState<string | null>(null)
  const [appenaCreato, setAppenaCreato] = useState<EsitoCreazione | null>(null)
  /** Il tenant di cui si sta reimpostando la password, e la password appena data. */
  const [daReimpostare, setDaReimpostare] = useState<Tenant | null>(null)
  const [passwordNuova, setPasswordNuova] = useState<EsitoResetPassword | null>(null)
  const [occupato, setOccupato] = useState(false)

  /*
   * Gli avvisi del rinnovo del token arrivano nella pagina: «Keycloak
   * unreachable — retrying in Ns» va letto, non lasciato nella console del
   * browser. Si collegano una volta, al montaggio.
   */
  useEffect(() => {
    collegaAvvisi(
      (m) => setErrore(m),
      (m) => { setErrore(null); setEsito(m) },
    )
  }, [])

  const carica = useCallback(() => {
    api.tenants()
      .then((r) => setTenants(r.tenants))
      .catch((e: unknown) => setErrore(messaggio(e)))
  }, [])

  useEffect(carica, [carica])

  /** Ogni azione: l'errore si mostra, e l'elenco torna dal server — non si indovina lo stato nuovo. */
  const azione = (p: Promise<{ tenants: Tenant[] }>) => {
    setOccupato(true)
    setErrore(null)
    setEsito(null)
    p.then((r) => setTenants(r.tenants))
      .catch((e: unknown) => setErrore(messaggio(e)))
      .finally(() => setOccupato(false))
  }

  const email = (() => {
    try { return (getKeycloak().tokenParsed as { email?: string } | undefined)?.email ?? '' } catch { return '' }
  })()

  const iniziali = (email.split('@')[0] ?? '?')
    .split(/[.\-_]/)
    .map((p) => p[0] ?? '')
    .slice(0, 2)
    .join('')
    .toUpperCase() || '?'

  return (
    <>
      {/* L'intestazione ha la forma di quella del portale — fissa, 60px, marchio
          a sinistra e identità a destra — con una pastiglia in più che dice DOVE
          sei: «platform console». Somigliare al portale è quello che serve, ma
          non deve poterla confondere con l'app di un cliente. */}
      <header className="top">
        <div className="inner">
          <span className="marchio">
            <img src="/opengrafo-logo.svg" alt="" />
            <span className="nome">OpenGrafo</span>
            <span className="dove">platform console</span>
          </span>
          <span className="chi">
            <span className="email">{email}</span>
            <span className="iniziali" aria-hidden="true">{iniziali}</span>
            <button
              onClick={() => { void getKeycloak().logout({ redirectUri: window.location.origin }) }}
              title="Sign out"
            >
              <LogOut size={14} style={{ verticalAlign: -2 }} aria-hidden="true" />
            </button>
          </span>
        </div>
      </header>

      <main>
      <div className="wrap">
        <h1>Tenants</h1>
      <p className="lede">
        Tenants of this installation. Renaming changes the display name only: the <em>slug</em> is the
        identity — the Keycloak realm, the subdomain and the tenant id of every node — and it cannot be
        changed. Deleting is two steps: suspend first, then delete.
      </p>

      {errore && <div className="errore" role="alert">{errore}</div>}

      {/* La password sta SOPRA tutto e resta finché non si conferma di averla
          presa: è l'unico posto in cui compare. */}
      {appenaCreato?.temporaryPassword && (
        <PasswordUnaVolta
          titolo={`“${appenaCreato.slug}” is ready — this password is shown once`}
          spiegazione={
            'Temporary password for the first administrator: they must change it at first sign-in. It is stored ' +
            'nowhere and cannot be shown again — if it is lost, use “Reset password” on that tenant\u2019s row.'
          }
          password={appenaCreato.temporaryPassword}
          onChiudi={() => setAppenaCreato(null)}
        />
      )}
      {passwordNuova && (
        <PasswordUnaVolta
          titolo={`New password for ${passwordNuova.email} — shown once`}
          spiegazione={
            'They must change it at first sign-in, and the previous password no longer works. It is stored ' +
            'nowhere and cannot be shown again.' +
            (passwordNuova.tenantSospeso ? ' The tenant is suspended: resume it before they can sign in.' : '')
          }
          password={passwordNuova.temporaryPassword}
          onChiudi={() => setPasswordNuova(null)}
        />
      )}

      {daReimpostare && (
        <RiquadroPassword
          t={daReimpostare}
          setErrore={setErrore}
          onAnnulla={() => setDaReimpostare(null)}
          onFatta={(esito) => {
            setDaReimpostare(null)
            setPasswordNuova(esito)
            setEsito(null)
          }}
        />
      )}

      <Creazione
        setErrore={setErrore}
        onCreato={(esito) => { setAppenaCreato(esito); setEsito(`“${esito.slug}” created.`); carica() }}
      />
      {esito && <div className="nota" role="status">{esito}</div>}

      {tenants === null ? (
        <p className="unknown">loading…</p>
      ) : tenants.length === 0 ? (
        <p className="unknown">No tenant in this installation.</p>
      ) : (
        <div className="scheda">
        <table>
          <thead>
            <tr>
              <th>Slug</th><th>Name</th><th>Plan</th><th>Addresses</th>
              <th style={{ textAlign: 'right' }}>Users</th>
              <th style={{ textAlign: 'right' }}>Tickets</th>
              <th>State</th><th style={{ textAlign: 'right' }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {tenants.map((t) => (
              <Riga
                key={t.id}
                t={t}
                occupato={occupato}
                onRename={(slug, nome) => azione(api.rename(slug, nome))}
                onSuspend={(slug) => azione(api.suspend(slug))}
                onResume={(slug) => azione(api.resume(slug))}
                onPassword={(tenant) => { setErrore(null); setPasswordNuova(null); setDaReimpostare(tenant) }}
                onPurge={(slug) => { setDaCancellare(slug); setEsito(null) }}
              />
            ))}
          </tbody>
        </table>
        </div>
      )}

      {daCancellare && (
        <RiquadroCancellazione
          slug={daCancellare}
          setErrore={setErrore}
          onAnnulla={() => setDaCancellare(null)}
          onFatto={(messaggio) => { setDaCancellare(null); setEsito(messaggio); carica() }}
        />
      )}

      <QueuesPanel />

      <IntegrityPanel />

      </div>
      </main>

      <footer>
        This console is not a tenant application: it has its own Keycloak realm, and nothing here is
        scoped to a customer.
      </footer>
    </>
  )
}
