import { getSession, closeDriver } from '@opengraphity/neo4j'
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
      { label: 'No', score: 0 },
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
      { label: 'No', score: 0 },
    ],
  },
  {
    text: 'Is a tested rollback plan available?',
    category: 'technical', weight: 5,
    options: [
      { label: 'Yes', score: 0 },
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
      { label: 'No', score: 0 },
    ],
  },
  {
    text: 'Are there downstream dependencies?',
    category: 'technical', weight: 3,
    options: [
      { label: 'Many', score: 3 },
      { label: 'Few', score: 1 },
      { label: 'None', score: 0 },
    ],
  },
  {
    text: 'Complexity of the implementation?',
    category: 'technical', weight: 3,
    options: [
      { label: 'High', score: 3 },
      { label: 'Medium', score: 2 },
      { label: 'Low', score: 0 },
    ],
  },
]

async function main() {
  const tenantId = process.env['TENANT_ID'] ?? 'opengraphity'
  const session = getSession(undefined, 'WRITE')
  try {
    const now = new Date().toISOString()
    let sortCounter = 0
    let created = 0
    for (const q of QUESTIONS) {
      const sortOrder = sortCounter++

      // Idempotent: match-or-create by (tenant, text)
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
            id: randomUUID(), label: opt.label, score: opt.score, sort_order: opt.idx
          })
          CREATE (q)-[:HAS_OPTION]->(o)
        `, {
          qid, tenantId, text: q.text, category: q.category, now,
          options: q.options.map((o, idx) => ({ label: o.label, score: o.score, idx })),
        }))
        created++
      }

      // Always ensure HAS_QUESTION rel from all active base CITypeDefinitions
      await session.executeWrite((tx) => tx.run(`
        MATCH (q:AssessmentQuestion {id: $qid, tenant_id: $tenantId})
        MATCH (ct:CITypeDefinition {active: true, scope: 'base'})
        MERGE (ct)-[rel:HAS_QUESTION]->(q)
          ON CREATE SET rel.weight = $weight, rel.sort_order = $sortOrder
          ON MATCH  SET rel.weight = $weight, rel.sort_order = $sortOrder
      `, { qid, tenantId, weight: q.weight, sortOrder }))
    }
    console.log(`[seed] ${created} new + ${QUESTIONS.length - created} existing assessment questions for tenant ${tenantId}. Relations refreshed.`)
  } finally {
    await session.close()
    await closeDriver()
  }
}

main().catch((err) => {
  console.error('[seed-assessment-questions] error:', err)
  process.exit(1)
})
