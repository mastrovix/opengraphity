import { getSession } from '@opengraphity/neo4j'
import type { Integer } from 'neo4j-driver'
import { buildReportQuery, type ReportSectionDef } from './reportQueryBuilder.js'

export interface ReportSectionResult {
  sectionId: string
  title:     string
  chartType: string
  data:      string  // JSON
  total:     number | null
  error:     string | null
}

function toNumber(v: unknown): number {
  if (typeof v === 'number') return v
  if (v && typeof (v as Integer).toNumber === 'function') return (v as Integer).toNumber()
  return Number(v) || 0
}

function flattenNode(node: { properties?: Record<string, unknown> } | null): Record<string, unknown> {
  return node?.properties ?? {}
}

export async function executeReportSection(
  section: ReportSectionDef,
  tenantId: string,
): Promise<ReportSectionResult> {
  try {
    const { query, params } = buildReportQuery(section, tenantId)

    const session = getSession(undefined, 'READ')
    let data: unknown
    let total: number | null = null

    try {
      const result = await session.executeRead(tx => tx.run(query, params))

      switch (section.chartType) {
        case 'kpi': {
          const v = result.records[0]?.get('value') ?? 0
          data = { value: toNumber(v), label: section.title }
          total = toNumber(v)
          break
        }

        case 'pie':
        case 'donut':
        case 'bar':
        case 'bar_horizontal':
        case 'top_n': {
          data = result.records.map(r => ({
            name:  r.get('label') ?? '(none)',
            value: toNumber(r.get('value')),
          }))
          total = (data as unknown[]).length
          break
        }

        case 'line':
        case 'area': {
          data = result.records.map(r => ({
            date:  String(r.get('label') ?? ''),
            value: toNumber(r.get('value')),
          }))
          total = (data as unknown[]).length
          break
        }

        case 'table': {
          const resultNodes = section.nodes.filter(n => n.isResult)
          const selectedFields = resultNodes.flatMap(n => (n.selectedFields ?? []).map(sf => `${n.label.replace(/\s+/g, '_')}_${sf}`))

          if (selectedFields.length > 0) {
            const rows = result.records.map(r =>
              selectedFields.map(col => {
                try { return r.get(col) ?? null } catch { return null }
              }),
            )
            data = { columns: selectedFields, rows }
          } else {
            const rows = result.records.map(r => {
              try {
                const node = r.get('row') as { properties?: Record<string, unknown> } | null
                return flattenNode(node)
              } catch {
                return {}
              }
            })
            const columns = rows.length > 0 ? Object.keys(rows[0]) : []
            data = { columns, rows: rows.map(row => columns.map(c => row[c] ?? null)) }
          }
          total = result.records.length
          break
        }

        default: {
          const v = result.records[0]?.get('value') ?? 0
          data = { value: toNumber(v) }
          total = toNumber(v)
        }
      }
    } finally {
      await session.close()
    }

    return {
      sectionId: section.id,
      title:     section.title,
      chartType: section.chartType,
      data:      JSON.stringify(data),
      total,
      error:     null,
    }
  } catch (err) {
    return {
      sectionId: section.id,
      title:     section.title,
      chartType: section.chartType,
      data:      '{}',
      total:     null,
      error:     err instanceof Error ? err.message : String(err),
    }
  }
}
