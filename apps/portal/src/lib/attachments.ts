import { keycloak } from './keycloak'

// REST /api/attachments richiede Authorization: Bearer — authMiddleware legge
// solo l'header, quindi né <a href> né form submit nativi funzionano.

function authHeader(): Record<string, string> {
  const token = keycloak.token ?? ''
  return token ? { authorization: `Bearer ${token}` } : {}
}

export async function uploadAttachment(entityType: string, entityId: string, file: File): Promise<void> {
  const form = new FormData()
  // entityType/entityId prima del file: busboy li legge in ordine di stream
  // e il backend usa entityId per costruire il path di salvataggio
  form.append('entityType', entityType)
  form.append('entityId', entityId)
  form.append('file', file)

  const res = await fetch('/api/attachments', {
    method:  'POST',
    headers: authHeader(),
    body:    form,
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText })) as { error?: string }
    throw new Error(body.error ?? res.statusText)
  }
}

export async function downloadAttachment(downloadUrl: string, filename: string): Promise<void> {
  const res = await fetch(downloadUrl, { headers: authHeader() })
  if (!res.ok) throw new Error(res.statusText)
  const blob = await res.blob()
  const url  = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href     = url
  link.download = filename
  link.click()
  URL.revokeObjectURL(url)
}
