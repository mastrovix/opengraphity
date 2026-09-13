import { GraphQLError } from 'graphql'
import { ValidationError } from '../../../lib/errors.js'
import { v4 as uuidv4 } from 'uuid'
import { withSession, runQuery, runQueryOne, type Props } from '../ci-utils.js'
import type { GraphQLContext } from '../../../context.js'
import { logger } from '../../../lib/logger.js'
import { mapAssessmentQuestion, mapAnswerOption } from './mappers.js'

type OptionInput = { label: string; score: number; sortOrder: number }

async function loadQuestionWithOptions(session: ReturnType<typeof import('../ci-utils.js').getSession>, id: string, tenantId: string) {
  const q = await runQueryOne<{ props: Props }>(session, `
    MATCH (q:AssessmentQuestion {id: $id, tenant_id: $tenantId})
    RETURN properties(q) AS props
  `, { id, tenantId })
  if (!q) return null
  const opts = await runQuery<{ props: Props }>(session, `
    // tenant-ok: q già caricata scopata sopra
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
    throw new ValidationError('Il testo della domanda non puo essere vuoto: e cio che l\'operatore legge nel task.')
  }
  if (options === null || options === undefined) return
  if (options.length === 0) throw new ValidationError('Una domanda deve avere almeno una opzione')

  const vuote = options.filter((o) => typeof o.label !== 'string' || o.label.trim() === '')
  if (vuote.length) {
    throw new ValidationError(
      `${vuote.length === 1 ? "Un'opzione di risposta e senza testo" : `${String(vuote.length)} opzioni di risposta sono senza testo`}: ` +
      `nella tendina del task si vedrebbe una voce bianca, e chi la scegliesse non saprebbe cosa ha scelto. ` +
      `Dai un'etichetta a ogni opzione, oppure togli le righe che non servono.`,
    )
  }
  const visti = new Set<string>()
  const doppie = options.map((o) => o.label.trim()).filter((l) => (visti.has(l) ? true : (visti.add(l), false)))
  if (doppie.length) {
    throw new ValidationError(
      `Le opzioni ripetono ${[...new Set(doppie)].map((l) => `"${l}"`).join(', ')}: due risposte con lo stesso testo ` +
      `e punteggi diversi rendono il punteggio di rischio non spiegabile.`,
    )
  }
  const nonNumeriche = options.filter((o) => typeof o.score !== 'number' || !Number.isFinite(o.score))
  if (nonNumeriche.length) {
    throw new ValidationError('Ogni opzione deve avere un punteggio numerico: alimenta il rischio della change.')
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
      `${sottoUno.map((o) => `"${o.label.trim()}"`).join(', ')}: il punteggio deve essere un intero maggiore o ` +
      `uguale a 1. Una risposta che vale 0 non sposta il rischio della change, quindi la domanda non serve a ` +
      `niente: dai alla risposta meno rischiosa il punteggio piu basso (1), non zero.`,
    )
  }
  const distinti = new Set(options.map((o) => o.score))
  if (distinti.size === 1) {
    throw new ValidationError(
      `Tutte le opzioni valgono ${String([...distinti][0])}: rispondere non cambierebbe il rischio della change, ` +
      `quindi la domanda non misura niente. Dai punteggi diversi alle risposte, dal meno al piu rischioso.`,
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
    throw new ValidationError('category deve essere "functional" o "technical"')
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
        // tenant-ok: i tipi base sono condivisi, quelli del cliente sono filtrati sul suo id
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
    throw new ValidationError('category deve essere "functional" o "technical"')
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

    if (options !== undefined) {
      await session.executeWrite((tx) => tx.run(`
        MATCH (q:AssessmentQuestion {id: $id, tenant_id: $tenantId})-[:HAS_OPTION]->(o:AnswerOption)
        DETACH DELETE o
      `, { id, tenantId: ctx.tenantId }))
      await session.executeWrite((tx) => tx.run(`
        MATCH (q:AssessmentQuestion {id: $id, tenant_id: $tenantId})
        UNWIND $options AS opt
        CREATE (o:AnswerOption {
          id: randomUUID(), tenant_id: $tenantId, label: opt.label, score: opt.score, sort_order: opt.sortOrder
        })
        CREATE (q)-[:HAS_OPTION]->(o)
      `, { id, tenantId: ctx.tenantId, options }))
    }

    return loadQuestionWithOptions(session, id, ctx.tenantId)
  }, true)
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
      throw new GraphQLError('Impossibile eliminare: la domanda ha risposte associate', { extensions: { code: 'CONFLICT' } })
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
      MATCH (ct:CITypeDefinition {id: $ciTypeId})
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
      MATCH (ct:CITypeDefinition {id: $ciTypeId})-[rel:HAS_QUESTION]->(q:AssessmentQuestion {id: $questionId, tenant_id: $tenantId})
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
        // tenant-ok: i tipi base sono condivisi, quelli del cliente filtrati sul suo id
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
