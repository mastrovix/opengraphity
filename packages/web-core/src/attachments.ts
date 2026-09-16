import type { ApiBase } from './apiBase.js'

/**
 * REST /api/attachments requires `Authorization: Bearer` — the API's
 * authMiddleware reads the header only, so neither `<a href>` nor a native
 * form submit can be used: upload and download go through `fetch`.
 */
export interface Attachments {
  uploadAttachment(entityType: string, entityId: string, file: File): Promise<void>
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
