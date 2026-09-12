export { loadMetamodel, generateSDL, loadITILTypes, generateITILEnumsSDL, metamodelSDL } from './generator.js'
export type { EnumScope } from './generator.js'
export { toPascalCase, pluralize, toSnakeCase } from './stringUtils.js'
export {
  CI_TYPE_NAME_RE, CI_FIELD_NAME_RE,
  RESERVED_CI_PROPERTY_KEYS, RESERVED_CI_PROPERTY_PREFIXES,
  BASE_TYPE_FIELDS, BASE_INPUT_FIELDS,
  MetamodelNameError,
  emptyReservedNames, mergeReservedNames, emittedNamesForCIType, reservedNamesForCITypes,
  suggestCITypeName, suggestCIFieldName,
  assertCITypeName, assertCIFieldName, assertGeneratableNames,
} from './nameValidation.js'
export type { NameRule, ReservedSchemaNames, CIFieldNameContext } from './nameValidation.js'
export type {
  CITypeWithDefinitions,
  CIFieldDefinition,
  CIRelationDefinition,
  CISystemRelationDefinition,
} from './types.js'
