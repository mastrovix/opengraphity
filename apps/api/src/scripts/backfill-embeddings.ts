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
import { getSession, runQuery, closeDriver } from '@opengraphity/neo4j'
import { getEmbedder, incidentEmbeddingText, kbEmbeddingText } from '../services/embeddings.js'
import { ensureVectorIndexes } from '../jobs/embeddingWorker.js'

const BATCH = 20

async function backfillLabel(label: 'Incident' | 'KBArticle'): Promise<number> {
  const embedder = getEmbedder()
  const model = `${embedder.provider}:${embedder.model}`
  let total = 0

  for (;;) {
    const session = getSession(undefined, 'WRITE')
    try {
      const rows = await runQuery<{ id: string; tenant_id: string; props: Record<string, unknown> }>(session, `
        MATCH (n:${label})
        WHERE n.embedding IS NULL OR n.embedding_model <> $model
        RETURN n.id AS id, n.tenant_id AS tenant_id, properties(n) AS props
        LIMIT ${BATCH}
      `, { model })
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
  const incidents = await backfillLabel('Incident')
  const articles = await backfillLabel('KBArticle')
  console.log(`[backfill] DONE — incidents: ${incidents}, kb articles: ${articles}`)
}

main()
  .then(() => closeDriver())
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    console.error('[backfill] FAILED:', err)
    process.exit(1)
  })
