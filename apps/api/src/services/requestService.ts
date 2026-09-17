import { v4 as uuidv4 } from 'uuid'
import { customFieldDefs, resolveCustomFieldWrites, type CustomFieldInput } from '../lib/ticketCustomFields.js'
import {
  claimDraftAttachments, formFieldsByName, parseCatalogForm, resolveFormWrites,
  writeFormReferences, writeFormTables,
  type FormAnswerInput, type FormReferenceWrite, type FormTableWrite,
} from '../lib/catalogForm.js'
import { catalogFormLimits as leggiTetti } from '../lib/catalogFormLimits.js'
import { catalogFormFieldNames } from '@opengraphity/types'
import { creationStepContext } from '../lib/customFieldSteps.js'
import { withTicketProps } from '../lib/ticketProps.js'
import { nextTicketNumber } from '../lib/ticketNumbering.js'
import { runQuery } from '@opengraphity/neo4j'
import { withSession } from '../graphql/resolvers/ci-utils.js'
import type { ServiceCtx } from './incidentService.js'
import { publishEvent } from '../lib/publishEvent.js'
import { logger } from '../lib/logger.js'
import { ValidationError } from '../lib/errors.js'
import { initialStepSelection, workflowEngine } from '@opengraphity/workflow'

type Props = Record<string, unknown>

/** Unico mapper ServiceRequest (il resolver ne aveva una copia che perdeva catalogItemId/requiresApproval). */
export function mapRequest(props: Props) {
  return withTicketProps({
    id:          props['id']           as string,
    number:      (props['number'] ?? '') as string,
    tenantId:    props['tenant_id']    as string,
    title:       props['title']        as string,
    description: props['description']  as string | undefined,
    status:      props['status']       as string,
    priority:    props['priority']     as string,
    dueDate:     props['due_date']     as string | undefined,
    completedAt: props['completed_at'] as string | undefined,
    catalogItemId: (props['catalog_item_id'] ?? null) as string | null,
    // La revisione del modulo con cui e stata compilata (moduli del catalogo,
    // ondata 1): il ticket la porta, cosi le risposte si rileggono con il
    // modulo di ALLORA e non con quello di adesso.
    formRevision: props['form_revision'] == null ? null : Number(props['form_revision']),
    category:      (props['category'] ?? null) as string | null,
    requiresApproval: (props['requires_approval'] ?? false) as boolean,
    createdAt:   props['created_at']   as string,
    updatedAt:   props['updated_at']   as string,
    requestedBy: null,
    assignee:    null,
  }, props)
}

