/**
 * Field visibility/requirement rules — implementation and GraphQL documents in
 * `@opengraphity/web-core` (shared with apps/web). Re-exported so existing
 * imports (`@/hooks/useFormFieldRules`) keep working.
 */
export {
  useFormFieldRules,
  validateFormFields,
  type FieldRules,
} from '@opengraphity/web-core'
