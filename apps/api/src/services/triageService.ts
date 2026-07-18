/**
 * AI-assisted triage — suggests severity/category/team for an incident DRAFT.
 *
 * Grounding: the draft text is embedded, similar historical incidents are
 * retrieved from the vector index, and the selected CIs' graph impact
 * (dependents, business capabilities within reach) is summarized. Claude
 * then produces a structured suggestion constrained to the tenant's actual
 * enum values.
 *
 * This is a SUGGESTION with an explicit motivation — the UI never applies it
 * automatically. No-fallback: missing API key, provider errors and schema
 * violations all throw.
 */
import Anthropic from '@anthropic-ai/sdk'
import { GraphQLError } from 'graphql'
import { getSession, runQuery } from '@opengraphity/neo4j'
import { getEmbedder, vectorIndexName } from './embeddings.js'
import { logger } from '../lib/logger.js'

const log = logger.child({ module: 'triage' })

export interface TriageInput {
  tenantId:    string
  title:       string
  description: string | null
  ciIds:       string[]
}

export interface SimilarForTriage {
  id: string; number: string | null; title: string; severity: string
  category: string | null; status: string; teamName: string | null; score: number
}

export interface TriageSuggestion {
  severity:    string
  category:    string
  teamName:    string | null
  confidence:  'low' | 'medium' | 'high'
  motivation:  string
  riskFactors: string[]
  similarUsed: SimilarForTriage[]
}

// ── Context gathering ────────────────────────────────────────────────────────

async function loadEnumValues(field: 'severity' | 'category'): Promise<string[]> {
  const session = getSession(undefined, 'READ')
  try {
    const rows = await runQuery<{ values: string[] | null }>(session, `
      MATCH (t:CITypeDefinition {name: 'incident'})-[:HAS_FIELD]->(f:CIFieldDefinition {name: $field})
      OPTIONAL MATCH (f)-[:USES_ENUM]->(e:EnumTypeDefinition)
      RETURN coalesce(e.values, f.enum_values) AS values
    `, { field })
    const values = rows[0]?.values
    if (!values?.length) throw new Error(`[triage] enum values for incident.${field} not found in the metamodel`)
    return values
  } finally {
    await session.close()
  }
}

async function findSimilar(tenantId: string, embedding: number[]): Promise<SimilarForTriage[]> {
  const session = getSession(undefined, 'READ')
  try {
    return await runQuery<SimilarForTriage>(session, `
      CALL db.index.vector.queryNodes($index, 30, $embedding)
      YIELD node, score
      WHERE node.tenant_id = $tenantId
      OPTIONAL MATCH (node)-[:ASSIGNED_TO_TEAM]->(team:Team)
      RETURN node.id AS id, node.number AS number, node.title AS title,
             node.severity AS severity, node.category AS category,
             node.status AS status, team.name AS teamName, score
      ORDER BY score DESC
      LIMIT 6
    `, { index: vectorIndexName('Incident'), embedding, tenantId })
  } finally {
    await session.close()
  }
}

interface CIImpact {
  name: string; type: string; environment: string | null
  dependentCount: number; capabilities: string[]
}

async function loadCIImpact(tenantId: string, ciIds: string[]): Promise<CIImpact[]> {
  if (ciIds.length === 0) return []
  const session = getSession(undefined, 'READ')
  try {
    const rows = await runQuery<{
      name: string; type: string | null; environment: string | null
      dependentCount: unknown; capabilities: string[]
    }>(session, `
      MATCH (ci {tenant_id: $tenantId})
      WHERE ci.id IN $ciIds
      OPTIONAL MATCH (dep)-[:DEPENDS_ON]->(ci)
      WITH ci, count(DISTINCT dep) AS dependentCount
      OPTIONAL MATCH (cap:BusinessCapability {tenant_id: $tenantId})-[*1..4]-(ci)
      RETURN ci.name AS name, labels(ci)[0] AS type, ci.environment AS environment,
             dependentCount, collect(DISTINCT cap.name)[..5] AS capabilities
    `, { tenantId, ciIds: ciIds.slice(0, 5) })
    return rows.map(r => ({
      name: r.name,
      type: r.type ?? 'CI',
      environment: r.environment,
      dependentCount: typeof r.dependentCount === 'object' && r.dependentCount !== null && 'toNumber' in r.dependentCount
        ? (r.dependentCount as { toNumber(): number }).toNumber()
        : Number(r.dependentCount),
      capabilities: r.capabilities,
    }))
  } finally {
    await session.close()
  }
}

