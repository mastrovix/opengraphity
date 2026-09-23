/**
 * TWENTY REPORTS OF THE REPORT BUILDER, AND A DASHBOARD (23 Sep 2026).
 *
 * Built with the app's own mutations, as a person does in the Report Builder:
 * `createReportTemplate`, then `addReportSection` — which validates every
 * section against the tenant's report whitelist (labels, fields,
 * relationships, chart rules) before storing it. Then the dashboard, with
 * `createDashboard` and `saveDashboardLayout`, showing some of the reports.
 *
 * Status filters use the step names of the tenant's own workflows: a status
 * is a step, and the open steps are the ones the definitions say are open.
 */
import type { GraphQLContext } from '../../../auth/resolveAuth.js'
import { customReportResolvers } from '../../../graphql/resolvers/customReports.js'
import { createDashboard } from '../../../graphql/resolvers/dashboard/dashboardMutations.js'
import { saveDashboardLayout } from '../../../graphql/resolvers/dashboard/widgetMutations.js'
import type { SectionInput } from '../../../graphql/resolvers/customReports.js'
import type { TicketWorkflows, WorkflowEntity } from './workflowModel.js'

type Node = SectionInput['nodes'][number]

const root = (label: string, entityType = label, extra: Partial<Node> = {}): Node => ({
  id: 'node_root', entityType, neo4jLabel: label, label, isResult: true, isRoot: true, positionX: 300, positionY: 80,
  filters: null, selectedFields: [], ...extra,
})

const filters = (...rules: Array<{ field: string; operator: string; value: unknown }>): string => JSON.stringify(rules)

function section(title: string, chartType: string, nodes: Node[], rest: Partial<SectionInput> = {}): SectionInput {
  return { title, chartType, metric: 'count', metricField: null, groupByNodeId: null, groupByField: null, groupByGranularity: null,
    limit: 20, sortDir: 'DESC', nodes, edges: [], ...rest }
}

/** The open steps of an entity's workflows (not terminal, open). */
function openSteps(workflows: TicketWorkflows, entity: WorkflowEntity): string[] {
  const names = new Set<string>()
  for (const d of workflows.all.filter((x) => x.entityType === entity)) {
    for (const s of d.steps.values()) if (!s.isTerminal && s.isOpen) names.add(s.name)
  }
  return [...names]
}

export interface DemoReport { name: string; description: string; sections: SectionInput[] }

/**
 * D52 (tour of 23 Sep 2026): a few of the reports began as a question to the
 * AI report designer (`proposeReportSection`) — the administrator described
 * the chart, took the proposal, and added the section. The question is what
 * the Audit Log keeps (the mutation registry writes the entry).
 */
export const AI_PROPOSED_SECTIONS: Readonly<Record<string, string>> = {
  'Incident Trend': 'How many incidents do we open each month?',
  'Busiest Teams': 'Which teams get the most incidents?',
  'Change Trend': 'Show the changes raised per month over the last years',
  'Open Service Requests': 'How many requests are still open, by status?',
}

