import { valueFromASTUntyped, type GraphQLArgument } from 'graphql'

/**
 * IL VALORE DI DEFAULT DICHIARATO PER UN ARGOMENTO DELLO SCHEMA.
 *
 * Si legge dall'AST, non da `arg.defaultValue`, perché graphql 17 ha spostato
 * dove sta scritto (21 set 2026): su uno schema costruito da SDL il default
 * non viene più coercizzato in `defaultValue` — che resta `undefined` — ma
 * conservato come letterale in `arg.default.literal`.
 *
 * Il COMPORTAMENTO non cambia: una query che non passa l'argomento riceve lo
 * stesso valore di prima, e l'SDL stampato mostra sempre `= 100`. Verificato
 * eseguendo davvero una query sulla 17 prima di toccare questi test.
 *
 * `astNode.defaultValue` c'è sia nella 16 sia nella 17 ed è la SORGENTE di
 * entrambe le forme: leggere di lì significa controllare quello che il
 * contratto dichiara, invece di come la libreria di turno se lo conserva.
 */
export function defaultDichiarato(arg: GraphQLArgument): unknown {
  const letterale = arg.astNode?.defaultValue
  return letterale ? valueFromASTUntyped(letterale) : undefined
}
