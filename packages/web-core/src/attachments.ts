import type { ApiBase } from './apiBase.js'

/**
 * REST /api/attachments requires `Authorization: Bearer` — the API's
 * authMiddleware reads the header only, so neither `<a href>` nor a native
 * form submit can be used: upload and download go through `fetch`.
 */
export interface Attachments {
  uploadAttachment(entityType: string, entityId: string, file: File): Promise<void>
  /**
   * Il caricamento su una BOZZA di modulo (moduli del catalogo, ondata 2): il
   * file va su un identificativo di bozza, non su un ticket che non esiste
   * ancora, e porta il nome del campo a cui risponde. Alla creazione i file
   * passano dalla bozza al ticket.
   *
   * Restituisce l'id del nodo `:Attachment`: serve a poterlo togliere prima di
   * inviare, senza ricaricare la pagina.
   */
  uploadFormDraftFile(draftId: string, fieldName: string, file: File): Promise<{ id: string; filename: string; sizeBytes: number }>
  /** Fetches `downloadUrl` with the bearer and triggers a browser download named `filename`. */
  downloadAttachment(downloadUrl: string, filename: string): Promise<void>
}

async function errorMessageOf(res: Response): Promise<string> {
  const body = await res.json().catch(() => null) as { error?: unknown } | null
  return typeof body?.error === 'string' && body.error !== '' ? body.error : `${res.status} ${res.statusText}`
}

export function createAttachments(api: ApiBase): Attachments {
  return {
    async uploadAttachment(entityType, entityId, file) {
      const form = new FormData()
      // entityType/entityId BEFORE the file: busboy reads fields in stream
      // order and the backend uses entityId to build the storage path
      form.append('entityType', entityType)
      form.append('entityId', entityId)
      form.append('file', file)

      const res = await fetch(api.apiUrl('/api/attachments'), {
        method:  'POST',
        headers: api.authHeader(),
        body:    form,
      })
      if (!res.ok) throw new Error(await errorMessageOf(res))
    },

    async uploadFormDraftFile(draftId, fieldName, file) {
      const form = new FormData()
      // L'ordine conta: busboy legge i campi nell'ordine del flusso, e il
      // backend usa entityId per costruire il percorso su disco.
      form.append('entityType', 'form_draft')
      form.append('entityId', draftId)
      form.append('fieldName', fieldName)
      form.append('file', file)

      const res = await fetch(api.apiUrl('/api/attachments'), {
        method:  'POST',
        headers: api.authHeader(),
        body:    form,
      })
      if (!res.ok) throw new Error(await errorMessageOf(res))
      const body = await res.json() as { id?: string; filename?: string; sizeBytes?: number }
      if (!body.id) throw new Error('The upload did not return the file id')
      return { id: body.id, filename: body.filename ?? file.name, sizeBytes: Number(body.sizeBytes ?? file.size) }
    },

    async downloadAttachment(downloadUrl, filename) {
      const res = await fetch(downloadUrl, { headers: api.authHeader() })
      if (!res.ok) throw new Error(await errorMessageOf(res))
      const blob = await res.blob()
      const url  = URL.createObjectURL(blob)
      /**
       * L'URL si revoca DOPO (revisione totale · E-42): la revoca sincrona
       * subito dopo `click()` su Firefox e Safari può annullare il download
       * appena avviato — dal portale, a volte, il file non partiva. Il
       * browser ha bisogno che l'URL resti valido per un istante; un minuto
       * è abbondante e non trattiene niente di sensibile (il blob è già in
       * memoria del browser).
       */
      const link = document.createElement('a')
      link.href     = url
      link.download = filename
      // Alcuni browser richiedono che l'elemento sia nel documento.
      link.style.display = 'none'
      document.body.appendChild(link)
      link.click()
      setTimeout(() => {
        link.remove()
        URL.revokeObjectURL(url)
      }, 60_000)
    },
  }
}
