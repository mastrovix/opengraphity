/**
 * Post-incident intelligence (AI step 4):
 *  - draftResolutionNotes: bozza di note di risoluzione dal timeline reale
 *  - problemCandidates: cluster di incident ricorrenti → candidati Problem
 *  - draftKbFromIncident: bozza articolo KB (status draft) da un incident risolto
 *
 * Ogni funzione è invocata da un'azione ESPLICITA dell'utente e produce
 * suggerimenti/bozze da rivedere — mai auto-azioni. No-fallback: chiave
 * mancante, errori provider e violazioni di schema propagano.
 */
import Anthropic from '@anthropic-ai/sdk'
import { GraphQLError } from 'graphql'
import { getSession, runQuery } from '@opengraphity/neo4j'
import { vectorIndexName } from './embeddings.js'
import { logger } from '../lib/logger.js'

const log = logger.child({ module: 'post-incident' })

function getClient(): Anthropic {
  if (!process.env['ANTHROPIC_API_KEY']) {
    throw new GraphQLError('AI non configurata: ANTHROPIC_API_KEY mancante', {
      extensions: { code: 'FAILED_PRECONDITION' },
    })
  }
  return new Anthropic()
}

async function readQuery<T>(cypher: string, params: Record<string, unknown>): Promise<T[]> {
  const session = getSession(undefined, 'READ')
  try {
    return await runQuery<T>(session, cypher, params)
  } finally {
    await session.close()
  }
}

interface IncidentContext {
  props: Record<string, unknown>
  comments: Array<{ text: string; created_at: string }>
  steps: Array<{ step: string; at: string; trigger: string | null }>
  cis: string[]
}

async function loadIncidentContext(tenantId: string, incidentId: string): Promise<IncidentContext> {
  const rows = await readQuery<{
    props: Record<string, unknown>
    comments: Array<{ text: string; created_at: string }>
    steps: Array<{ step: string; at: string; trigger: string | null }>
    cis: string[]
  }>(`
    MATCH (i:Incident {id: $incidentId, tenant_id: $tenantId})
    OPTIONAL MATCH (i)-[:HAS_COMMENT]->(c:Comment)
    WITH i, collect(DISTINCT {text: c.text, created_at: c.created_at}) AS comments
    OPTIONAL MATCH (wi:WorkflowInstance {entity_id: $incidentId, tenant_id: $tenantId})
    OPTIONAL MATCH (se:WorkflowStepExecution {instance_id: wi.id})
    WITH i, comments, se ORDER BY se.entered_at
    WITH i, comments, collect({step: se.step_name, at: se.entered_at, trigger: se.trigger_type}) AS steps
    OPTIONAL MATCH (i)-[:AFFECTED_BY]->(ci)
    RETURN properties(i) AS props, comments, steps, collect(DISTINCT ci.name) AS cis
  `, { tenantId, incidentId })
  if (!rows.length) throw new GraphQLError('Incident non trovato', { extensions: { code: 'NOT_FOUND' } })
  const r = rows[0]
  return {
    props: r.props,
    comments: r.comments.filter(c => c.text),
    steps: r.steps.filter(s => s.step),
    cis: r.cis,
  }
}

// ── 1. Bozza resolution notes ────────────────────────────────────────────────

