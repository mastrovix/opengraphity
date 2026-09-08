/**
 * One place for "where is the REST API and how do I authenticate to it".
 * The GraphQL endpoint (`VITE_API_URL`, e.g. `/graphql` or
 * `https://api.example.com/graphql`) is the only configured URL; REST paths
 * (`/api/attachments`, `/api/logs/client`, ...) live next to it.
 */
export interface ApiBase {
  /** Origin/prefix without trailing slash; `''` for same-origin relative paths. */
  baseUrl: string
  /** `apiUrl('/api/attachments')` → `${baseUrl}/api/attachments`. `path` must start with `/`. */
  apiUrl(path: string): string
  /** `{ authorization: 'Bearer …' }` or `{}` when there is no token (REST reads the header only). */
  authHeader(): Record<string, string>
}

export interface CreateApiBaseOptions {
  baseUrl: string
  getToken: () => string | undefined
}

/** `/graphql` → `''`; `https://h/graphql` → `https://h`; anything else is returned untouched (trailing slash removed). */
export function apiBaseFromGraphqlUri(graphqlUri: string): string {
  return graphqlUri.replace(/\/graphql\/?$/, '').replace(/\/$/, '')
}

export function createApiBase(opts: CreateApiBaseOptions): ApiBase {
  const baseUrl = opts.baseUrl.replace(/\/$/, '')
  return {
    baseUrl,
    apiUrl(path: string): string {
      if (!path.startsWith('/')) {
        throw new Error(`apiUrl: il path deve iniziare con "/" (ricevuto "${path}")`)
      }
      return `${baseUrl}${path}`
    },
    authHeader(): Record<string, string> {
      const token = opts.getToken()
      return token ? { authorization: `Bearer ${token}` } : {}
    },
  }
}
