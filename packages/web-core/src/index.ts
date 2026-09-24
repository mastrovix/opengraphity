export { getTenantSlug, requireTenantSlug, type RequireTenantSlugOptions } from './tenantSlug.js'
export { mostraSchermataDiStop, resetSchermataDiStop, type SchermataDiStop } from './stopScreen.js'
export { createKeycloak, redirectUriPulito, type CreateKeycloakOptions, type KeycloakHandle } from './keycloak.js'
export { type ClientLogger, consoleLogger } from './logger.js'
export { createClientLogger } from './clientLogger.js'
export {
  createTokenRefresh,
  DEFAULT_TOKEN_REFRESH_MESSAGES,
  DEFAULT_BACKOFF_MS,
  type CreateTokenRefreshOptions,
  type KeycloakLike,
  type RefreshNotifier,
  type TokenRefresh,
  type TokenRefreshMessages,
} from './tokenRefresh.js'
export {
  createApolloClient,
  createErrorLink,
  wasNotifiedCentrally,
  errorFieldName,
  errorHasKey,
  createAuthLink,
  createI18nLink,
  type TraduciErrore,
  createDeduper,
  DEFAULT_DEDUPE_MS,
  NETWORK_DEDUPE_KEY,
  TENANT_SUSPENDED_CODE,
  type CreateApolloClientOptions,
  type ErrorLinkOptions,
  type GraphQLErrorInfo,
} from './apollo.js'
export { createApiBase, apiBaseFromGraphqlUri, type ApiBase, type CreateApiBaseOptions } from './apiBase.js'
export { createAttachments, type Attachments } from './attachments.js'
export { GET_FIELD_VISIBILITY_RULES, GET_FIELD_REQUIREMENT_RULES } from './fieldRules.graphql.js'
export {
  useFormFieldRules,
  useFieldVisibility,
  useFieldRequirements,
  validateFormFields,
  evalVisibility,
  evalRequirements,
  mergeFieldRules,
  type FieldRules,
  type VisibilityRule,
  type RequirementRule,
} from './useFormFieldRules.js'
export {
  CatalogFormRenderer,
  visibleCatalogFormItems,
  catalogFormAnswersToSend,
  catalogFormTableAnswers,
  type CatalogFormAnswerToSend,
  type CatalogFormRendererProps,
  type CatalogFormTableRow,
  type CatalogFormTableColumnView,
  type CatalogFormFieldView,
  type CatalogFormFile,
  type CatalogFormReference,
} from './CatalogFormRenderer.js'
// D29: a value without a label, shown the way a person wrote it (one rule for web, portal and the catalog form).
export { humanizeValue, optionLabel } from './valueLabel.js'
export { remarkUnderline, UNDERLINE_OPEN, UNDERLINE_CLOSE } from './markdownUnderline.js'
// Le formule dei campi calcolati (ondata 6): il renderer le usa da sé, e la
// pagina della libreria le usa per il pulsante «Prova».
export { runFormula, computeFormulas, type FormulaEsito } from './formulaRunner.js'
export { newBoundedScriptVM, scriptErrorMessage, BROWSER_SCRIPT_DEADLINE_MS, BROWSER_SCRIPT_MEMORY_BYTES, type BoundedScriptVM } from './boundedScript.js'
