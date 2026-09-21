/**
 * Runs the anomaly scanner once, directly (no BullMQ queue).
 * Usage: pnpm --filter @opengraphity/api scan:anomalies -- --tenant=<slug>
 *
 * Usa lo stesso `scanTenant` del job, con la configurazione delle regole del
 * cliente (ondata 5 di «Nulla cablato»): prima questo script ripeteva le query
 * e la scrittura per conto suo, e lo scan a mano e quello del job potevano dare
 * risultati diversi. Una regola la cui query fallisce fa fallire lo scan.
 */
import { scanTenant } from '../anomaly/anomalyEngine.js'
import { resolveTenantArg } from './lib/scriptArgs.js'
import { runScript } from './lib/runScript.js'

async function main(): Promise<void> {
  const TENANT = resolveTenantArg()
  console.log(`\n=== Anomaly Scanner — tenant ${TENANT} — ${new Date().toISOString()} ===\n`)

  const summary = await scanTenant(TENANT)
  for (const r of summary.rules) {
    if (r.disabled)   console.log(`– ${r.ruleKey.padEnd(30)} disabled`)
    else if (r.error) console.log(`! ${r.ruleKey.padEnd(30)} FAILED — ${r.error}`)
    else              console.log(`${r.hits ? '✗' : '✓'} ${r.title.padEnd(30)} ${String(r.hits)} anomalies (${String(r.created)} new)`)
  }
  const grand = summary.rules.reduce((a, r) => a + r.hits, 0)
  console.log(`\n${'─'.repeat(50)}\nTotal anomalies detected: ${String(grand)}`)
  if (summary.ruleFailures > 0) throw new Error(`${String(summary.ruleFailures)} rule(s) failed`)
}

runScript('run-anomaly-scan', main)
