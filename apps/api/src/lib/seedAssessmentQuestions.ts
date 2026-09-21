/**
 * LE DOMANDE DI ASSESSMENT DI UN TENANT NUOVO (17 set 2026).
 *
 * Questa logica viveva SOLO in `scripts/seed-assessment-questions.ts`, e
 * `provisionTenantData` non la chiamava: un tenant appena creato nasceva con
 * ZERO domande, quindi nessuna change poteva superare l'analisi — e
 * l'onboarding finiva con «provisioned only in part … run it again», che non
 * risolveva niente perché rilanciare non semina le domande.
 *
 * Visto dal vivo creando `prova-cons` col nuovo modulo condiviso: lo script
 * faceva tutto — realm, client, admin, sei workflow — e poi si dichiarava
 * fallito. La regola del progetto è che un tenant nasce in UN modo solo (D-14),
 * e questo seme ne era fuori.
 *
 * Idempotente come prima: le domande si riconoscono per (tenant, testo), e le
 * relazioni coi tipi di CI si riallineano a ogni giro — anche ai tipi che il
 * cliente ha aggiunto, perché «core» vuol dire tutti i tipi attivi.
 */
import type { Session } from 'neo4j-driver'
import { v4 as uuidv4 } from 'uuid'

type OptionSeed = { label: string; score: number }
type QuestionSeed = {
  text: string
  category: 'functional' | 'technical'
  weight: number
  options: OptionSeed[]
}

const QUESTIONS: QuestionSeed[] = [
  // NOTE: "Is the production environment affected?" è stato rimosso e
  // sostituito da un fattore automatico calcolato in completeAssessmentTask
  // sulla base del campo ci.environment (production/staging/altro → weight 5, score 3/1/0).
  {
    text: 'Does the change impact PII or sensitive data?',
    category: 'functional', weight: 4,
    options: [
      { label: 'Yes', score: 3 },
      { label: 'No', score: 1 },
    ],
  },
  {
    text: 'How many end users are affected?',
    category: 'functional', weight: 3,
    options: [
      { label: '> 1000', score: 3 },
      { label: '100 - 1000', score: 2 },
      { label: '< 100', score: 1 },
    ],
  },
  {
    text: 'Is there a business-critical SLA at risk?',
    category: 'functional', weight: 4,
    options: [
      { label: 'Yes', score: 3 },
      { label: 'Partial', score: 2 },
      { label: 'No', score: 1 },
    ],
  },
  {
    text: 'Is a tested rollback plan available?',
    category: 'technical', weight: 5,
    options: [
      { label: 'Yes', score: 1 },
      { label: 'Partial', score: 2 },
      { label: 'No', score: 3 },
    ],
  },
  {
    text: 'Does the change require downtime?',
    category: 'technical', weight: 4,
    options: [
      { label: 'Yes', score: 3 },
      { label: 'Partial / degraded', score: 2 },
      { label: 'No', score: 1 },
    ],
  },
  {
    text: 'Are there downstream dependencies?',
    category: 'technical', weight: 3,
    options: [
      { label: 'Many', score: 3 },
      { label: 'Few', score: 1 },
      { label: 'None', score: 1 },
    ],
  },
  {
    text: 'Complexity of the implementation?',
    category: 'technical', weight: 3,
    options: [
      { label: 'High', score: 3 },
      { label: 'Medium', score: 2 },
      { label: 'Low', score: 1 },
    ],
  },
]

export interface AssessmentQuestionsSeedResult {
  created:  number
  existing: number
}

export async function seedAssessmentQuestions(
  session: Session,
  tenantId: string,
): Promise<AssessmentQuestionsSeedResult> {
  const now = new Date().toISOString()
  let sortCounter = 0
  let created = 0

  for (const q of QUESTIONS) {
    const sortOrder = sortCounter++

    const existing = await session.executeRead((tx) => tx.run(`
      MATCH (q:AssessmentQuestion {tenant_id: $tenantId, text: $text})
      RETURN q.id AS id LIMIT 1
    `, { tenantId, text: q.text }))
    let qid = existing.records[0]?.get('id') as string | undefined

    if (!qid) {
      qid = uuidv4()
      await session.executeWrite((tx) => tx.run(`
        CREATE (q:AssessmentQuestion {
          id: $qid, tenant_id: $tenantId, text: $text, category: $category,
          is_core: true, is_active: true, created_at: $now
        })
        WITH q
        UNWIND $options AS opt
        CREATE (o:AnswerOption {
          id: randomUUID(), tenant_id: $tenantId, label: opt.label, score: opt.score, sort_order: opt.idx
        })
        CREATE (q)-[:HAS_OPTION]->(o)
      `, {
        qid, tenantId, text: q.text, category: q.category, now,
        options: q.options.map((o, idx) => ({ label: o.label, score: o.score, idx })),
      }))
      created++
    }

    // Le relazioni si riallineano SEMPRE, anche per una domanda già esistente:
    // un tipo di CI aggiunto dal cliente dopo deve ereditare le domande core,
    // altrimenti i suoi assessment nascono vuoti.
    await session.executeWrite((tx) => tx.run(`
      MATCH (q:AssessmentQuestion {id: $qid, tenant_id: $tenantId})
      MATCH (ct:CITypeDefinition)
      WHERE (ct.scope = 'base' OR (ct.scope = 'tenant' AND ct.tenant_id = $tenantId))
        AND ct.active = true AND ct.name <> '__base__'
      MERGE (ct)-[rel:HAS_QUESTION]->(q)
        ON CREATE SET rel.weight = $weight, rel.sort_order = $sortOrder
        ON MATCH  SET rel.weight = $weight, rel.sort_order = $sortOrder
    `, { qid, tenantId, weight: q.weight, sortOrder }))
  }

  return { created, existing: QUESTIONS.length - created }
}
