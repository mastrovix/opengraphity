import { gql } from '@apollo/client'

// ── Dashboards ───────────────────────────────────────────────────────────────

export const CREATE_DASHBOARD = gql`
  mutation CreateDashboard($input: CreateDashboardInput!) {
    createDashboard(input: $input) {
      id name isDefault isPersonal visibility createdAt
      sharedWith { id name }
    }
  }
`

export const UPDATE_DASHBOARD = gql`
  mutation UpdateDashboard($id: ID!, $input: UpdateDashboardInput!) {
    updateDashboard(id: $id, input: $input) {
      id name isDefault isPersonal visibility
      sharedWith { id name }
    }
  }
`

export const DELETE_DASHBOARD = gql`
  mutation DeleteDashboard($id: ID!) {
    deleteDashboard(id: $id)
  }
`

export const ADD_DASHBOARD_WIDGET = gql`
  mutation AddDashboardWidget($input: AddDashboardWidgetInput!) {
    addDashboardWidget(input: $input) {
      id name widgets {
        id order colSpan reportTemplateId reportSectionId
        data error
        reportSection { id title chartType }
        reportTemplate { id name }
      }
    }
  }
`

export const REMOVE_DASHBOARD_WIDGET = gql`
  mutation RemoveDashboardWidget($widgetId: ID!) {
    removeDashboardWidget(widgetId: $widgetId) {
      id widgets { id order colSpan reportTemplateId reportSectionId }
    }
  }
`

export const UPDATE_DASHBOARD_WIDGET = gql`
  mutation UpdateDashboardWidget($widgetId: ID!, $input: UpdateDashboardWidgetInput!) {
    updateDashboardWidget(widgetId: $widgetId, input: $input) {
      id widgets { id order colSpan }
    }
  }
`

export const REORDER_DASHBOARD_WIDGETS = gql`
  mutation ReorderDashboardWidgets($dashboardId: ID!, $widgetIds: [ID!]!) {
    reorderDashboardWidgets(dashboardId: $dashboardId, widgetIds: $widgetIds) {
      id widgets { id order colSpan }
    }
  }
`

export const SAVE_DASHBOARD_LAYOUT = gql`
  mutation SaveDashboardLayout($dashboardId: ID!, $widgets: [DashboardLayoutWidgetInput!]!) {
    saveDashboardLayout(dashboardId: $dashboardId, widgets: $widgets) {
      id name
      widgets {
        id order colSpan
        reportTemplateId reportSectionId
        data error
        reportSection { id title chartType }
        reportTemplate { id name }
      }
    }
  }
`

export const CLONE_DASHBOARD = gql`
  mutation CloneDashboard($id: ID!, $newName: String!) {
    cloneDashboard(id: $id, newName: $newName) {
      id name description role isDefault isShared visibility
    }
  }
`

// ── Custom widgets ───────────────────────────────────────────────────────────

export const CREATE_CUSTOM_WIDGET = gql`
  mutation CreateCustomWidget($input: CreateCustomWidgetInput!) {
    createCustomWidget(input: $input) {
      id title widgetType entityType metric
      groupByField filterField filterValue timeRange
      size color position dashboardId
    }
  }
`

export const UPDATE_CUSTOM_WIDGET = gql`
  mutation UpdateCustomWidget($id: ID!, $input: UpdateCustomWidgetInput!) {
    updateCustomWidget(id: $id, input: $input) {
      id title widgetType entityType metric
      groupByField filterField filterValue timeRange
      size color position dashboardId
    }
  }
`

export const DELETE_CUSTOM_WIDGET = gql`
  mutation DeleteCustomWidget($id: ID!) {
    deleteCustomWidget(id: $id)
  }
`

export const REORDER_CUSTOM_WIDGETS = gql`
  mutation ReorderCustomWidgets($dashboardId: ID!, $widgetIds: [ID!]!) {
    reorderCustomWidgets(dashboardId: $dashboardId, widgetIds: $widgetIds) {
      id position
    }
  }
`
