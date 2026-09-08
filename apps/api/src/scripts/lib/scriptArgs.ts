/**
 * Argomenti e guardie condivise per gli script operativi (apps/api/src/scripts).
 *
 * Funzioni pure (argv/env iniettabili per i test) che FALLISCONO con un errore
 * esplicito invece di ripiegare su default silenziosi: niente tenant cablato,
 * niente cancellazioni senza conferma, niente seed/purge in produzione.
 *
 * Uso tipico, all'inizio di main():
 *   refuseInProduction('seed-demo-incidents')
 *   const tenantId = resolveTenantArg()
 *   requireConfirmFlag('--yes-delete')
 */

export class ScriptArgError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ScriptArgError'
  }
}

const TENANT_SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/

function defaultArgv(): readonly string[] {
  return process.argv.slice(2)
}

/** True se `flagName` (es. `--yes-delete`) compare come token esatto in argv. */
export function hasFlag(flagName: string, argv: readonly string[] = defaultArgv()): boolean {
  return argv.includes(flagName)
}

/**
 * Legge il valore di un'opzione nelle forme `--name=value` e `--name value`.
 * Ritorna undefined se assente. Un valore che inizia con `--` non è accettato
 * come valore (è un'altra opzione).
 */
export function readOptionValue(name: string, argv: readonly string[] = defaultArgv()): string | undefined {
  const prefix = `${name}=`
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i]!
    if (tok.startsWith(prefix)) return tok.slice(prefix.length)
    if (tok === name) {
      const next = argv[i + 1]
      if (next === undefined || next.startsWith('--')) return undefined
      return next
    }
  }
  return undefined
}

/**
 * Tenant obbligatorio da `--tenant=<slug>` o `--tenant <slug>`.
 * Fallisce (ScriptArgError) se assente, vuoto o con caratteri non ammessi.
 */
export function resolveTenantArg(argv: readonly string[] = defaultArgv()): string {
  const raw = readOptionValue('--tenant', argv)
  if (raw === undefined || raw.trim() === '') {
    throw new ScriptArgError('Tenant mancante: passare --tenant=<slug> (es. --tenant=c-one). Nessun default.')
  }
  const slug = raw.trim()
  if (!TENANT_SLUG_RE.test(slug)) {
    throw new ScriptArgError(`Tenant non valido "${slug}": ammessi solo lettere, cifre, "-" e "_".`)
  }
  return slug
}

/**
 * Richiede un flag di conferma esplicito (es. `--yes-delete`) per le
 * operazioni distruttive. Fallisce (ScriptArgError) se assente.
 */
export function requireConfirmFlag(flagName: string, argv: readonly string[] = defaultArgv()): void {
  if (!flagName.startsWith('--')) {
    throw new ScriptArgError(`Flag di conferma non valido "${flagName}": deve iniziare con "--".`)
  }
  if (!hasFlag(flagName, argv)) {
    throw new ScriptArgError(`Operazione distruttiva: rilanciare con ${flagName} per confermare.`)
  }
}

/**
 * Rifiuta l'esecuzione quando NODE_ENV === 'production'.
 * `what` descrive l'operazione, per un messaggio d'errore leggibile.
 */
export function refuseInProduction(what: string, env: Readonly<Record<string, string | undefined>> = process.env): void {
  if (env['NODE_ENV'] === 'production') {
    throw new ScriptArgError(`${what}: rifiutato con NODE_ENV=production (script di seed/purge non ammesso in produzione).`)
  }
}
