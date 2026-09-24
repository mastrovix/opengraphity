/**
 * The two export mutations of the Reports page. The files are made by
 * services/reportExport.ts (wave 7 · C1: the report scheduler and the REST
 * download use it too, and they are not resolvers); here, only who may export
 * and the Audit Log entry.
 */
import { getSession } from '@opengraphity/neo4j'
import type { GraphQLContext } from '../../context.js'
import { audit } from '../../lib/audit.js'
import { generateReportFile } from '../../services/reportExport.js'
import { assertReportTemplateAccess } from './reportAccess.js'

async function exportReport(format: 'pdf' | 'excel', args: { templateId: string }, ctx: GraphQLContext): Promise<string> {
  const accessSession = getSession(undefined, 'READ')
  try {
    await assertReportTemplateAccess(accessSession, args.templateId, ctx, 'read')
  } finally {
    await accessSession.close()
  }

  const { filename } = await generateReportFile(format, args.templateId, ctx.tenantId, ctx.permissions)
  void audit(ctx, `report.export_${format === 'pdf' ? 'pdf' : 'xlsx'}`, 'ReportTemplate', args.templateId)
  return `/api/reports/${filename}`
}

export const reportExportResolvers = {
  Mutation: {
    exportReportPDF:   (_: unknown, args: { templateId: string }, ctx: GraphQLContext) => exportReport('pdf',   args, ctx),
    exportReportExcel: (_: unknown, args: { templateId: string }, ctx: GraphQLContext) => exportReport('excel', args, ctx),
  },
}