export function demoReports(workflows: TicketWorkflows): DemoReport[] {
  const openIncident = openSteps(workflows, 'incident')
  const openProblem = openSteps(workflows, 'problem')
  const openChange = openSteps(workflows, 'change')
  const openRequest = openSteps(workflows, 'service_request')
  const teamEdge = (from = 'node_root') => ({ id: 'edge_team', sourceNodeId: from, targetNodeId: 'node_team', relationshipType: 'ASSIGNED_TO_TEAM', direction: 'outgoing', label: '→ ASSIGNED_TO_TEAM' })
  const teamNode: Node = { id: 'node_team', entityType: 'Team', neo4jLabel: 'Team', label: 'Team', isResult: false, isRoot: false, positionX: 300, positionY: 280, filters: null, selectedFields: [] }
  return [
    { name: 'Incidents by Severity', description: 'All incidents grouped by severity.', sections: [
      section('Incidents by severity', 'bar', [root('Incident')], { groupByField: 'severity' })] },
    { name: 'Incident Trend', description: 'Incidents opened per month.', sections: [
      section('Incidents per month', 'line', [root('Incident')], { groupByField: 'created_at', groupByGranularity: 'month', limit: 40 })] },
    { name: 'Open Incidents', description: 'Incidents not yet resolved.', sections: [
      section('Open incidents', 'kpi', [root('Incident', 'Incident', { filters: filters({ field: 'status', operator: 'in', value: openIncident }) })]),
      section('Open incidents by status', 'bar', [root('Incident', 'Incident', { filters: filters({ field: 'status', operator: 'in', value: openIncident }) })], { groupByField: 'status' })] },
    { name: 'Incidents by Category', description: 'What breaks most often.', sections: [
      section('Incidents by category', 'pie', [root('Incident')], { groupByField: 'category' })] },
    { name: 'Busiest Teams', description: 'The teams with the most incidents assigned.', sections: [
      section('Incidents per team (top 10)', 'top_n', [root('Incident', 'Incident', { isResult: true }), teamNode],
        { groupByNodeId: 'node_team', groupByField: 'name', limit: 10, edges: [teamEdge()] })] },
    { name: 'Incidents Last 90 Days', description: 'Recent incidents by severity.', sections: [
      section('Last 90 days by severity', 'donut', [root('Incident', 'Incident', { filters: filters({ field: 'created_at', operator: 'last_n_days', value: 90 }) })], { groupByField: 'severity' })] },
    { name: 'Problems by Status', description: 'Where the problems stand.', sections: [
      section('Problems by status', 'bar', [root('Problem')], { groupByField: 'status' })] },
    { name: 'Problem Trend', description: 'Problems opened per month.', sections: [
      section('Problems per month', 'area', [root('Problem')], { groupByField: 'created_at', groupByGranularity: 'month', limit: 40 })] },
    { name: 'Open Problems', description: 'Problems still under work.', sections: [
      section('Open problems', 'kpi', [root('Problem', 'Problem', { filters: filters({ field: 'status', operator: 'in', value: openProblem }) })])] },
    { name: 'Changes by Status', description: 'The change pipeline.', sections: [
      section('Changes by status', 'bar', [root('Change')], { groupByField: 'status' })] },
    { name: 'Change Trend', description: 'Changes raised per month.', sections: [
      section('Changes per month', 'area', [root('Change')], { groupByField: 'created_at', groupByGranularity: 'month', limit: 40 })] },
    { name: 'Changes by Priority', description: 'Priority mix of the changes.', sections: [
      section('Changes by priority', 'donut', [root('Change')], { groupByField: 'priority' })] },
    { name: 'Open Changes', description: 'Changes not yet closed.', sections: [
      section('Open changes', 'kpi', [root('Change', 'Change', { filters: filters({ field: 'status', operator: 'in', value: openChange }) })])] },
    { name: 'Service Request Trend', description: 'Requests submitted per month.', sections: [
      section('Requests per month', 'line', [root('ServiceRequest')], { groupByField: 'created_at', groupByGranularity: 'month', limit: 40 })] },
    { name: 'Service Requests by Priority', description: 'Priority mix of the requests.', sections: [
      section('Requests by priority', 'pie', [root('ServiceRequest')], { groupByField: 'priority' })] },
    { name: 'Open Service Requests', description: 'Requests waiting to be fulfilled.', sections: [
      section('Open requests', 'kpi', [root('ServiceRequest', 'ServiceRequest', { filters: filters({ field: 'status', operator: 'in', value: openRequest }) })]),
      section('Open requests by status', 'bar_horizontal', [root('ServiceRequest', 'ServiceRequest', { filters: filters({ field: 'status', operator: 'in', value: openRequest }) })], { groupByField: 'status' })] },
    { name: 'Servers by Environment', description: 'Where the servers run.', sections: [
      section('Servers by environment', 'bar', [root('Server', 'server')], { groupByField: 'environment' }),
      section('Servers by status', 'pie', [root('Server', 'server')], { groupByField: 'status' })] },
    { name: 'Application Portfolio', description: 'Applications by status and environment.', sections: [
      section('Applications by status', 'bar_horizontal', [root('Application', 'application')], { groupByField: 'status' }),
      section('Applications by environment', 'donut', [root('Application', 'application')], { groupByField: 'environment' })] },
    { name: 'Certificates', description: 'All certificates with their state.', sections: [
      section('Certificates', 'table', [root('Certificate', 'certificate', { selectedFields: ['name', 'status', 'environment', 'expires_at'] })], { limit: 200 })] },
    { name: 'Database Estate', description: 'Database instances and databases by status.', sections: [
      section('Database instances by status', 'pie', [root('DatabaseInstance', 'database_instance')], { groupByField: 'status' }),
      section('Databases by environment', 'bar', [root('Database', 'database')], { groupByField: 'environment' })] },
  ]
}

