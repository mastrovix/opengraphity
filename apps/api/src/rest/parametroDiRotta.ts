/**
 * UN PARAMETRO DI ROTTA È UNA STRINGA, E SE NON LO È SI DICE (21 set 2026).
 *
 * Con express 5 i tipi di `req.params` sono cambiati:
 *
 *     interface ParamsDictionary { [key: string]: string | string[] }
 *
 * Non è un capriccio dei tipi: `path-to-regexp` v8, che express 5 usa per le
 * rotte, ammette i parametri RIPETUTI — `/:id+` cattura `/a/b/c` e consegna
 * `['a','b','c']`. Quindi il tipo dice la verità su ciò che express PUÒ dare.
 *
 * Le nostre rotte non ne dichiarano nessuno: sono tutte `/:id`, `/:slug`,
 * `/:tenantId`. Perciò l'array non può arrivare — ma «non può arrivare» è una
 * cosa che vale finché qualcuno non scrive la prima rotta ripetuta, e quel
 * giorno il difetto sarebbe muto: un `String(['a','b'])` che diventa «a,b» e
 * una query che non trova niente, senza un errore da nessuna parte.
 *
 * Quindi non si mette un `as string` a tacere il compilatore. Si legge, e se
 * un giorno arriva un array lo si grida.
 */
import type { Request } from 'express'
import { ValidationError } from '../lib/errors.js'

/**
 * Il parametro `nome` della rotta, come stringa.
 *
 * Alza `ValidationError` se manca o se è un array: entrambe le cose, con le
 * rotte di oggi, sono impossibili — e se diventano possibili chi le ha rese
 * tali lo scopre al primo giro, non dai dati sbagliati di un cliente.
 */
export function parametro(req: Request, nome: string): string {
  const grezzo = req.params[nome]
  if (typeof grezzo === 'string' && grezzo !== '') return grezzo
  if (Array.isArray(grezzo)) {
    throw new ValidationError(
      `route parameter "${nome}" arrived as a list (${grezzo.length} values): this route declares a repeated parameter, which no caller of this helper expects`,
      { key: 'errors.rest.repeatedRouteParam', params: { name: nome } },
    )
  }
  throw new ValidationError(
    `route parameter "${nome}" is missing`,
    { key: 'errors.rest.missingRouteParam', params: { name: nome } },
  )
}

/** Come `parametro`, ma per i parametri che possono legittimamente mancare. */
export function parametroOpzionale(req: Request, nome: string): string | undefined {
  const grezzo = req.params[nome]
  if (grezzo === undefined) return undefined
  return parametro(req, nome)
}
