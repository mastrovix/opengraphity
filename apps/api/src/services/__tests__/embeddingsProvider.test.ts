/**
 * embeddings — selezione del provider e chiamate esterne (complementa
 * embeddings.test.ts, che copre solo l'assemblaggio del testo).
 * Config REALE (lib/config.ts) pilotata con vi.stubEnv + resetConfigCache;
 * `fetch` globale stubbato; @huggingface/transformers mockato.
 * Pinna: voyage senza chiave → errore; provider sconosciuto → errore dalla
 * config (enum); voyage ok → POST con modello/chiave/testi, risposta
 * riordinata per index; HTTP error / body malformato → errore; nome indice
 * vettoriale con suffisso dimensioni; provider locale → pipeline ONNX con
 * cacheDir e pooling mean+normalize.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const h = vi.hoisted(() => {
  const pipe = vi.fn<(text: string, opts: unknown) => Promise<{ data: Float32Array }>>()
  const pipeline = vi.fn<(task: string, model: string) => Promise<unknown>>()
  const env: { cacheDir?: string } = {}
  return { pipe, pipeline, env }
})

// La dipendenza dichiarata in apps/api/package.json è @huggingface/transformers
// (embeddings.ts:39); @xenova/transformers NON è installato.
vi.mock('@huggingface/transformers', () => ({ pipeline: h.pipeline, env: h.env }))
vi.mock('../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
}))

const { resetConfigCache } = await import('../../lib/config.js')
const { getEmbedder, vectorIndexName } = await import('../embeddings.js')

const fetchMock = vi.fn<(url: string, init: RequestInit) => Promise<Response>>()

function useProvider(provider: string, voyageKey?: string) {
  vi.stubEnv('EMBEDDINGS_PROVIDER', provider)
  if (voyageKey === undefined) vi.stubEnv('VOYAGE_API_KEY', '')
  else vi.stubEnv('VOYAGE_API_KEY', voyageKey)
  resetConfigCache()
}

const jsonResponse = (body: unknown, status = 200) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) }) as unknown as Response

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('fetch', fetchMock)
  vi.stubEnv('TRANSFORMERS_CACHE', '/tmp/og-models-test')
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  resetConfigCache()
})

describe('getEmbedder — selezione provider', () => {
  it('default (env assente) → provider locale 384 dimensioni', () => {
    vi.stubEnv('EMBEDDINGS_PROVIDER', ''); resetConfigCache()
    expect(getEmbedder()).toMatchObject({ provider: 'local', model: 'Xenova/paraphrase-multilingual-MiniLM-L12-v2', dimensions: 384 })
  })

  it('voyage → provider voyage 1024 dimensioni (la chiave è verificata solo all\'uso)', () => {
    useProvider('voyage')
    expect(getEmbedder()).toMatchObject({ provider: 'voyage', model: 'voyage-3.5-lite', dimensions: 1024 })
  })

  it('provider sconosciuto → errore esplicito dalla config (enum), non un embedder undefined', () => {
    useProvider('openai')
    expect(() => getEmbedder()).toThrow('Environment variable EMBEDDINGS_PROVIDER must be one of local, voyage (got "openai")')
  })

  it('vectorIndexName porta il suffisso delle dimensioni del provider attivo', () => {
    useProvider('voyage')
    expect(vectorIndexName('Incident')).toBe('incident_embedding_1024')
    expect(vectorIndexName('KBArticle')).toBe('kb_embedding_1024')
    useProvider('local')
    expect(vectorIndexName('Incident')).toBe('incident_embedding_384')
    expect(vectorIndexName('KBArticle')).toBe('kb_embedding_384')
  })
})

describe('provider voyage', () => {
  it('senza VOYAGE_API_KEY → errore esplicito, nessuna chiamata HTTP (niente degrado a local)', async () => {
    useProvider('voyage')
    await expect(getEmbedder().embed(['ciao'])).rejects.toThrow('[embeddings] EMBEDDINGS_PROVIDER=voyage but VOYAGE_API_KEY is not set')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('POST a api.voyageai.com con bearer, modello e testi; risposta riordinata per index', async () => {
    useProvider('voyage', 'vk-123')
    fetchMock.mockResolvedValue(jsonResponse({ data: [
      { index: 1, embedding: [0.2, 0.2] },
      { index: 0, embedding: [0.1, 0.1] },
    ] }))
    await expect(getEmbedder().embed(['primo', 'secondo'])).resolves.toEqual([[0.1, 0.1], [0.2, 0.2]])
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('https://api.voyageai.com/v1/embeddings')
    expect(init.method).toBe('POST')
    expect(init.headers).toEqual({ 'Content-Type': 'application/json', Authorization: 'Bearer vk-123' })
    expect(JSON.parse(init.body as string)).toEqual({ model: 'voyage-3.5-lite', input: ['primo', 'secondo'] })
  })

  it('HTTP non-2xx → errore con status e inizio del body (max 300 caratteri)', async () => {
    useProvider('voyage', 'vk-123')
    fetchMock.mockResolvedValue(jsonResponse({ detail: 'x'.repeat(500) }, 429))
    const err = await getEmbedder().embed(['a']).then(() => null, (e: unknown) => e as Error)
    expect(err?.message).toMatch(/^\[embeddings\] Voyage API error HTTP 429: /)
    expect(err!.message.length).toBeLessThanOrEqual('[embeddings] Voyage API error HTTP 429: '.length + 300)
  })

  it('body 2xx malformato (senza data) → errore, mai un array vuoto', async () => {
    useProvider('voyage', 'vk-123')
    fetchMock.mockResolvedValue(jsonResponse({ error: 'unexpected' }))
    await expect(getEmbedder().embed(['a'])).rejects.toThrow()
  })

  it('errore di rete propaga (no-fallback)', async () => {
    useProvider('voyage', 'vk-123')
    fetchMock.mockRejectedValue(new Error('ECONNRESET'))
    await expect(getEmbedder().embed(['a'])).rejects.toThrow('ECONNRESET')
  })
})

describe('provider local', () => {
  it('carica la pipeline ONNX una sola volta con cacheDir dalla config e embedda con pooling mean + normalize', async () => {
    useProvider('local')
    h.pipe.mockImplementation(async (text) => ({ data: new Float32Array([text.length, 0.5]) }))
    h.pipeline.mockResolvedValue(h.pipe)

    const embedder = getEmbedder()
    await expect(embedder.embed(['ab', 'abcd'])).resolves.toEqual([[2, 0.5], [4, 0.5]])
    await expect(embedder.embed(['x'])).resolves.toEqual([[1, 0.5]])

    expect(h.pipeline).toHaveBeenCalledTimes(1)
    expect(h.pipeline).toHaveBeenCalledWith('feature-extraction', 'Xenova/paraphrase-multilingual-MiniLM-L12-v2')
    expect(h.env.cacheDir).toBe('/tmp/og-models-test')
    expect(h.pipe).toHaveBeenCalledWith('ab', { pooling: 'mean', normalize: true })
    expect(h.pipe).toHaveBeenCalledTimes(3)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
