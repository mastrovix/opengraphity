/**
 * L'id del modello Claude vive in UN posto solo: `config.anthropicModel`
 * (variabile `ANTHROPIC_MODEL`, con `REPORT_AI_MODEL` come scavalco del solo
 * agente dei report).
 *
 * Prima era copiato a mano in cinque punti — triage, assistente, tre chiamate
 * del post-incident, più il default dell'agente dei report — e uno di loro
 * dichiarava, falso, di usare «la stessa costante degli altri». Risultato: un
 * aggiornamento del modello ne lasciava indietro quattro.
 *
 * Questo è un lint statico come `tenantScoping.test.ts` e `failFast.test.ts`:
 * legge i sorgenti, non esegue nulla.
 */
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { config } from '../config.js'

const SRC = fileURLToPath(new URL('../..', import.meta.url))

/** Un id di modello Claude scritto in chiaro: `claude-<qualcosa>`. */
const MODEL_LITERAL = /['"]claude-[a-z0-9][a-z0-9-]*['"]/g

/** Dove l'id PUÒ comparire: la configurazione lo definisce, il suo test lo verifica. */
const ALLOWED = new Set([
  join(SRC, 'lib', 'config.ts'),
  join(SRC, 'lib', '__tests__', 'config.test.ts'),
  join(SRC, 'lib', '__tests__', 'aiModel.test.ts'),
  // Pinna lo scavalco `REPORT_AI_MODEL` con un id finto: è il suo mestiere.
  join(SRC, 'services', '__tests__', 'reportAgent.test.ts'),
])

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) { walk(full, out); continue }
    if (full.endsWith('.ts') || full.endsWith('.tsx')) out.push(full)
  }
  return out
}

describe('id del modello AI', () => {
  it('compare solo nella configurazione, mai copiato nei servizi', () => {
    const offenders: string[] = []
    for (const file of walk(SRC)) {
      if (ALLOWED.has(file)) continue
      const hits = readFileSync(file, 'utf8').match(MODEL_LITERAL)
      if (hits) offenders.push(`${file.slice(SRC.length)}: ${[...new Set(hits)].join(', ')}`)
    }
    expect(offenders, 'usa config.anthropicModel invece di scrivere l\'id del modello').toEqual([])
  })

  it('il default è un modello della famiglia Claude 5', () => {
    expect(config.anthropicModel).toBe('claude-opus-5')
  })
})
