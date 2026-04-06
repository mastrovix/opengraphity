export function fieldRulesSDL(): string {
  return `#graphql

  # ── Field Visibility Rules ────────────────────────────────────────────────────

  type FieldVisibilityRule {
    id:           ID!
    entityType:   String!
    triggerField: String!
    triggerValue: String!
    targetField:  String!
    action:       String!   # "show" | "hide"
  }

  # ── Field Requirement Rules ───────────────────────────────────────────────────

  type FieldRequirementRule {
    id:           ID!
    entityType:   String!
    fieldName:    String!
    required:     Boolean!
    workflowStep: String   # null = all steps
  }
  `
}
