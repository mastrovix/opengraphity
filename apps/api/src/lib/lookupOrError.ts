import { logger } from './logger.js'

export function lookupOrError<T>(map: Record<string, T>, key: string, mapName: string, errorFallback: T): T {
  const val = map[key]
  if (val === undefined) {
    logger.error({ mapName, key }, `[${mapName}] valore sconosciuto: "${key}"`)
    return errorFallback
  }
  return val
}
