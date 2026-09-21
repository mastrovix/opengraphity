import { Hash, PieChart, CircleDot, BarChart2, BarChart, LineChart, TrendingUp, Table as TableIcon , ListOrdered } from 'lucide-react'
import { lookupOrError } from '@/lib/tokens'
import type { ReportTemplate } from './useCustomReports'

/** Icona per tipo di grafico: unica sorgente per lista e dettaglio report. */
export const CHART_ICON_MAP: Record<string, React.ComponentType<{ size?: number; color?: string }>> = {
  kpi: Hash, pie: PieChart, donut: CircleDot,
  bar: BarChart2, bar_horizontal: BarChart,
  line: LineChart, area: TrendingUp, table: TableIcon,
  // La classifica (19 set 2026): senza questa riga `lookupOrError` scriveva
  // un errore in console a ogni render della lista dei report.
  top_n: ListOrdered,
}

export function getReportIcon(template: ReportTemplate, size = 20) {
  const chartType = template.sections?.[0]?.chartType ?? 'bar'
  const Icon = lookupOrError(CHART_ICON_MAP, chartType, 'CHART_ICON_MAP', BarChart2)
  return <Icon size={size} color="var(--color-brand)" />
}
