/**
 * Client-side CSV export. Columns mirror the table's ColumnDef (key + label),
 * values are read raw from the row (render functions are presentation-only).
 */

export interface CsvColumn<T> {
  key:   keyof T
  label: string
}

function escapeCell(value: unknown): string {
  if (value === null || value === undefined) return ''
  let s: string
  if (typeof value === 'object') {
    // nested objects (e.g. assignee { name }) — prefer a name field, else JSON
    const obj = value as Record<string, unknown>
    s = typeof obj['name'] === 'string' ? (obj['name'] as string) : JSON.stringify(value)
  } else {
    s = String(value)
  }
  if (/[",\n\r;]/.test(s)) s = `"${s.replaceAll('"', '""')}"`
  return s
}

export function exportToCsv<T>(filename: string, columns: CsvColumn<T>[], rows: T[]): void {
  const header = columns.map((c) => escapeCell(c.label)).join(',')
  const lines  = rows.map((row) => columns.map((c) => escapeCell(row[c.key])).join(','))
  // BOM so Excel opens UTF-8 correctly
  const csv  = '﻿' + [header, ...lines].join('\r\n')
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
  const url  = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href     = url
  link.download = filename.endsWith('.csv') ? filename : `${filename}.csv`
  link.click()
  URL.revokeObjectURL(url)
}
