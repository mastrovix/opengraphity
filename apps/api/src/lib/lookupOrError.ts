/**
 * Strict map lookup: throws on an unknown key.
 *
 * Deliberately has NO fallback parameter — an unknown key means corrupt input
 * or stale config, and substituting a default would show the caller
 * plausible-but-wrong data (e.g. "failed" jobs presented as whatever status
 * the user actually asked for).
 */
export function lookupOrError<T>(map: Record<string, T>, key: string, mapName: string): T {
  const val = map[key]
  if (val === undefined) {
    throw new Error(`[${mapName}] valore sconosciuto: "${key}" (validi: ${Object.keys(map).join(', ')})`)
  }
  return val
}
