/**
 * OGNI AZIONE CHE IL REGISTRO SCRIVE HA UNA FRASE (20 set 2026).
 *
 * L'Audit Log mostrava il nome tecnico dell'azione (`enum_type.value_renamed`);
 * ora mostra una frase, e la frase sta nei locale. Il rischio evidente è che
 * una `audit(ctx, 'qualcosa.di_nuovo', …)` aggiunta domani nell'API resti
 * senza traduzione: nessuno se ne accorgerebbe finché un amministratore non
 * apre la pagina e legge di nuovo un identificatore.
 *
 * Questo test legge le sorgenti dell'API e dei pacchetti, raccoglie le azioni
 * scritte come LETTERALI, e pretende la chiave nelle due lingue. Le azioni
 * composte a runtime (`report.export_${format}`, `<entità>.step_entered`)
 * questo controllo non le vede: stanno nella lista `COMPOSTE`, scritta a mano
 * e con accanto il file che le compone — se una si aggiunge, la si aggiunge
 * anche lì.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
// `it` è già il nome del test di vitest: i locale entrano con un altro nome.
import italiano from '@/i18n/locales/it.json'
import inglese from '@/i18n/locales/en.json'
import { auditActionLabel } from '@/lib/auditActionText'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')

function sorgenti(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out
  for (const voce of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, voce.name)
    if (voce.isDirectory()) {
      if (voce.name === 'node_modules' || voce.name === 'dist' || voce.name === '__tests__') continue
      sorgenti(p, out)
    } else if (voce.name.endsWith('.ts') && !voce.name.endsWith('.test.ts')) out.push(p)
  }
  return out
}

/** `audit(<qualunque contesto>, 'azione'` — il secondo argomento letterale. */
const RE_AUDIT = /\baudit\(\s*(?:[^,()]|\([^()]*\)|\{[^{}]*\})*?,\s*'([a-zA-Z0-9_.]+)'/g

function azioniScritteDallApi(): string[] {
  const file = [
    ...sorgenti(path.join(ROOT, 'apps/api/src')),
    ...fs.readdirSync(path.join(ROOT, 'packages'))
      .flatMap((d) => sorgenti(path.join(ROOT, 'packages', d, 'src'))),
  ]
  const trovate = new Set<string>()
  for (const f of file) {
    for (const m of fs.readFileSync(f, 'utf8').matchAll(RE_AUDIT)) trovate.add(m[1]!)
  }
  return [...trovate].sort()
}

/**
 * Le azioni che l'API compone a runtime, con dove si compongono. Non si
 * possono leggere dal sorgente: si tengono qui.
 */
const COMPOSTE: readonly string[] = [
  // lib/stepEvent.ts — `stepEnteredEventType(entityType)`
  'incident.step_entered', 'problem.step_entered', 'change.step_entered', 'service_request.step_entered',
  // lib/stepDeadlines.ts
  'workflow.step_deadline_moved',
  // graphql/resolvers/reportExport.ts — `report.export_${format}`
  'report.export_pdf', 'report.export_xlsx',
  // graphql/resolvers/incident.ts — major sì/no
  'incident.major_declared', 'incident.major_cleared',
  // graphql/resolvers/problem.ts, team.ts, workflowMutations.ts
  'problem.assigned_user', 'problem.unassigned_user',
  'team.member_added', 'team.member_removed',
  'workflow.activated', 'workflow.deactivated',
  // lib/automationEngine.ts — `spec.auditAction`
  'trigger.executed', 'business_rule.executed',
  // services/events/autoResolve.ts — `event.${outcome}`
  'event.auto_resolved', 'event.auto_resolve_skipped',
  // services/serviceImpact/engine.ts
  'service.health_changed',
]

/** Non è del prodotto: la scrive solo il test del plugin del registro unico. */
const SOLO_NEI_TEST = new Set(['thing.done'])

const frasi = (locale: typeof italiano) => (locale as unknown as { audit: { action: Record<string, string> } }).audit.action

describe("le azioni dell'Audit Log si leggono", () => {
  it('ogni azione scritta dall\'API ha la frase in italiano e in inglese', () => {
    const senzaFrase = [...azioniScritteDallApi(), ...COMPOSTE]
      .filter((a) => !SOLO_NEI_TEST.has(a))
      .filter((a) => !a.endsWith('.step_entered')) // una frase sola per tutte
      .filter((a) => !(a in frasi(italiano)) || !(a in frasi(inglese)))
    expect(senzaFrase).toEqual([])
  })

  it('le due lingue portano le stesse azioni', () => {
    expect(Object.keys(frasi(italiano)).sort()).toEqual(Object.keys(frasi(inglese)).sort())
  })

  /**
   * La frase italiana identica all'inglese è quasi sempre una traduzione
   * dimenticata (è la regola di `check-i18n`, qui applicata a queste chiavi).
   */
  it('nessuna frase è rimasta in inglese anche in italiano', () => {
    const uguali = Object.keys(frasi(italiano)).filter((k) => frasi(italiano)[k] === frasi(inglese)[k])
    expect(uguali).toEqual([])
  })

  const t = ((k: string, p?: Record<string, unknown>) =>
    (frasi(italiano)[k.replace('audit.action.', '')] ?? k).replace('{{entity}}', String(p?.['entity'] ?? ''))) as (k: string, p?: Record<string, unknown>) => string
  const exists = (k: string) => k.replace('audit.action.', '') in frasi(italiano)

  it('una `mutation.*` resta col suo nome tecnico: lì il nome È l\'informazione', () => {
    expect(auditActionLabel('mutation.deleteSLAPolicy', { t, exists })).toBe('mutation.deleteSLAPolicy')
  })

  it('un\'azione che questo bundle non conosce si legge grezza, non sparisce', () => {
    expect(auditActionLabel('azione.del_futuro', { t, exists })).toBe('azione.del_futuro')
  })

  it('una transizione porta il nome che il CLIENTE ha dato al tipo', () => {
    const label = auditActionLabel('incident.step_entered', {
      t, exists, labelOf: (e) => (e === 'incident' ? 'Segnalazione' : e),
    })
    expect(label).toBe('Segnalazione: entrato in un passo')
  })
})
