/**
 * Quali campi dell'entità un'azione di passo `update_field` può scrivere — e
 * perché lo stato non è fra quelli (B-9).
 *
 * ## Il difetto
 * `status` era nell'elenco, e il pannello del disegnatore offriva
 * `update_field` con la tendina di TUTTI i campi dell'entità: bastava
 * configurare un passo con `update_field(status = closed)` per scrivere lo
 * stato **scavalcando il motore dei workflow**. Da lì `entity.status` e
 * `WorkflowInstance.current_step` divergevano: le liste e il portale
 * mostravano il ticket chiuso, il processo lo teneva aperto, il monitoraggio
 * continuava ad agganciarci allarmi e lo SLA restava in corso. In silenzio, e
 * senza un modo di accorgersene dall'interfaccia.
 *
 * Lo stato dell'entità è **derivato** dal passo: lo scrive il motore nella
 * stessa transazione della transizione. Si cambia con una transizione — a
 * mano, o con un arco `automatic` del workflow. Lo stesso divieto vale già
 * per le automazioni (`SET_FIELD_FORBIDDEN` in `lib/actionExecutor.ts`):
 * questa era l'ultima porta aperta.
 *
 * Vive in `@opengraphity/types` perché lo leggono in tre: il motore a runtime,
 * l'API in scrittura (`assertStepActions`) e il **disegnatore** (la tendina
 * offre solo questi). Il web non dipende da `@opengraphity/workflow`.
 */

/** I campi scrivibili da `update_field`. */
export const UPDATE_FIELD_ALLOWED = ['severity', 'priority', 'description', 'category'] as const
export type UpdateFieldAllowed = (typeof UPDATE_FIELD_ALLOWED)[number]

/**
 * Campi che appartengono al motore: rifiutati con il motivo, non con un
 * generico «non ammesso», perché chi li configura sta cercando di fare una
 * cosa legittima (cambiare stato) dalla porta sbagliata.
 */
export const UPDATE_FIELD_ENGINE_OWNED = ['status', 'workflow_step', 'workflow_instance_id'] as const

/**
 * `null` se il campo è scrivibile; altrimenti il messaggio di rifiuto —
 * lo stesso a runtime, in scrittura e nel disegnatore, così l'amministratore
 * legge una frase sola.
 */
export function updateFieldRejection(field: string): string | null {
  if ((UPDATE_FIELD_ALLOWED as readonly string[]).includes(field)) return null
  if ((UPDATE_FIELD_ENGINE_OWNED as readonly string[]).includes(field)) {
    return `il campo "${field}" lo scrive il motore dei workflow e non si cambia con un'azione di passo: ` +
      `usa una transizione (un arco del workflow, anche "automatic"), altrimenti lo stato del ticket e il passo del ` +
      `processo divergono. Campi ammessi: ${UPDATE_FIELD_ALLOWED.join(', ')}.`
  }
  return `il campo "${field}" non è fra quelli che update_field può scrivere (${UPDATE_FIELD_ALLOWED.join(', ')}).`
}