export async function createRequest(
  input: { title: string; description?: string; priority: string; category?: string | null; dueDate?: string; catalogItemId?: string; requiresApproval?: boolean; acknowledgeNoSla?: boolean | null; customFields?: CustomFieldInput[] | null; formAnswers?: FormAnswerInput[] | null; formDraftId?: string | null; formRevision?: number | null; workflowDefinitionId?: string | null },
  ctx: ServiceCtx,
  channel: 'agent' | 'portal' = 'agent',
) {
  // Campi personalizzati (ondata 4): solo dai canali che li mandano (vedi createIncident).
  const customProps = input.customFields == null ? {} : await withSession(async (session) =>
    resolveCustomFieldWrites(ctx.tenantId, 'service_request', await customFieldDefs(session, ctx.tenantId, 'service_request'), input.customFields, { current: null, endUser: channel === 'portal', stepContext: await creationStepContext(session, ctx.tenantId, 'service_request', null) }))

  /**
   * Le risposte al modulo della voce di catalogo (moduli del catalogo, ondata 1).
   *
   * Le condizioni di visibilita si RIVALUTANO qui: il browser ha deciso cosa
   * mostrare, il server decide cosa accettare. Senza questo passaggio un campo
   * nascosto da una condizione sarebbe un varco — un obbligatorio aggirabile,
   * o un valore scritto su un campo che non doveva comparire.
   *
   * Il ticket porta la revisione del modulo usato: se domani il modulo cambia,
   * queste risposte si rileggono ancora con la loro.
   */
  const vuoto = { props: {} as Record<string, unknown>, revision: null as number | null, references: [] as FormReferenceWrite[], tables: [] as FormTableWrite[] }
  const { props: formProps, revision: formRevision, references: formReferences, tables: formTables } = await withSession(async (session) => {
    if (!input.catalogItemId) {
      if (input.formAnswers?.length) {
        throw new ValidationError('Form answers were sent without a catalog item: a form belongs to a catalog item.',
          { key: 'errors.catalogForm.answersWithoutItem', params: {} })
      }
      return vuoto
    }
    const row = await runQuery<{ form: string | null; name: string }>(session, `
      MATCH (i:ServiceCatalogItem {id: $itemId, tenant_id: $tenantId})
      RETURN i.form AS form, i.name AS name`, { itemId: input.catalogItemId, tenantId: ctx.tenantId })
    const def = parseCatalogForm(row[0]?.form, `ServiceCatalogItem ${row[0]?.name ?? input.catalogItemId}`)
    if (!def || def.revision === 0) {
      if (input.formAnswers?.length) {
        throw new ValidationError('This catalog item has no form: there is nothing to answer.',
          { key: 'errors.catalogForm.noForm', params: { item: row[0]?.name ?? input.catalogItemId } })
      }
      return vuoto
    }
    /**
     * IL MODULO E' CAMBIATO MENTRE SI COMPILAVA (ondata 8).
     *
     * Il client manda la revisione che ha compilato. Se non e' quella di adesso,
     * le risposte sono di un ALTRO modulo: un campo tolto diventa «non e' un
     * campo di questo modulo», uno aggiunto e obbligatorio diventa «campo
     * obbligatorio» su una domanda che chi compila non ha mai visto. Due
     * rifiuti veri per un motivo incomprensibile.
     *
     * Quindi si dice la cosa giusta — «il modulo e' cambiato, ricomincia» — e si
     * ferma qui. Non si tenta di recuperare le risposte: alcune potrebbero non
     * avere piu' una domanda, e indovinare quali sono ancora buone sarebbe
     * peggio che rifare il modulo.
     */
    if (input.formRevision != null && input.formRevision !== def.revision) {
      throw new ValidationError(
        `The form of "${row[0]?.name ?? input.catalogItemId}" changed while you were filling it (revision ${input.formRevision} → ${def.revision}): the answers belong to another form.`,
        { key: 'errors.catalogForm.revisionChanged', params: { item: row[0]?.name ?? String(input.catalogItemId), filled: String(input.formRevision), current: String(def.revision) } },
      )
    }
    const library = await formFieldsByName(session, ctx.tenantId, catalogFormFieldNames(def))
    const esito = await resolveFormWrites(session, ctx.tenantId, def, library, input.formAnswers, {
      endUser: channel === 'portal',
      // La bozza degli allegati (ondata 2): i file sono già caricati e portano
      // il nome del campo; qui si conta, per l'obbligatorietà.
      draftId: input.formDraftId ?? null,
      userId: ctx.userId,
      // Il tetto sulle righe di una tabella (ondata 7): tecnico e configurabile
      // come gli altri, letto qui perché la validazione deve poterlo dire.
      maxTableRows: (await leggiTetti(session, ctx.tenantId)).maxTableRows,
    })
    return { props: esito.props, revision: def.revision, references: esito.references, tables: esito.tables }
  })
  const id  = uuidv4()
  const now = new Date().toISOString()

  const created = await withSession(async (session) => {
    // Formato del cliente (verifica «Cosa resta cablato», ondata 6), contatore del prodotto.
    const number = await nextTicketNumber(session, ctx.tenantId, 'service_request')

    /**
     * Il passo iniziale viene dalla STESSA selezione che userà l'istanza
     * (`initialStepSelection` di @opengraphity/workflow), con l'iter della voce
     * di catalogo se c'è e la categoria altrimenti — moduli del catalogo,
     * ondata 3.
     *
     * Prima erano due letture diverse: questa guardava TUTTE le definizioni del
     * tipo e prendeva il primo passo iniziale che trovava. Con una sola
     * definizione per tipo combaciavano per caso; con una definizione per voce
     * il ticket sarebbe nato con lo stato di un iter e l'istanza su un altro.
     */
    const scelta = await session.executeRead((tx) => initialStepSelection(tx, {
      tenantId: ctx.tenantId,
      entityType: 'service_request',
      definitionId: input.workflowDefinitionId ?? null,
      category: input.category ?? null,
    }))
    if (!scelta) {
      // Il messaggio dettagliato lo dà `createInstance`, che distingue i tre
      // casi (nessuna definizione, nessun passo iniziale, categoria che non
      // combacia): qui basta non creare un ticket con uno stato inventato.
      throw new Error(`No usable service_request workflow for tenant "${ctx.tenantId}" (category ${input.category ?? 'none'})`)
    }
    const initialStatus = scelta.stepName

    const rows = await runQuery<{ props: Props }>(session, `
      CREATE (r:ServiceRequest {
        id:                $id,
        tenant_id:         $tenantId,
        number:            $number,
        title:             $title,
        description:       $description,
        status:            $status,
        priority:          $priority,
        category:          $category,
        due_date:          $dueDate,
        catalog_item_id:   $catalogItemId,
        // Chi l'ha aperta, come per gli incident: il portale elenca i propri
        // ticket da qui (revisione totale · H-2) e la regola degli allegati
        // riconosce «il mio» da questa proprietà.
        created_by:        $userId,
        requires_approval: $requiresApproval,
        created_at:        $now,
        updated_at:        $now,
        // Chi l'ha creata ha visto l'avviso «nessuna policy SLA la copre» e
        // l'ha accettato: la diagnostica non la conta fra i ticket senza SLA.
        sla_absence_acknowledged_at: $ackAt,
        sla_absence_acknowledged_by: $ackBy
      })
      SET r.form_revision = $formRevision,
          r += $customProps,
          r += $formProps
      RETURN properties(r) as props
    `, {
      id, tenantId: ctx.tenantId, number, status: initialStatus, userId: ctx.userId,
      title: input.title, description: input.description ?? null,
      priority: input.priority, dueDate: input.dueDate ?? null,
      // La categoria arriva dalla voce del catalogo (verifica «Cosa resta cablato», ondata 2): serve alle policy SLA per categoria.
      category: input.category ?? null,
      catalogItemId: input.catalogItemId ?? null,
      requiresApproval: input.requiresApproval ?? false,
      now,
      ackAt: input.acknowledgeNoSla === true ? now : null,
      ackBy: input.acknowledgeNoSla === true ? ctx.userId : null,
      customProps,
      formProps,
      formRevision,
    })
    if (!rows[0]) throw new Error('Failed to create service request')

    await runQuery(session, `
      MATCH (r:ServiceRequest {id: $id, tenant_id: $tenantId})
      OPTIONAL MATCH (u:User {id: $userId, tenant_id: $tenantId})
      FOREACH (_ IN CASE WHEN u IS NOT NULL THEN [1] ELSE [] END |
        MERGE (r)-[:REQUESTED_BY]->(u)
        // Chi apre la richiesta la segue, come per gli incident.
        MERGE (u)-[w:WATCHES]->(r)
          ON CREATE SET w.watched_at = $now
      )
    `, { id, tenantId: ctx.tenantId, userId: ctx.userId, now })

    /**
     * I riferimenti del modulo (ondata 2) diventano relazioni, e i file della
     * bozza passano al ticket. Entrambi DOPO la CREATE e nella stessa sessione:
     * il nodo deve esistere per essere agganciato, e un fallimento qui fa
     * fallire la creazione invece di lasciare un ticket a metà.
     */
    if (formReferences.length > 0) {
      await writeFormReferences(session, ctx.tenantId, true, id, formReferences)
    }
    // Le righe delle tabelle (ondata 7): nodi appesi al ticket, quindi dopo la
    // CREATE e nella stessa sessione, per la stessa ragione dei riferimenti.
    if (formTables.length > 0) {
      await writeFormTables(session, ctx.tenantId, id, formTables)
    }
    if (input.formDraftId) {
      const reclamati = await claimDraftAttachments(session, ctx.tenantId, input.formDraftId, 'service_request', id, ctx.userId)
      if (reclamati > 0) logger.info({ tenantId: ctx.tenantId, requestId: id, draftId: input.formDraftId, reclamati }, 'Form draft attachments claimed')
    }

    await workflowEngine.createInstance(
      session, ctx.tenantId, id, 'service_request',
      input.workflowDefinitionId ?? undefined, input.category ?? null,
    )

    return mapRequest(rows[0].props)
  }, true)

  await publishEvent('request.created', ctx.tenantId, ctx.userId, { id, title: input.title, priority: input.priority }, now)
  return created
}

/*
 * `completeRequest` non esiste più (revisione del 14 set 2026 · F2). Portava la
 * richiesta al passo per NOME `fulfilled` — aperto, categoria `active` nel
 * workflow di fabbrica — e scriveva a mano `completed_at`: la richiesta
 * risultava conclusa per OLA, report e diagnostica mentre il suo SLA restava
 * aperto. Nessuna pagina la chiamava. Una richiesta si conclude con le
 * transizioni del suo workflow, e il motore scrive `completed_at` entrando in un
 * passo terminale (packages/workflow/src/engine.ts).
 */
