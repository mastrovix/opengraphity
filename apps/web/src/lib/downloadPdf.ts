import { keycloak } from '@/lib/keycloak'

export function authHeader(): Record<string, string> {
  const token = keycloak.token ?? localStorage.getItem('og_token') ?? ''
  return token ? { authorization: `Bearer ${token}` } : {}
}

export function filenameFromDisposition(header: string | null): string | null {
  if (!header) return null
  const match = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(header)
  return match?.[1] ? decodeURIComponent(match[1]) : null
}

/**
 * Fetches a PDF from an authenticated REST endpoint and triggers a browser
 * download. The filename comes from Content-Disposition, falling back to
 * `fallbackFilename`. Throws on non-2xx responses.
 */
export async function downloadPdf(url: string, fallbackFilename: string): Promise<void> {
  const res = await fetch(url, { headers: authHeader() })
  if (!res.ok) throw new Error(res.statusText)
  const blob     = await res.blob()
  const filename = filenameFromDisposition(res.headers.get('Content-Disposition'))
    ?? fallbackFilename
  const objectUrl = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href     = objectUrl
  link.download = filename
  link.click()
  URL.revokeObjectURL(objectUrl)
}
