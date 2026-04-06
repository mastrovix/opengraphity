export function dashboardSDL(): string {
  return `
  # ── Dashboard Configuration ────────────────────────────────────────────────

  type DashboardConfig {
    id: ID!
    name: String!
    description: String
    role: String
    isDefault: Boolean!
    isPersonal: Boolean!
    isShared: Boolean!
    visibility: String!
    createdBy: User
    sharedWith: [Team!]!
    createdAt: String!
    updatedAt: String
    widgets: [DashboardWidget!]!
    customWidgets: [CustomWidget!]!
  }

  # ── Legacy report-based widgets ────────────────────────────────────────────

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

  # ── Custom query-based widgets ─────────────────────────────────────────────

  type CustomWidget {
    id: ID!
    title: String!
    widgetType: String!
    entityType: String!
    metric: String!
    groupByField: String
    filterField: String
    filterValue: String
    timeRange: String
    size: String!
    color: String!
    position: Int!
    dashboardId: ID!
  }

  type WidgetDataPoint {
    label: String!
    value: Float!
    color: String
  }

  type WidgetDataResult {
    value: Float
    label: String
    series: [WidgetDataPoint!]!
  }

  input CreateCustomWidgetInput {
    dashboardId: ID!
    title: String!
    widgetType: String!
    entityType: String!
    metric: String!
    groupByField: String
    filterField: String
    filterValue: String
    timeRange: String
    size: String
    color: String
  }

  input UpdateCustomWidgetInput {
    title: String
    widgetType: String
    entityType: String
    metric: String
    groupByField: String
    filterField: String
    filterValue: String
    timeRange: String
    size: String
    color: String
    position: Int
  }

  input CreateDashboardInput {
    name: String!
    description: String
    role: String
    visibility: String!
    isShared: Boolean
    sharedWithTeamIds: [ID!]
  }

  input UpdateDashboardInput {
    name: String
    description: String
    role: String
    visibility: String
    isShared: Boolean
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
