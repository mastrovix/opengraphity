/**
 * Il doppio di `lib/portalSeverityOptions.ts` per i test del portale che NON
 * parlano delle severità offerte: risponde con le tre scelte seminate dalla
 * migrazione (low/medium/high), senza grafo.
 *
 *     vi.mock('../../../lib/portalSeverityOptions.js', () => import('../../../lib/__tests__/portalSeverityOptionsFake.js'))
 */
export const PORTAL_SEVERITY_VOCABULARY = 'severity'
export const PORTAL_SEVERITY_LABEL_MAX = 80

const OPTIONS = [
  { value: 'low', labels: { en: 'Low', it: 'Bassa' } },
  { value: 'medium', labels: { en: 'Medium', it: 'Media' } },
  { value: 'high', labels: { en: 'High', it: 'Alta' } },
]

export function portalSeverityOptions(_tenantId: string): Promise<typeof OPTIONS> {
  return Promise.resolve(OPTIONS)
}

export function portalSeverityChoices(_tenantId: string, language: 'en' | 'it'): Promise<{ value: string; label: string; color: null }[]> {
  return Promise.resolve(OPTIONS.map((o) => ({ value: o.value, label: o.labels[language], color: null })))
}

export function setPortalSeverityOptions(): Promise<never> {
  return Promise.reject(new Error('portalSeverityOptionsFake: questo doppio non scrive. Il test che misura la scrittura usi il modulo vero.'))
}
