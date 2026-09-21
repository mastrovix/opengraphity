import { apiUrl, authHeader } from '@/lib/apiBase'

export function filenameFromDisposition(header: string | null): string | null {
  if (!header) return null
  const match = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(header)
  return match?.[1] ? decodeURIComponent(match[1]) : null
}

/**
 * Fetches a file (PDF, Excel…) from an authenticated REST endpoint and triggers
 * a browser download. The filename comes from Content-Disposition, falling back
 * to `fallbackFilename`. Throws on non-2xx responses. Never open an `/api/…`
 * path with a plain link: it carries no token (src/__tests__/restDownloads.test.ts).
 */
export async function downloadFile(path: string, fallbackFilename: string): Promise<void> {
  const res = await fetch(apiUrl(path), { headers: authHeader() })
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
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

/** Same as `downloadFile`; kept for the ticket PDF call sites. */
export const downloadPdf = downloadFile
