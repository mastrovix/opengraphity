import { GraphQLError } from 'graphql'
import { ValidationError } from '../../../lib/errors.js'
import { v4 as uuidv4 } from 'uuid'
import { withSession, runQuery, runQueryOne, type Props } from '../ci-utils.js'
import type { GraphQLContext } from '../../../context.js'
import { logger } from '../../../lib/logger.js'
import { mapAssessmentQuestion, mapAnswerOption } from './mappers.js'

type OptionInput = { id?: string | null; label: string; score: number; sortOrder: number }

async function loadQuestionWithOptions(session: ReturnType<typeof import('../ci-utils.js').getSession>, id: string, tenantId: string) {
  const q = await runQueryOne<{ props: Props }>(session, `
    MATCH (q:AssessmentQuestion {id: $id, tenant_id: $tenantId})
    RETURN properties(q) AS props
  `, { id, tenantId })
  if (!q) return null
  const opts = await runQuery<{ props: Props }>(session, `
    // tenant-ok(per-id): q già caricata scopata sopra
    MATCH (q:AssessmentQuestion {id: $id})-[:HAS_OPTION]->(o:AnswerOption)
    RETURN properties(o) AS props ORDER BY o.sort_order
  `, { id })
  return {
    ...mapAssessmentQuestion(q.props),
    options: opts.map(o => mapAnswerOption(o.props)),
  }
}

/**
 * Una domanda di assessment usabile (terza revisione, provato dal vivo).
 *
 * Il resolver validava la CATEGORIA e che ci fosse almeno un'opzione, non il
 * contenuto: `label: ''` passava. Sulla pagina del task quelle opzioni si
 * rendono come VOCI BIANCHE nella tendina — chi le scegliesse non saprebbe
 * cosa ha scelto — e siccome l'assessment alimenta il punteggio di rischio,
 * e da quello la priorita della change, un'opzione senza nome e un buco nel
 * calcolo. Trovato su un tenant di prova: tre opzioni salvate, due senza
 * etichetta e tutte con punteggio zero.
 *
 * Stessa forma di `assertValuesUsable` per i vocabolari: il testo vuoto, il
 * duplicato e il punteggio non numerico si rifiutano all'ingresso.
 */
function assertQuestionUsable(
  text: string | null | undefined,
  options: readonly OptionInput[] | null | undefined,
): void {
  if (text !== null && text !== undefined && text.trim() === '') {
    throw new ValidationError('The question text cannot be empty: it is what the operator reads in the task.', { key: 'errors.question.textEmpty' })
  }
  if (options === null || options === undefined) return
  if (options.length === 0) throw new ValidationError('A question must have at least one option', { key: 'errors.question.noOptions' })

  const vuote = options.filter((o) => typeof o.label !== 'string' || o.label.trim() === '')
  if (vuote.length) {
    throw new ValidationError(
      `${vuote.length === 1 ? 'One answer option has no text' : `${String(vuote.length)} answer options have no text`}: `
      + `the task dropdown would show a blank entry, and whoever picked it would not know what they chose. `
      + `Give every option a label, or remove the rows you do not need.`,
      { key: 'errors.question.optionsWithoutText', params: { count: vuote.length } },
    )
  }
  const visti = new Set<string>()
  const doppie = options.map((o) => o.label.trim()).filter((l) => (visti.has(l) ? true : (visti.add(l), false)))
  if (doppie.length) {
    throw new ValidationError(
      `The options repeat ${[...new Set(doppie)].map((l) => `"${l}"`).join(', ')}: two answers with the same text `
      + `and different scores make the risk score impossible to explain.`,
      { key: 'errors.question.duplicateOptions', params: { options: [...new Set(doppie)].join(', ') } },
    )
  }
  const nonNumeriche = options.filter((o) => typeof o.score !== 'number' || !Number.isFinite(o.score))
  if (nonNumeriche.length) {
    throw new ValidationError('Every option must have a numeric score: it feeds the change risk.', { key: 'errors.question.scoreRequired' })
  }

  // ── I PUNTEGGI (regola di dominio, terza revisione) ───────────────────────
  //
  // Nessuna risposta puo valere 0, e non possono valere tutte lo stesso.
  //
  // Lo zero era usato dai semi di fabbrica per dire «questa risposta non
  // aggiunge rischio» — e i semi sono stati cambiati di conseguenza. La ragione
  // di dominio e che una risposta a punteggio zero e ININFLUENTE: nel calcolo
  // (`scoring.ts`) il punteggio entra al numeratore e il MASSIMO delle opzioni
  // al denominatore, quindi un'opzione a zero non sposta nulla.
  //
  // E se TUTTE valgono lo stesso, rispondere non puo cambiare il rischio: la
  // domanda e decorativa. E il caso che ho incontrato dal vivo — tre opzioni
  // salvate, tutte a zero — dove il rischio della change usciva 0 e la fascia
  // restava vuota.
  const sottoUno = options.filter((o) => !Number.isInteger(o.score) || o.score < 1)
  if (sottoUno.length) {
    throw new ValidationError(
      `${sottoUno.map((o) => `"${o.label.trim()}"`).join(', ')}: the score must be an integer of 1 or more. `
      + `An answer worth 0 does not move the risk of the change, so the question measures nothing: `
      + `give the least risky answer the lowest score (1), not zero.`,
      { key: 'errors.question.scoreBelowOne', params: { options: sottoUno.map((o) => o.label.trim()).join(', ') } },
    )
  }
  const distinti = new Set(options.map((o) => o.score))
  if (distinti.size === 1) {
    throw new ValidationError(
      `Every option is worth ${String([...distinti][0])}: answering would not change the risk of the change, `
      + `so the question measures nothing. Give the answers different scores, from the least to the most risky.`,
      { key: 'errors.question.allSameScore', params: { score: String([...distinti][0]) } },
    )
  }
}

