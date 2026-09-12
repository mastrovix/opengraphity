/**
 * I permessi che una chiave API può avere — in **un posto solo** (D-26).
 *
 * ## Il difetto
 * La lista mentiva in due direzioni. `IntegrationsPage.tsx` offriva `ci:write`,
 * che **nessuna rotta REST** richiede (nessun endpoint scrive CI): una capacità
 * promessa e inesistente. E non offriva `kb:write`, che invece
 * `POST /api/v1/import/kb-articles` richiede: l'admin creava la chiave
 * dall'interfaccia, l'integrazione prendeva 403 «Missing permissions:
 * kb:write», e l'unico modo di ottenerlo era chiamare la mutation GraphQL a
 * mano. Sopra a tutto, `createApiKey` salvava i permessi **senza validarli**,
 * quindi un refuso (`incident:read` al singolare) diventava una chiave che non
 * poteva fare niente, senza un avviso.
 *
 * ## La regola
 * Questo elenco è la sorgente unica: lo legge la pagina (che offre solo questi),
 * lo legge `createApiKey`/`updateApiKey` (che rifiutano il resto nominando gli
 * ammessi), e un lint statico
 * (`apps/api/src/rest/__tests__/apiKeyPermissions.test.ts`) verifica che ogni
 * letterale di `requirePermission` nelle rotte sia qui e viceversa — così la
 * lista non può tornare a mentire in nessuna delle due direzioni.
 *
 * Vive in `@opengraphity/types` perché lo leggono in due, API e web, e il web
 * non dipende dall'API.
 */
export const API_KEY_PERMISSIONS = [
  'incidents:read', 'incidents:write',
  'changes:read',   'changes:write',
  'problems:read',  'problems:write',
  'ci:read',
  'kb:read',        'kb:write',
] as const

export type ApiKeyPermission = typeof API_KEY_PERMISSIONS[number]

/** Il permesso è fra quelli applicati da una rotta? */
export function isApiKeyPermission(value: unknown): value is ApiKeyPermission {
  return typeof value === 'string' && (API_KEY_PERMISSIONS as readonly string[]).includes(value)
}
