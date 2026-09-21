/**
 * Il caricamento dei file di un campo allegato sulla BOZZA di un modulo
 * (moduli del catalogo, ondata 2).
 *
 * L'implementazione sta in `@opengraphity/web-core` — ordine dei campi del
 * multipart, header col bearer, lettura dell'id restituito — perché la usano
 * questa applicazione e il portale: un caricamento che si comporta in due modi
 * diversi nei due posti è il difetto che l'ondata 1 ha già pagato con il
 * renderer.
 */
import { createAttachments } from '@opengraphity/web-core'
import { apiBase } from './apiBase'

const attachments = createAttachments(apiBase)

export const uploadFormDraftFile = attachments.uploadFormDraftFile