export async function createAssessmentQuestion(
  _: unknown,
  args: { input: { text: string; category: string; isCore: boolean; options: OptionInput[] } },
  ctx: GraphQLContext,
) {
  const { text, category, isCore, options } = args.input
  if (category !== 'functional' && category !== 'technical') {
    throw new ValidationError('category must be "functional" or "technical"', { key: 'errors.question.category' })
  }
  assertQuestionUsable(text, options)
  const id = uuidv4()
  const now = new Date().toISOString()
  return withSession(async (session) => {
    await session.executeWrite((tx) => tx.run(`
      CREATE (q:AssessmentQuestion {
        id: $id, tenant_id: $tenantId, text: $text, category: $category,
        is_core: $isCore, is_active: true, created_at: $now
      })
      WITH q
      UNWIND $options AS opt
      CREATE (o:AnswerOption {
        id: randomUUID(), tenant_id: $tenantId, label: opt.label, score: opt.score, sort_order: opt.sortOrder
      })
      CREATE (q)-[:HAS_OPTION]->(o)
    `, { id, tenantId: ctx.tenantId, text, category, isCore, now, options }))

    if (isCore) {
      await session.executeWrite((tx) => tx.run(`
        MATCH (q:AssessmentQuestion {id: $id, tenant_id: $tenantId})
        // «Core» vuol dire TUTTI i tipi CI attivi del cliente, non solo quelli
        // spediti col prodotto (terza revisione, provato dal vivo). Qui c'era
        // {active: true, scope: 'base'}: una domanda core non veniva
        // assegnata ai tipi CI del CLIENTE, e l'interfaccia prometteva il
        // contrario — «assegnata automaticamente a tutti i CI Type attivi».
        // Conseguenza: una change che toccava un CI di un tipo creato dal
        // cliente non superava MAI l'assessment
        // («Nessuna domanda di assessment assegnata al tipo di CI»).
        // tenant-ok(condivisi): i tipi base sono condivisi, quelli del cliente sono filtrati sul suo id
        MATCH (ct:CITypeDefinition)
        WHERE (ct.scope = 'base' OR (ct.scope = 'tenant' AND ct.tenant_id = $tenantId))
          AND ct.active = true AND ct.name <> '__base__'
        MERGE (ct)-[rel:HAS_QUESTION]->(q)
          ON CREATE SET rel.weight = 1, rel.sort_order = 0
      `, { id, tenantId: ctx.tenantId }))
    }

    logger.info({ questionId: id, isCore }, '[questionAdmin] question created')
    return loadQuestionWithOptions(session, id, ctx.tenantId)
  }, true)
}