export interface BuiltReports {
  templates: Array<{ id: string; name: string; sectionIds: string[] }>
  dashboardId: string
  /** addReportSection writes no audit of its own: the registry rows to add. */
  registry: Array<{ mutation: string; returnType: string; args: Record<string, unknown>; result: unknown }>
}

type Resolver = (parent: unknown, args: Record<string, unknown>, ctx: GraphQLContext) => Promise<unknown>

export async function buildReports(ctx: GraphQLContext, reports: DemoReport[], widgetPlan: Array<{ report: string; section: number; colSpan: number }>): Promise<BuiltReports> {
  // Through the resolvers the app mounts (reportMutations and customReports import each other).
  const mutations = customReportResolvers.Mutation as unknown as Record<string, Resolver>
  const create = mutations['createReportTemplate']!
  const addSection = mutations['addReportSection']!
  const templates: BuiltReports['templates'] = []
  const registry: BuiltReports['registry'] = []
  for (const r of reports) {
    const t = await create(null, { input: { name: r.name, description: r.description, visibility: 'all', sharedWithTeamIds: [] } }, ctx) as { id: string }
    let last: { sections?: Array<{ id: string }> } = {}
    for (const s of r.sections) {
      last = await addSection(null, { templateId: t.id, input: s }, ctx) as { sections?: Array<{ id: string }> }
      registry.push({ mutation: 'addReportSection', returnType: 'ReportTemplate!', args: { templateId: t.id, input: s }, result: last })
    }
    templates.push({ id: t.id, name: r.name, sectionIds: (last.sections ?? []).map((x) => x.id) })
  }
  const dash = await createDashboard(null, { input: { name: 'Operations Overview', description: 'Incidents, problems, changes and requests at a glance.', visibility: 'all' } } as never, ctx) as { id: string }
  const widgets = widgetPlan.map((w) => {
    const t = templates.find((x) => x.name === w.report)
    if (!t || !t.sectionIds[w.section]) throw new Error(`buildReports: no section ${String(w.section)} in "${w.report}"`)
    return { reportTemplateId: t.id, reportSectionId: t.sectionIds[w.section]!, colSpan: w.colSpan }
  })
  await saveDashboardLayout(null, { dashboardId: dash.id, widgets } as never, ctx)
  return { templates, dashboardId: dash.id, registry }
}

export const DASHBOARD_WIDGETS: Array<{ report: string; section: number; colSpan: number }> = [
  { report: 'Open Incidents', section: 0, colSpan: 4 },
  { report: 'Open Problems', section: 0, colSpan: 4 },
  { report: 'Open Service Requests', section: 0, colSpan: 4 },
  { report: 'Incident Trend', section: 0, colSpan: 12 },
  { report: 'Incidents by Severity', section: 0, colSpan: 6 },
  { report: 'Busiest Teams', section: 0, colSpan: 6 },
  { report: 'Changes by Status', section: 0, colSpan: 6 },
  { report: 'Service Request Trend', section: 0, colSpan: 6 },
]
