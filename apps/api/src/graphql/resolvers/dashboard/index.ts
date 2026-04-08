import {
  myDashboards,
  myDashboard,
  dashboard,
  dashboardWidgets,
  dashboardCreatedBy,
  dashboardSharedWith,
  dashboardCustomWidgets,
  widgetReportTemplate,
  widgetReportSection,
  widgetData,
  widgetError,
} from './dashboardQueries.js'

import {
  createDashboard,
  updateDashboard,
  deleteDashboard,
  cloneDashboard,
} from './dashboardMutations.js'

import {
  addDashboardWidget,
  removeDashboardWidget,
  updateDashboardWidget,
  reorderDashboardWidgets,
} from './widgetMutations.js'

export const dashboardResolvers = {
  Query: {
    myDashboards,
    myDashboard,
    dashboard,
  },
  Mutation: {
    createDashboard,
    updateDashboard,
    deleteDashboard,
    cloneDashboard,
    addDashboardWidget,
    removeDashboardWidget,
    updateDashboardWidget,
    reorderDashboardWidgets,
  },
  DashboardConfig: {
    widgets:       dashboardWidgets,
    createdBy:     dashboardCreatedBy,
    sharedWith:    dashboardSharedWith,
    customWidgets: dashboardCustomWidgets,
  },
  DashboardWidget: {
    reportTemplate: widgetReportTemplate,
    reportSection:  widgetReportSection,
    data:           widgetData,
    error:          widgetError,
  },
}
