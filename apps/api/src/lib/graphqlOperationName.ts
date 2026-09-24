/**
 * The name of the GraphQL operation a request asks for, for the slow-query
 * panel and the logs (wave 7 · A2).
 *
 * It comes from the client, so it is kept only when it is a GraphQL name of a
 * sensible length; anything else is said as what it is. Apollo refuses a
 * request whose `operationName` names no operation of its document, so a
 * name that gets this far is the one that runs.
 */
const GRAPHQL_NAME = /^[_A-Za-z][_0-9A-Za-z]{0,99}$/

export function graphqlOperationName(body: unknown): string {
  if (Array.isArray(body)) return 'batch'
  const name = (body as { operationName?: unknown } | null | undefined)?.operationName
  if (name === undefined || name === null || name === '') return 'anonymous'
  return typeof name === 'string' && GRAPHQL_NAME.test(name) ? name : 'invalid name'
}
