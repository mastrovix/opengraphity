/**
 * Genera un JWT HS256 di sviluppo (24h) per Apollo Sandbox / curl.
 * Il path HS256 è accettato dall'API solo fuori produzione (context.ts).
 *
 * Uso:
 *   JWT_SECRET=… pnpm --filter @opengraphity/api gen-token -- \
 *     --tenant=c-one --user-id=user-001 --email=admin@demo.opengraphity.io --role=admin
 *
 * Nessun default per tenant/utente: un token "di comodo" emesso per il tenant
 * sbagliato è esattamente il tipo di errore silenzioso da evitare.
 */
import jwt from 'jsonwebtoken'
import { requireEnv } from '../lib/env.js'
import { ScriptArgError, readOptionValue, resolveTenantArg } from './lib/scriptArgs.js'

function requireOption(name: string): string {
  const v = readOptionValue(name)
  if (v === undefined || v.trim() === '') throw new ScriptArgError(`Opzione mancante: ${name}=<valore>`)
  return v.trim()
}

try {
  const JWT_SECRET = requireEnv('JWT_SECRET')
  const payload = {
    tenant_id: resolveTenantArg(),
    user_id:   requireOption('--user-id'),
    email:     requireOption('--email'),
    role:      requireOption('--role'),
  }

  const token = jwt.sign(payload, JWT_SECRET, { expiresIn: '24h' })

  console.log('\n=== Dev JWT Token ===')
  console.log(token)
  console.log('\n=== Authorization Header ===')
  console.log(`Authorization: Bearer ${token}`)
  console.log('\n=== Apollo Sandbox Header (JSON) ===')
  console.log(JSON.stringify({ Authorization: `Bearer ${token}` }, null, 2))
} catch (err) {
  console.error(`✖ gen-token: ${err instanceof Error ? err.message : String(err)}`)
  process.exitCode = 1
}
