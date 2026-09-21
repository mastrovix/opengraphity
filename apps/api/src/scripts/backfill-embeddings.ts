/**
 * Backfill embeddings for every Incident and KBArticle that has none, or whose
 * embedding was computed by a different provider/model than the current one.
 *
 * Run inside the api container (or locally with env pointed at the stack):
 *   node dist/scripts/backfill-embeddings.js
 *
 * Fail-fast: any provider or DB error aborts with exit 1 — a partial backfill
 * must not be reported as success. Progress is logged per batch.
 */
import { aiFeatureEnabled } from '../lib/aiSettings.js'
import { getSession, runQuery } from '@opengraphity/neo4j'
import { getEmbedder, incidentEmbeddingText, kbEmbeddingText } from '../services/embeddings.js'
import { ensureVectorIndexes } from '../jobs/embeddingWorker.js'
import { runScript } from './lib/runScript.js'

const BATCH = 20

async function backfillLabel(label: 'Incident' | 'KBArticle', tenantsOff: readonly string[]): Promise<number> {
  const embedder = getEmbedder()
  const model = `${embedder.provider}:${embedder.model}`
  let total = 0

  for (;;) {
    const session = getSession(undefined, 'WRITE')
    try {
      const rows = await runQuery<{ id: string; tenant_id: string; props: Record<string, unknown> }>(session, `
        MATCH (n:${label})
        WHERE (n.embedding IS NULL OR n.embedding_model <> $model)
          AND NOT n.tenant_id IN $tenantsOff
        RETURN n.id AS id, n.tenant_id AS tenant_id, properties(n) AS props
        LIMIT ${BATCH}
      `, { model, tenantsOff })
      if (rows.length === 0) return total

      const texts = rows.map((r) =>
        label === 'Incident' ? incidentEmbeddingText(r.props) : kbEmbeddingText(r.props),
      )
      const empty = texts.findIndex((t) => !t)
      if (empty >= 0) throw new Error(`${label} ${rows[empty].id} has no embeddable text`)

      const vectors = await embedder.embed(texts)

      const now = new Date().toISOString()
      for (let i = 0; i < rows.length; i++) {
        await session.executeWrite((tx) => tx.run(`
          MATCH (n:${label} {id: $id, tenant_id: $tenantId})
          CALL db.create.setNodeVectorProperty(n, 'embedding', $vector)
          SET n.embedding_model = $model, n.embedded_at = $now
        `, { id: rows[i].id, tenantId: rows[i].tenant_id, vector: vectors[i], model, now }))
      }
      total += rows.length
      console.log(`[backfill] ${label}: ${total} embedded so far`)
    } finally {
      await session.close()
    }
  }
}

async function main(): Promise<void> {
  const embedder = getEmbedder()
  console.log(`[backfill] provider=${embedder.provider} model=${embedder.model} dims=${embedder.dimensions}`)
  await ensureVectorIndexes()
  // Le organizzazioni che hanno spento gli embedding (ondata 6): i loro testi non vanno al provider.
  const session = getSession(undefined, 'READ')
  let tenantIds: string[]
  try {
    tenantIds = (await runQuery<{ id: string }>(session, "MATCH (t:Tenant) WHERE t.id <> 'system' RETURN t.id AS id", {})).map((r) => r.id)
  } finally {
    await session.close()
  }
  const tenantsOff: string[] = []
  for (const id of tenantIds) if (!(await aiFeatureEnabled(id, 'embeddings'))) tenantsOff.push(id)
  if (tenantsOff.length) console.log(`[backfill] embeddings turned off, skipped: ${tenantsOff.join(', ')}`)
  const incidents = await backfillLabel('Incident', tenantsOff)
  const articles = await backfillLabel('KBArticle', tenantsOff)
  console.log(`[backfill] DONE — incidents: ${incidents}, kb articles: ${articles}`)
}

// H-45: il runner uniforme chiude il driver e mette l'exit code; il
// `process.exit(0)` finale troncava i log asincroni dell'ultima riga.
runScript('backfill-embeddings', main)