export async function draftResolutionNotes(tenantId: string, incidentId: string): Promise<string> {
  const ctx = await loadIncidentContext(tenantId, incidentId)
  const client = getClient()
  const t0 = Date.now()

  const response = await client.messages.create({
    model: 'claude-opus-4-8',
    max_tokens: 1500,
    thinking: { type: 'adaptive' },
    output_config: { effort: 'low' },
    system: [{
      type: 'text',
      text: `Scrivi note di risoluzione per incident ITSM, in italiano. Ricevi i dati reali dell'incident (titolo, descrizione, commenti degli operatori, passaggi di workflow, CI coinvolti). Produci SOLO il testo delle note: 3-6 frasi concrete che descrivono causa, intervento effettuato e verifica — basate esclusivamente sull'evidenza fornita. Se l'evidenza non chiarisce la causa o l'intervento, scrivilo esplicitamente ("causa non documentata nei commenti") invece di inventare. Niente preamboli, niente markdown.`,
      cache_control: { type: 'ephemeral' },
    }],
    messages: [{ role: 'user', content: JSON.stringify({
      titolo: ctx.props['title'], descrizione: ctx.props['description'],
      severity: ctx.props['severity'], categoria: ctx.props['category'],
      ci_coinvolti: ctx.cis, commenti: ctx.comments, passaggi_workflow: ctx.steps,
    }, null, 1) }],
  })

  if (response.stop_reason === 'refusal') {
    throw new GraphQLError('Il modello ha rifiutato la richiesta', { extensions: { code: 'INTERNAL_SERVER_ERROR' } })
  }
  const text = response.content.find((b): b is Anthropic.TextBlock => b.type === 'text')?.text
  if (!text?.trim()) throw new Error('[post-incident] bozza vuota dal modello')
  log.info({ incidentId, ms: Date.now() - t0 }, '[post-incident] resolution draft generated')
  return text.trim()
}

// ── 2. Candidati Problem ─────────────────────────────────────────────────────

export interface ProblemCandidate {
  title: string
  motivation: string
  incidents: Array<{ id: string; number: string | null; title: string; status: string; severity: string }>
}

const CLUSTER_THRESHOLD = 0.72
const CLUSTER_MIN_SIZE = 3

export async function problemCandidates(tenantId: string): Promise<ProblemCandidate[]> {
  // Non-closed incidents with an embedding
  const incidents = await readQuery<{ id: string; number: string | null; title: string; status: string; severity: string; embedding: number[] }>(`
    MATCH (i:Incident {tenant_id: $tenantId})
    WHERE NOT i.status IN ['closed'] AND i.embedding IS NOT NULL
    RETURN i.id AS id, i.number AS number, i.title AS title,
           i.status AS status, i.severity AS severity, i.embedding AS embedding
  `, { tenantId })

  // Cluster: for each incident query its similar peers above threshold, then union-find
  const parent = new Map<string, string>()
  const find = (x: string): string => {
    let r = x
    while (parent.get(r) !== r) r = parent.get(r)!
    return r
  }
  const union = (a: string, b: string) => { parent.set(find(a), find(b)) }
  for (const i of incidents) parent.set(i.id, i.id)

  const index = vectorIndexName('Incident')
  for (const i of incidents) {
    const peers = await readQuery<{ id: string; score: number }>(`
      CALL db.index.vector.queryNodes($index, 15, $embedding)
      YIELD node, score
      WHERE node.tenant_id = $tenantId AND node.id <> $selfId
        AND NOT node.status IN ['closed'] AND score >= ${CLUSTER_THRESHOLD}
      RETURN node.id AS id, score
    `, { index, embedding: i.embedding, tenantId, selfId: i.id })
    for (const p of peers) if (parent.has(p.id)) union(i.id, p.id)
  }

  const groups = new Map<string, typeof incidents>()
  for (const i of incidents) {
    const root = find(i.id)
    if (!groups.has(root)) groups.set(root, [])
    groups.get(root)!.push(i)
  }
  const clusters = [...groups.values()]
    .filter(g => g.length >= CLUSTER_MIN_SIZE)
    .sort((a, b) => b.length - a.length)
    .slice(0, 3)

  if (clusters.length === 0) return []

  // Claude names each cluster and motivates the Problem candidate
  const client = getClient()
  const schema = {
    type: 'object',
    properties: {
      candidates: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            cluster_index: { type: 'integer' },
            title: { type: 'string' },
            motivation: { type: 'string' },
          },
          required: ['cluster_index', 'title', 'motivation'],
          additionalProperties: false,
        },
      },
    },
    required: ['candidates'],
    additionalProperties: false,
  } as const

  const response = await client.messages.create({
    model: 'claude-opus-4-8',
    max_tokens: 2000,
    thinking: { type: 'adaptive' },
    output_config: { effort: 'low', format: { type: 'json_schema', schema } },
    system: [{
      type: 'text',
      text: `Analista ITSM. Ricevi cluster di incident semanticamente simili (non chiusi). Per ogni cluster proponi un candidato Problem: un titolo sintetico della probabile causa radice comune e una motivazione (2-3 frasi, in italiano) fondata SOLO sui titoli/dati forniti. Se un cluster sembra composto da ticket di test o senza pattern reale, dillo apertamente nella motivazione.`,
      cache_control: { type: 'ephemeral' },
    }],
    messages: [{ role: 'user', content: JSON.stringify(
      clusters.map((g, idx) => ({ cluster_index: idx, incident: g.map(i => ({ numero: i.number, titolo: i.title, severity: i.severity, stato: i.status })) })),
      null, 1,
    ) }],
  })

  if (response.stop_reason === 'refusal') {
    throw new GraphQLError('Il modello ha rifiutato la richiesta', { extensions: { code: 'INTERNAL_SERVER_ERROR' } })
  }
  const text = response.content.find((b): b is Anthropic.TextBlock => b.type === 'text')?.text
  if (!text) throw new Error('[post-incident] risposta senza testo')
  const parsed = JSON.parse(text) as { candidates: Array<{ cluster_index: number; title: string; motivation: string }> }

  return parsed.candidates
    .filter(c => clusters[c.cluster_index])
    .map(c => ({
      title: c.title,
      motivation: c.motivation,
      incidents: clusters[c.cluster_index].map(({ id, number, title, status, severity }) => ({ id, number, title, status, severity })),
    }))
}