export async function updateAssessmentQuestion(
  _: unknown,
  args: { id: string; input: { text?: string; category?: string; isCore?: boolean; isActive?: boolean; options?: OptionInput[] } },
  ctx: GraphQLContext,
) {
  const { id } = args
  const { text, category, isCore, isActive, options } = args.input
  if (category && category !== 'functional' && category !== 'technical') {
    throw new ValidationError('category must be "functional" or "technical"', { key: 'errors.question.category' })
  }
  assertQuestionUsable(text, options)
  return withSession(async (session) => {
    await session.executeWrite((tx) => tx.run(`
      MATCH (q:AssessmentQuestion {id: $id, tenant_id: $tenantId})
      SET q.text     = coalesce($text, q.text),
          q.category = coalesce($category, q.category),
          q.is_core  = coalesce($isCore, q.is_core),
          q.is_active = coalesce($isActive, q.is_active)
    `, { id, tenantId: ctx.tenantId, text: text ?? null, category: category ?? null,
         isCore: isCore ?? null, isActive: isActive ?? null }))

    if (options !== undefined) await saveOptions(session, id, ctx.tenantId, options)

    return loadQuestionWithOptions(session, id, ctx.tenantId)
  }, true)
}

/**
 * Le opzioni di una domanda, senza perdere le risposte già date
 * (revisione totale · B-2). Prima erano cancellate e ricreate con id nuovi: le
 * `AssessmentResponse` perdevano la relazione `SELECTED`, quindi le risposte
 * sparivano dai task in corso e da quelli già completati (`Missing answers`).
 * Ora: un'opzione con `id` si aggiorna, una senza si crea, e una rimossa si
 * cancella solo se nessuno l'ha scelta — altrimenti l'operazione si rifiuta
 * nominandola, come già fa la cancellazione della domanda.
 */
async function saveOptions(
  session: Parameters<typeof runQueryOne>[0] & { executeWrite: (w: (tx: unknown) => unknown) => Promise<unknown> },
  questionId: string, tenantId: string, options: OptionInput[],
): Promise<void> {
  const keptIds = options.map((o) => o.id).filter((v): v is string => typeof v === 'string' && v !== '')
  const inUse = await runQuery<{ label: string; answers: number }>(session, `
    MATCH (q:AssessmentQuestion {id: $questionId, tenant_id: $tenantId})-[:HAS_OPTION]->(o:AnswerOption)
    WHERE NOT o.id IN $keptIds
    OPTIONAL MATCH (r:AssessmentResponse)-[:SELECTED]->(o)
    WITH o, count(r) AS answers WHERE answers > 0
    RETURN o.label AS label, answers`, { questionId, tenantId, keptIds })
  if (inUse.length > 0) {
    const names = inUse.map((r) => `"${r.label}" (${String(r.answers)})`).join(', ')
    throw new GraphQLError(
      `These answers have already been chosen and cannot be removed: ${names}. Change their text instead, or deactivate the question.`,
      { extensions: { code: 'CONFLICT', i18n: { key: 'errors.question.optionInUse', params: { options: names } } } },
    )
  }
  await session.executeWrite((tx) => (tx as { run: (q: string, p: Record<string, unknown>) => Promise<unknown> }).run(`
    MATCH (q:AssessmentQuestion {id: $questionId, tenant_id: $tenantId})
    OPTIONAL MATCH (q)-[:HAS_OPTION]->(gone:AnswerOption) WHERE NOT gone.id IN $keptIds
    DETACH DELETE gone
    WITH DISTINCT q
    UNWIND $options AS opt
    // Un'opzione che esiste già conserva il suo id, e con esso le risposte date.
    MERGE (q)-[:HAS_OPTION]->(o:AnswerOption {id: coalesce(opt.id, randomUUID()), tenant_id: $tenantId})
    SET o.label = opt.label, o.score = opt.score, o.sort_order = opt.sortOrder
  `, { questionId, tenantId, options, keptIds }))
}

export async function deleteAssessmentQuestion(_: unknown, args: { id: string }, ctx: GraphQLContext) {
  return withSession(async (session) => {
    const used = await runQueryOne<{ count: unknown }>(session, `
      MATCH (:AssessmentResponse)-[:ANSWERS]->(q:AssessmentQuestion {id: $id, tenant_id: $tenantId})
      RETURN count(*) AS count
    `, { id: args.id, tenantId: ctx.tenantId })
    const usedCount = used ? Number(used.count) : 0
    if (usedCount > 0) {
      logger.error({ questionId: args.id, usedCount }, '[questionAdmin] impossibile eliminare: in uso')
      throw new GraphQLError('Cannot delete: the question has responses', { extensions: { code: 'CONFLICT', i18n: { key: 'errors.assessment.questionHasResponses' } } })
    }
    await session.executeWrite((tx) => tx.run(`
      MATCH (q:AssessmentQuestion {id: $id, tenant_id: $tenantId})
      OPTIONAL MATCH (q)-[:HAS_OPTION]->(o:AnswerOption)
      DETACH DELETE o, q
    `, { id: args.id, tenantId: ctx.tenantId }))
    return true
  }, true)
}

