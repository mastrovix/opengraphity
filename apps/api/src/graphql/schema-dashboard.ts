export function dashboardSDL(): string {
  return `
  # ── Dashboard Configuration ────────────────────────────────────────────────

  type DashboardConfig {
    id: ID!
    name: String!
    isDefault: Boolean!
    isPersonal: Boolean!
    visibility: String!
    createdBy: User
    sharedWith: [Team!]!
    createdAt: String!
    updatedAt: String
    widgets: [DashboardWidget!]!
  }

  type DashboardWidget {
    id: ID!
    order: Int!
    colSpan: Int!
    reportTemplateId: ID!
    reportSectionId: ID!
    reportTemplate: ReportTemplate
    reportSection: ReportSection
    data: String
    error: String
  }

  input CreateDashboardInput {
    name: String!
    visibility: String!
    sharedWithTeamIds: [ID!]
  }

  input UpdateDashboardInput {
    name: String
    visibility: String
    sharedWithTeamIds: [ID!]
    isDefault: Boolean
  }

  input AddDashboardWidgetInput {
    dashboardId: ID!
    reportTemplateId: ID!
    reportSectionId: ID!
    colSpan: Int!
    order: Int
  }

  input UpdateDashboardWidgetInput {
    colSpan: Int
    order: Int
  }
  `
}
