import { gql } from '@apollo/client'

// ── Dashboard ────────────────────────────────────────────────────────────────

export const GET_MY_DASHBOARDS = gql`
  query GetMyDashboards {
    myDashboards {
      id name description role isDefault isPersonal isShared
      visibility createdAt
      createdBy { id name }
      sharedWith { id name }
    }
  }
`

export const GET_DASHBOARD = gql`
  query GetDashboard($id: ID!) {
    dashboard(id: $id) {
      id name description role isDefault isPersonal isShared
      visibility
      createdBy { id name }
      sharedWith { id name }
      widgets {
        id order colSpan
        reportTemplateId reportSectionId
        data error
        reportSection { id title chartType }
        reportTemplate { id name }
      }
      customWidgets {
        id title widgetType entityType metric
        groupByField filterField filterValue timeRange
        size color position dashboardId
      }
    }
  }
`

export const GET_MY_DASHBOARD = gql`
  query GetMyDashboard {
    myDashboard {
      id name description role isDefault isPersonal isShared
      visibility
      widgets {
        id order colSpan reportTemplateId reportSectionId
        data error
        reportSection { id title chartType }
        reportTemplate { id name }
      }
      customWidgets {
        id title widgetType entityType metric
        groupByField filterField filterValue timeRange
        size color position dashboardId
      }
    }
  }
`

export const GET_WIDGET_DATA = gql`
  query GetWidgetData($widgetId: ID!) {
    widgetData(widgetId: $widgetId) {
      value label
      series { label value color }
    }
  }
`

export const GET_WIDGET_DATA_PREVIEW = gql`
  query GetWidgetDataPreview($entityType: String!, $metric: String!, $groupByField: String, $filterField: String, $filterValue: String, $timeRange: String) {
    widgetDataPreview(entityType: $entityType, metric: $metric, groupByField: $groupByField, filterField: $filterField, filterValue: $filterValue, timeRange: $timeRange) {
      value label
      series { label value color }
    }
  }
`
