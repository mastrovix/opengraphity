/**
 * Il caricamento dei file di un campo allegato sulla BOZZA di un modulo
 * (moduli del catalogo, ondata 2). Stessa implementazione dell'area di lavoro:
 * `@opengraphity/web-core`.
 */
import { createAttachments } from '@opengraphity/web-core'
import { api } from './api'

const attachments = createAttachments(api)

export const uploadFormDraftFile = attachments.uploadFormDraftFile