// ── Claude call ──────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `Sei l'assistente di triage di OpenGrafo, una piattaforma ITSM. Ricevi la bozza di un incident (titolo, descrizione), gli incident storici semanticamente simili con il loro triage effettivo, e l'impatto infrastrutturale dei Configuration Item coinvolti (dipendenti diretti e Business Capability raggiungibili nel grafo).

Suggerisci severity, categoria e team di assegnazione motivando in modo conciso e concreto (2-4 frasi, in italiano). Regole:
- Basa il suggerimento sull'evidenza fornita: triage degli incident simili e impatto dei CI. Non inventare fatti.
- Un CI con molti dipendenti o vicino a una Business Capability alza la severity.
- Se gli incident simili sono pochi o poco simili (score < 0.5), abbassa la confidence.
- teamName: solo un team che compare negli incident simili; null se nessuna evidenza.
- riskFactors: 0-3 fattori di rischio concreti osservati nell'evidenza.`

function suggestionSchema(severities: string[], categories: string[]) {
  return {
    type: 'object',
    properties: {
      severity:    { type: 'string', enum: severities },
      category:    { type: 'string', enum: categories },
      teamName:    { type: ['string', 'null'] },
      confidence:  { type: 'string', enum: ['low', 'medium', 'high'] },
      motivation:  { type: 'string' },
      riskFactors: { type: 'array', items: { type: 'string' } },
    },
    required: ['severity', 'category', 'teamName', 'confidence', 'motivation', 'riskFactors'],
    additionalProperties: false,
  } as const
}

let _client: Anthropic | null = null
function getClient(): Anthropic {
  if (!process.env['ANTHROPIC_API_KEY']) {
    throw new GraphQLError('Triage AI non configurato: ANTHROPIC_API_KEY mancante', {
      extensions: { code: 'FAILED_PRECONDITION' },
    })
  }
  _client ??= new Anthropic()
  return _client
}

export async function suggestTriage(input: TriageInput): Promise<TriageSuggestion> {
  const draftText = [input.title, input.description].filter(Boolean).join('\n')
  if (!draftText.trim()) {
    throw new GraphQLError('Titolo vuoto: niente da analizzare', { extensions: { code: 'BAD_USER_INPUT' } })
  }

  const [embedding] = await getEmbedder().embed([draftText])
  const [similar, impact, severities, categories] = await Promise.all([
    findSimilar(input.tenantId, embedding),
    loadCIImpact(input.tenantId, input.ciIds),
    loadEnumValues('severity'),
    loadEnumValues('category'),
  ])

  const context = {
    bozza: { titolo: input.title, descrizione: input.description ?? null },
    incident_simili: similar.map(s => ({
      numero: s.number, titolo: s.title, severity: s.severity, categoria: s.category,
      stato: s.status, team: s.teamName, similarita: Math.round(s.score * 100) / 100,
    })),
    impatto_ci: impact,
  }

  const client = getClient()
  const t0 = Date.now()
  const response = await client.messages.create({
    model: 'claude-opus-4-8',
    max_tokens: 2000,
    thinking: { type: 'adaptive' },
    output_config: {
      effort: 'low',
      format: { type: 'json_schema', schema: suggestionSchema(severities, categories) },
    },
    system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: JSON.stringify(context, null, 1) }],
  })

  if (response.stop_reason === 'refusal') {
    throw new GraphQLError('Il modello ha rifiutato la richiesta di triage', { extensions: { code: 'INTERNAL_SERVER_ERROR' } })
  }
  const textBlock = response.content.find((b): b is Anthropic.TextBlock => b.type === 'text')
  if (!textBlock) throw new Error('[triage] risposta senza blocco testo')

  const parsed = JSON.parse(textBlock.text) as Omit<TriageSuggestion, 'similarUsed'>
  log.info({ ms: Date.now() - t0, severity: parsed.severity, confidence: parsed.confidence }, '[triage] suggestion generated')

  return { ...parsed, similarUsed: similar.slice(0, 5) }
}
