/**
 * Gestione password per gli script che creano utenti (add-user, onboard-tenant).
 *
 * Regole:
 *  - la password NON passa MAI da argv (`--password X` finisce in `ps`, shell
 *    history, log CI): la sua presenza è un errore esplicito;
 *  - `--password-stdin` legge la password da stdin (`printf 'pwd' | script …`);
 *  - senza flag viene generata una password casuale, impostata in Keycloak
 *    come `temporary: true` (cambio obbligatorio al primo login) e stampata
 *    UNA sola volta con avviso; i riepiloghi non la ripetono.
 */

import { randomBytes } from 'node:crypto'
import { ScriptArgError, hasFlag } from './scriptArgs.js'

export const PASSWORD_STDIN_FLAG = '--password-stdin'

/** Opzioni argv che trasporterebbero una password in chiaro: vietate. */
export const FORBIDDEN_PASSWORD_ARGS = ['--password', '--admin-password'] as const

export interface ResolvedPassword {
  value:     string
  source:    'stdin' | 'generated'
  /** Da passare a Keycloak: true solo per le password generate. */
  temporary: boolean
}

/** Fallisce se argv contiene `--password …` / `--password=…` (o la variante admin). */
export function assertNoPasswordInArgv(argv: readonly string[] = process.argv.slice(2)): void {
  for (const flag of FORBIDDEN_PASSWORD_ARGS) {
    if (argv.some(tok => tok === flag || tok.startsWith(`${flag}=`))) {
      throw new ScriptArgError(
        `${flag} non è ammesso (la password resterebbe in shell history/ps/log). ` +
        `Usare ${PASSWORD_STDIN_FLAG} (es. printf '%s' "$PWD" | … ${PASSWORD_STDIN_FLAG}) ` +
        `oppure omettere il flag per una password temporanea generata.`,
      )
    }
  }
}

/** 18 byte casuali in base64url → 24 caratteri, ~144 bit di entropia. */
export function generateTemporaryPassword(bytes = 18): string {
  return randomBytes(bytes).toString('base64url')
}

/** Legge tutta stdin; rimuove SOLO il newline finale. Vuota → errore. */
export async function readPasswordFromStdin(stream: NodeJS.ReadableStream = process.stdin): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of stream) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk)
  }
  const raw = Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '')
  if (raw === '') {
    throw new ScriptArgError(`${PASSWORD_STDIN_FLAG}: nessuna password letta da stdin`)
  }
  return raw
}

export async function resolvePassword(
  argv:  readonly string[] = process.argv.slice(2),
  stdin: NodeJS.ReadableStream = process.stdin,
): Promise<ResolvedPassword> {
  assertNoPasswordInArgv(argv)
  if (hasFlag(PASSWORD_STDIN_FLAG, argv)) {
    return { value: await readPasswordFromStdin(stdin), source: 'stdin', temporary: false }
  }
  return { value: generateTemporaryPassword(), source: 'generated', temporary: true }
}

/**
 * Stampa la password generata UNA volta, con avviso. Non chiamare per le
 * password fornite via stdin (l'operatore le conosce già).
 */
export function printOneTimePassword(label: string, resolved: ResolvedPassword, out: (line: string) => void = console.log): void {
  if (resolved.source !== 'generated') return
  out('')
  out('  ┌──────────────────────────────────────────────────────────────┐')
  out(`  │  PASSWORD TEMPORANEA per ${label}`)
  out(`  │  ${resolved.value}`)
  out('  │  Mostrata SOLO ora: non viene salvata né ripetuta. Keycloak   │')
  out('  │  richiede il cambio al primo login.                          │')
  out('  └──────────────────────────────────────────────────────────────┘')
  out('')
}
