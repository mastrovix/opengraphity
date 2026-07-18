/**
 * Embedding service — pluggable provider behind a single interface.
 *
 * Providers:
 *  - `local` (default): Transformers.js ONNX model in-process. Multilingual,
 *    no external API, data never leaves the host — the right default for an
 *    on-prem ITSM. First use downloads the model (~120MB) into
 *    TRANSFORMERS_CACHE (persisted under /data/models in the container).
 *  - `voyage`: Voyage AI API (voyage-3.5-lite). Higher quality; requires
 *    VOYAGE_API_KEY — missing key throws, it does not degrade to local.
 *
 * No-fallback contract: a provider failure (model load, HTTP error) always
 * propagates. Callers (BullMQ worker, backfill) fail the job loudly.
 */
import { logger } from '../lib/logger.js'

export interface Embedder {
  readonly provider: string
  readonly model: string
  readonly dimensions: number
  embed(texts: string[]): Promise<number[][]>
}

// ── Local provider (Transformers.js) ─────────────────────────────────────────

const LOCAL_MODEL = 'Xenova/paraphrase-multilingual-MiniLM-L12-v2'
const LOCAL_DIMENSIONS = 384

type FeaturePipeline = (
  text: string,
  opts: { pooling: 'mean'; normalize: boolean },
) => Promise<{ data: Float32Array }>

let localPipeline: Promise<FeaturePipeline> | null = null

function getLocalPipeline(): Promise<FeaturePipeline> {
  localPipeline ??= (async () => {
    const { pipeline, env } = await import('@xenova/transformers')
    env.cacheDir = process.env['TRANSFORMERS_CACHE'] ?? './data/models'
    logger.info({ model: LOCAL_MODEL, cacheDir: env.cacheDir }, '[embeddings] loading local model')
    const t0 = Date.now()
    const pipe = (await pipeline('feature-extraction', LOCAL_MODEL)) as unknown as FeaturePipeline
    logger.info({ model: LOCAL_MODEL, ms: Date.now() - t0 }, '[embeddings] local model ready')
    return pipe
  })()
  return localPipeline
}

const localEmbedder: Embedder = {
  provider: 'local',
  model: LOCAL_MODEL,
  dimensions: LOCAL_DIMENSIONS,
  async embed(texts: string[]): Promise<number[][]> {
    const pipe = await getLocalPipeline()
    const out: number[][] = []
    for (const text of texts) {
      const result = await pipe(text, { pooling: 'mean', normalize: true })
      out.push(Array.from(result.data))
    }
    return out
  },
}

// ── Voyage provider ──────────────────────────────────────────────────────────

const VOYAGE_MODEL = 'voyage-3.5-lite'
const VOYAGE_DIMENSIONS = 1024

const voyageEmbedder: Embedder = {
  provider: 'voyage',
  model: VOYAGE_MODEL,
  dimensions: VOYAGE_DIMENSIONS,
  async embed(texts: string[]): Promise<number[][]> {
    const apiKey = process.env['VOYAGE_API_KEY']
    if (!apiKey) throw new Error('[embeddings] EMBEDDINGS_PROVIDER=voyage but VOYAGE_API_KEY is not set')
    const res = await fetch('https://api.voyageai.com/v1/embeddings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model: VOYAGE_MODEL, input: texts }),
    })
    if (!res.ok) {
      throw new Error(`[embeddings] Voyage API error HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`)
    }
    const body = (await res.json()) as { data: Array<{ index: number; embedding: number[] }> }
    return body.data.sort((a, b) => a.index - b.index).map((d) => d.embedding)
  },
}

// ── Provider selection ───────────────────────────────────────────────────────

export function getEmbedder(): Embedder {
  const provider = process.env['EMBEDDINGS_PROVIDER'] ?? 'local'
  switch (provider) {
    case 'local':  return localEmbedder
    case 'voyage': return voyageEmbedder
    default:
      throw new Error(`[embeddings] Unknown EMBEDDINGS_PROVIDER: ${provider} (valid: local, voyage)`)
  }
}

/**
 * Vector index names are dimension-suffixed so a provider switch can never
 * query vectors of the wrong size: old-dimension embeddings simply drop out
 * of the new index until the backfill re-embeds them.
 */
export function vectorIndexName(label: 'Incident' | 'KBArticle'): string {
  const dims = getEmbedder().dimensions
  return label === 'Incident' ? `incident_embedding_${dims}` : `kb_embedding_${dims}`
}

// ── Text assembly ────────────────────────────────────────────────────────────

/** Canonical text used to embed an incident. Keep stable: changing it requires a re-backfill. */
export function incidentEmbeddingText(p: { title?: unknown; category?: unknown; description?: unknown }): string {
  return [p.title, p.category, p.description]
    .filter((v): v is string => typeof v === 'string' && v.length > 0)
    .join('\n')
}

/** Canonical text used to embed a KB article. */
export function kbEmbeddingText(p: { title?: unknown; tags?: unknown; category?: unknown; body?: unknown }): string {
  const tags = Array.isArray(p.tags) ? p.tags.join(' ') : undefined
  return [p.title, p.category, tags, typeof p.body === 'string' ? p.body.slice(0, 4000) : undefined]
    .filter((v): v is string => typeof v === 'string' && v.length > 0)
    .join('\n')
}
