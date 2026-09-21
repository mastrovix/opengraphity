/**
 * OGNI AZIONE DEL REGISTRO HA UNA CASA (20 set 2026).
 *
 * Il guardiano dell'ondata 2. Legge le ~186 azioni che il prodotto conosce —
 * le stesse che `auditActions.test.ts` del web pretende tradotte — e pretende
 * che ciascuna si normalizzi in oggetto + verbo.
 *
 * Perché è un test e non una buona intenzione: senza, una `audit(ctx,
 * 'qualcosa_di_nuovo', …)` scritta domani non farebbe fallire niente. Le
 * query degli aggregati continuerebbero a girare, quella voce sparirebbe dai
 * conteggi, e l'analista del lavoro quotidiano proporrebbe cose fondate su
 * dati con un buco che nessuno vede.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { normalizeAuditAction, actionKey, isGenericMutationAction } from '../auditActionMap.js'
import { isHumanActor, SYNTHETIC_ACTORS, syntheticActorIds, humanActorClause } from '../auditActors.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..')

/** Le azioni conosciute: le chiavi che il prodotto traduce nell'Audit Log. */
function azioniConosciute(): string[] {
  const locale = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'apps/web/src/i18n/locales/it.json'), 'utf8'),
  ) as { audit: { action: Record<string, string> } }
  return Object.keys(locale.audit.action)
}

describe('la normalizzazione delle azioni', () => {
  it('OGNI azione conosciuta si normalizza: nessuna resta senza casa', () => {
    const senzaCasa = azioniConosciute().filter((a) => normalizeAuditAction(a) === null)
    expect(senzaCasa, `azioni che la regola non sa leggere: ${senzaCasa.join(', ')}`).toEqual([])
  })

  it('la regola legge la convenzione col punto', () => {
    expect(normalizeAuditAction('incident.assigned')).toEqual({ object: 'incident', verb: 'assigned' })
  })

  it('con più punti, l\'oggetto è tutto ciò che precede l\'ultimo', () => {
    expect(normalizeAuditAction('tenant.ai_settings.updated'))
      .toEqual({ object: 'tenant.ai_settings', verb: 'updated' })
  })

  it('le eccezioni storiche hanno il loro posto, e NON si inventano', () => {
    // Sono i nomi anteriori alla convenzione: il registro non si riscrive.
    expect(normalizeAuditAction('change_created')).toEqual({ object: 'change', verb: 'created' })
    expect(normalizeAuditAction('change_transition')).toEqual({ object: 'change', verb: 'transitioned' })
    expect(normalizeAuditAction('whatif_analysis')).toEqual({ object: 'what_if', verb: 'analysed' })
  })

  it('`change_created` e `change.created` diventano la STESSA chiave', () => {
    // È il punto di tutta la normalizzazione: senza, la stessa operazione
    // conta due volte sotto due nomi.
    expect(actionKey('change_created')).toBe(actionKey('change.created'))
  })

  it('le voci generiche si riconoscono, perché sono di seconda qualità', () => {
    expect(isGenericMutationAction('mutation.createIncident')).toBe(true)
    expect(isGenericMutationAction('incident.created')).toBe(false)
    expect(normalizeAuditAction('mutation.createIncident'))
      .toEqual({ object: 'mutation', verb: 'createIncident' })
  })

  it('quello che non sa leggere torna null, NON un ripiego', () => {
    expect(normalizeAuditAction('')).toBeNull()
    expect(normalizeAuditAction('   ')).toBeNull()
    expect(normalizeAuditAction('senzapunto')).toBeNull()
    expect(normalizeAuditAction('.iniziaPunto')).toBeNull()
    expect(normalizeAuditAction('finiscePunto.')).toBeNull()
  })
})

describe('chi è una persona e chi no', () => {
  it('gli attori sintetici del prodotto non sono persone', () => {
    for (const id of syntheticActorIds()) {
      expect(isHumanActor(id), id).toBe(false)
    }
  })

  it('i quattro che pesano davvero sono nella lista', () => {
    // Letti sul grafo il 20 set 2026: monitoring 1.051 voci, e2e 148,
    // automation 35, system. Senza, l'analista propone di automatizzare
    // quello che è già automatico.
    for (const id of ['monitoring', 'e2e', 'automation', 'system']) {
      expect(SYNTHETIC_ACTORS, id).toHaveProperty(id)
    }
  })

  it('un UUID è una persona', () => {
    expect(isHumanActor('b59f468b-7085-47d2-a9e3-2ef5b281b656')).toBe(true)
  })

  it('vuoto e assente NON sono persone: contarli sarebbe peggio che ignorarli', () => {
    expect(isHumanActor(null)).toBe(false)
    expect(isHumanActor(undefined)).toBe(false)
    expect(isHumanActor('')).toBe(false)
    expect(isHumanActor('   ')).toBe(false)
  })

  it('ogni attore sintetico dice CHI lo scrive: senza, fra un anno non si sa se togliere la voce', () => {
    for (const [id, dove] of Object.entries(SYNTHETIC_ACTORS)) {
      expect(dove, id).toMatch(/\.ts|packages\/|e2e|scripts/)
    }
  })

  it('la clausola Cypher esclude i sintetici, il vuoto e il nullo', () => {
    const c = humanActorClause('a')
    expect(c).toContain('a.user_id IS NOT NULL')
    expect(c).toContain("a.user_id <> ''")
    expect(c).toContain('NOT a.user_id IN $__attoriSintetici')
  })
})
