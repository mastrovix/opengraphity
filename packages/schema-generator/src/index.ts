export { loadMetamodel, generateSDL, loadITILTypes, generateITILEnumsSDL, metamodelSDL } from './generator.js'
export type { EnumScope } from './generator.js'
export { toPascalCase, pluralize } from './stringUtils.js'
export type {
  CITypeWithDefinitions,
  CIFieldDefinition,
  CIRelationDefinition,
  CISystemRelationDefinition,
} from './types.js'
