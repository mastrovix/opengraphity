export { getTenantSlug, requireTenantSlug, type RequireTenantSlugOptions } from './tenantSlug.js'
export { createKeycloak, type CreateKeycloakOptions, type KeycloakHandle } from './keycloak.js'
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
  createAuthLink,
  createI18nLink,
  type TraduciErrore,
  createDeduper,
  DEFAULT_DEDUPE_MS,
  NETWORK_DEDUPE_KEY,
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
  type CatalogFormAnswerToSend,
  type CatalogFormRendererProps,
  type CatalogFormFieldView,
  type CatalogFormFile,
  type CatalogFormReference,
} from './CatalogFormRenderer.js'
// Le formule dei campi calcolati (ondata 6): il renderer le usa da sé, e la
// pagina della libreria le usa per il pulsante «Prova».
export { runFormula, computeFormulas, type FormulaEsito } from './formulaRunner.js'
