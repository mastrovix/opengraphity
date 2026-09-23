/**
 * THE EMBEDDINGS OF THE TENANT (tour of 23 Sep 2026, D15 — the owner's
 * choice: computed with the local model).
 *
 * Not one of the 50,000 incidents had an embedding: «Similar incidents» said
 * «Analysis under way…» for ever, the AI triage found no similar history, and
 * «Problem candidates» found no cluster. In a tenant that has been running,
 * the embedding worker computed each vector a few seconds after the incident
 * or the article was written. Here the same provider (`getEmbedder`, the local
 * multilingual MiniLM by default), the same texts (`incidentEmbeddingText`,
 * `kbEmbeddingText`) and the same write (`db.create.setNodeVectorProperty`)
 * as the worker, in batches, for what this run wrote. An organization that
 * turned embeddings off is left without them — the product would not send
 * its texts to the provider either.
 */
import type { Session } from 'neo4j-driver'
import { runQuery } from '@opengraphity/neo4j'
import { aiFeatureEnabled } from '../../aiSettings.js'
import { getEmbedder, incidentEmbeddingText, kbEmbeddingText } from '../../../services/embeddings.js'
import { ensureVectorIndexes } from '../../../jobs/embeddingWorker.js'

const BATCH = 256

async function embedLabel(session: Session, tenantId: string, runId: string, label: 'Incident' | 'KBArticle', log: (m: string) => void): Promise<number> {
  const embedder = getEmbedder()
  const model = `${embedder.provider}:${embedder.model}`
  let after = ''
  let total = 0
  for (;;) {
    const rows = await runQuery<{ id: string; props: Record<string, unknown> }>(session, `
      MATCH (n:${label} {tenant_id: $tenantId})
      WHERE n.demo_run_id = $runId AND n.id > $after
      RETURN n.id AS id, properties(n) AS props
      ORDER BY n.id
      LIMIT toInteger($batch)`, { tenantId, runId, after, batch: BATCH })
    if (rows.length === 0) return total
    const texts = rows.map((r) => (label === 'Incident' ? incidentEmbeddingText(r.props) : kbEmbeddingText(r.props)))
    const empty = texts.findIndex((t) => !t)
    if (empty >= 0) throw new Error(`${label} ${rows[empty]!.id} has no embeddable text`)
    const vectors = await embedder.embed(texts)
    // The worker computed it seconds after the thing was written.
    const data = rows.map((r, i) => ({
      id: r.id, vector: vectors[i]!,
      at: new Date(Date.parse(String(r.props['created_at'])) + 5_000).toISOString(),
    }))
    await session.executeWrite((tx) => tx.run(`
      UNWIND $rows AS row
      MATCH (n:${label} {id: row.id, tenant_id: $tenantId})
      CALL db.create.setNodeVectorProperty(n, 'embedding', row.vector)
      SET n.embedding_model = $model, n.embedded_at = row.at`, { rows: data, tenantId, model }))
    total += rows.length
    after = rows[rows.length - 1]!.id
    if (total % (BATCH * 20) === 0) log(`embeddings: ${label} ${String(total)}`)
  }
}

export async function embedDemoTenant(session: Session, tenantId: string, runId: string, log: (m: string) => void): Promise<{ incidents: number; articles: number } | null> {
  if (!(await aiFeatureEnabled(tenantId, 'embeddings'))) {
    log('embeddings: turned off for this organization, none computed')
    return null
  }
  const embedder = getEmbedder()
  log(`embeddings: ${embedder.provider}:${embedder.model} (${String(embedder.dimensions)} dimensions)`)
  await ensureVectorIndexes()
  const incidents = await embedLabel(session, tenantId, runId, 'Incident', log)
  const articles = await embedLabel(session, tenantId, runId, 'KBArticle', log)
  return { incidents, articles }
}