// ── 3. Bozza articolo KB da incident risolto ────────────────────────────────

export interface KbDraftContent {
  title: string
  body: string
  category: string
  tags: string[]
}

export async function draftKbContent(tenantId: string, incidentId: string): Promise<KbDraftContent> {
  const ctx = await loadIncidentContext(tenantId, incidentId)
  const status = String(ctx.props['status'] ?? '')
  if (status !== 'resolved' && status !== 'closed') {
    throw new GraphQLError('La bozza KB si genera solo da incident risolti o chiusi', { extensions: { code: 'BAD_USER_INPUT' } })
  }

  const client = getClient()
  const schema = {
    type: 'object',
    properties: {
      title: { type: 'string' },
      body: { type: 'string' },
      category: { type: 'string' },
      tags: { type: 'array', items: { type: 'string' } },
    },
    required: ['title', 'body', 'category', 'tags'],
    additionalProperties: false,
  } as const

  const response = await client.messages.create({
    model: 'claude-opus-4-8',
    max_tokens: 3000,
    thinking: { type: 'adaptive' },
    output_config: { effort: 'low', format: { type: 'json_schema', schema } },
    system: [{
      type: 'text',
      text: `Redattore Knowledge Base ITSM. Da un incident risolto produci un articolo KB in italiano, struttura: Sintomo, Causa, Soluzione, Verifica. Usa SOLO l'evidenza fornita (descrizione, commenti, workflow); dove l'evidenza manca scrivi "da completare" invece di inventare. body in markdown semplice. category: una parola (es. database, network, hardware, software). tags: 2-5 parole chiave.`,
      cache_control: { type: 'ephemeral' },
    }],
    messages: [{ role: 'user', content: JSON.stringify({
      titolo: ctx.props['title'], descrizione: ctx.props['description'],
      categoria_incident: ctx.props['category'], ci_coinvolti: ctx.cis,
      commenti: ctx.comments, passaggi_workflow: ctx.steps,
    }, null, 1) }],
  })

  if (response.stop_reason === 'refusal') {
    throw new GraphQLError('Il modello ha rifiutato la richiesta', { extensions: { code: 'INTERNAL_SERVER_ERROR' } })
  }
  const text = response.content.find((b): b is Anthropic.TextBlock => b.type === 'text')?.text
  if (!text) throw new Error('[post-incident] risposta senza testo')
  return JSON.parse(text) as KbDraftContent
}