export async function assignQuestionToCIType(
  _: unknown,
  args: { questionId: string; ciTypeId: string; weight: number; sortOrder: number },
  ctx: GraphQLContext,
) {
  return withSession(async (session) => {
    await session.executeWrite((tx) => tx.run(`
      // Revisione totale · B-10: il tipo CI deve essere di questo cliente (o spedito col prodotto),
      // altrimenti l'id di un tipo di un altro tenant riceveva la relazione.
      MATCH (ct:CITypeDefinition {id: $ciTypeId})
      WHERE ct.scope = 'base' OR ct.tenant_id IN [$tenantId, 'system']
      MATCH (q:AssessmentQuestion {id: $questionId, tenant_id: $tenantId})
      MERGE (ct)-[rel:HAS_QUESTION]->(q)
      SET rel.weight = $weight, rel.sort_order = $sortOrder
    `, { ciTypeId: args.ciTypeId, questionId: args.questionId, weight: args.weight,
         sortOrder: args.sortOrder, tenantId: ctx.tenantId }))
    return true
  }, true)
}

export async function removeQuestionFromCIType(
  _: unknown,
  args: { questionId: string; ciTypeId: string },
  ctx: GraphQLContext,
) {
  return withSession(async (session) => {
    await session.executeWrite((tx) => tx.run(`
      // Revisione totale · B-10/A-21: il tipo CI deve essere di questo cliente.
      MATCH (ct:CITypeDefinition {id: $ciTypeId})-[rel:HAS_QUESTION]->(q:AssessmentQuestion {id: $questionId, tenant_id: $tenantId})
      WHERE ct.scope = 'base' OR ct.tenant_id IN [$tenantId, 'system']
      DELETE rel
    `, { ciTypeId: args.ciTypeId, questionId: args.questionId, tenantId: ctx.tenantId }))
    return true
  }, true)
}

export async function setQuestionCore(_: unknown, args: { questionId: string; isCore: boolean }, ctx: GraphQLContext) {
  return withSession(async (session) => {
    await session.executeWrite((tx) => tx.run(`
      MATCH (q:AssessmentQuestion {id: $id, tenant_id: $tenantId})
      SET q.is_core = $isCore
    `, { id: args.questionId, tenantId: ctx.tenantId, isCore: args.isCore }))

    if (args.isCore) {
      // A TUTTI i tipi CI attivi del cliente, non solo a quelli spediti
      // (terza revisione). Il commento diceva «all active CITypes» e la query
      // diceva `scope: 'base'`: e il quarto posto con la stessa cablatura —
      // gli altri tre sono in `createAssessmentQuestion` e nelle due letture
      // di `queries.ts`. La casella «Core» dell'interfaccia chiama questa.
      await session.executeWrite((tx) => tx.run(`
        MATCH (q:AssessmentQuestion {id: $id, tenant_id: $tenantId})
        // tenant-ok(condivisi): i tipi base sono condivisi, quelli del cliente filtrati sul suo id
        MATCH (ct:CITypeDefinition)
        WHERE (ct.scope = 'base' OR (ct.scope = 'tenant' AND ct.tenant_id = $tenantId))
          AND ct.active = true AND ct.name <> '__base__'
          AND NOT (ct)-[:HAS_QUESTION]->(q)
        MERGE (ct)-[rel:HAS_QUESTION]->(q)
          ON CREATE SET rel.weight = 1, rel.sort_order = 0
      `, { id: args.questionId, tenantId: ctx.tenantId }))
    } else {
      // Detach from all CITypeDefinitions
      await session.executeWrite((tx) => tx.run(`
        MATCH (:CITypeDefinition)-[rel:HAS_QUESTION]->(q:AssessmentQuestion {id: $id, tenant_id: $tenantId})
        DELETE rel
      `, { id: args.questionId, tenantId: ctx.tenantId }))
    }

    return loadQuestionWithOptions(session, args.questionId, ctx.tenantId)
  }, true)
}
