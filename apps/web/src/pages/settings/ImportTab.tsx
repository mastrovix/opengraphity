import { useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { FileUp, Play, RefreshCw, Upload, X } from 'lucide-react'
import { SectionCard } from '@/components/ui/SectionCard'
import { SimpleTable, type SimpleColumn } from '@/components/ui/SimpleTable'
import { Pill } from '@/components/ui/Pill'
import { Button } from '@/components/Button'
import { Input, Select, FieldLabel } from '@/components/ui/FormControls'

// Same base-URL convention as clientLogger: VITE_API_URL points at the GraphQL
// endpoint; strip the /graphql suffix. Unset → relative (nginx proxies /api).
const API_BASE = import.meta.env['VITE_API_URL']?.replace('/graphql', '') ?? ''

// ── Types (REST contract /api/v1/import/*) ────────────────────────────────────

type EntityType = 'incidents' | 'kb-articles'

interface ImportIssue {
  row:        number
  externalId: string | null
  message:    string
}

interface ImportReport {
  totalRows: number
  created:   number
  updated:   number
  errors:    ImportIssue[]
  warnings:  ImportIssue[]
}

interface IssueRow extends ImportIssue {
  id: string
  [key: string]: unknown
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** Extracts the error message from a non-2xx body: { error: string } or { error: { message } }. */
async function extractError(res: Response, fallback: string): Promise<string> {
  try {
    const body: unknown = await res.json()
    const err = (body as { error?: unknown }).error
    if (typeof err === 'string') return err
    if (err && typeof err === 'object' && 'message' in err) return String((err as { message: unknown }).message)
  } catch { /* not JSON */ }
  return `${fallback} (HTTP ${res.status})`
}

function toIssueRows(issues: ImportIssue[]): IssueRow[] {
  return issues.map((it, i) => ({ ...it, id: `${it.row}-${i}` }))
}

// ── Component ─────────────────────────────────────────────────────────────────

export function ImportTab() {
  const { t } = useTranslation()
  const fileInputRef = useRef<HTMLInputElement>(null)

  // The API key lives only in component state (session-only, never persisted).
  const [apiKey, setApiKey]         = useState('')
  const [entityType, setEntityType] = useState<EntityType>('incidents')
  const [file, setFile]             = useState<File | null>(null)
  const [running, setRunning]       = useState<'dry' | 'import' | null>(null)
  const [report, setReport]         = useState<ImportReport | null>(null)
  const [reportKind, setReportKind] = useState<'dry' | 'import' | null>(null)

  // Any input change invalidates the previous dry-run: import locks again.
  function resetReport() {
    setReport(null)
    setReportKind(null)
  }

  function handlePickFile(f: File | null) {
    setFile(f)
    resetReport()
  }

  async function runImport(dryRun: boolean) {
    if (!file || !apiKey || running) return
    setRunning(dryRun ? 'dry' : 'import')
    try {
      const form = new FormData()
      form.append('file', file)
      const res = await fetch(`${API_BASE}/api/v1/import/${entityType}?dryRun=${dryRun}`, {
        method:  'POST',
        headers: { 'X-API-Key': apiKey },
        body:    form,
      })
      if (!res.ok) {
        toast.error(await extractError(res, t('pages.import.requestFailed')))
        return
      }
      const data = await res.json() as ImportReport
      setReport(data)
      setReportKind(dryRun ? 'dry' : 'import')
      if (dryRun) {
        if (data.errors.length > 0) toast.warning(t('pages.import.dryRunErrors', { count: data.errors.length }))
        else                        toast.success(t('pages.import.dryRunDone'))
      } else {
        toast.success(t('pages.import.importDone', { created: data.created, updated: data.updated }))
      }
    } catch (err) {
      toast.error(`${t('pages.import.requestFailed')}: ${(err as Error).message}`)
    } finally {
      setRunning(null)
    }
  }

  function handleImportClick() {
    if (!report || reportKind !== 'dry') return
    if (report.errors.length > 0) {
      const ok = confirm(t('pages.import.confirmErrors', { count: report.errors.length }))
      if (!ok) return
    }
    void runImport(false)
  }

  const canDryRun  = Boolean(file && apiKey) && !running
  // Import unlocks only after a dry-run on the current inputs (report cleared on change).
  const canImport  = Boolean(file && apiKey) && !running && reportKind === 'dry' && report !== null

  const issueColumns: SimpleColumn<IssueRow>[] = [
    { key: 'row',        label: t('pages.import.colRow'),        width: '80px' },
    { key: 'externalId', label: t('pages.import.colExternalId'), width: '200px', render: v => (v as string | null) ?? '—' },
    { key: 'message',    label: t('pages.import.colMessage') },
  ]

  const spinner = <RefreshCw size={14} style={{ animation: 'og-import-spin 1s linear infinite' }} />

  return (
    <>
      <style>{'@keyframes og-import-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }'}</style>

      <SectionCard title={t('pages.import.title')} collapsible={false}>
        <p style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate)', margin: 0 }}>
          {t('pages.import.intro')}
        </p>

        {/* API key (v1 routes use X-API-Key, not the Keycloak session) */}
        <div>
          <FieldLabel>{t('pages.import.apiKey')}</FieldLabel>
          <Input
            type="password"
            autoComplete="off"
            value={apiKey}
            onChange={e => { setApiKey(e.target.value); resetReport() }}
            placeholder={t('pages.import.apiKeyPlaceholder')}
            style={{ maxWidth: 420 }}
          />
          <p style={{ fontSize: 'var(--font-size-table)', color: 'var(--color-slate-light)', margin: '4px 0 0' }}>
            {t('pages.import.apiKeyHint')}{' '}
            <Link to="/admin/integrations" style={{ color: 'var(--color-brand)' }}>
              {t('pages.import.apiKeyHintLink')}
            </Link>
          </p>
        </div>

        {/* Entity type */}
        <div>
          <FieldLabel>{t('pages.import.entityType')}</FieldLabel>
          <Select
            value={entityType}
            onChange={e => { setEntityType(e.target.value as EntityType); resetReport() }}
            style={{ maxWidth: 420 }}
          >
            <option value="incidents">{t('pages.import.entityIncidents')}</option>
            <option value="kb-articles">{t('pages.import.entityKb')}</option>
          </Select>
        </div>

        {/* CSV file picker */}
        <div>
          <FieldLabel>{t('pages.import.file')}</FieldLabel>
          <input
            ref={fileInputRef}
            type="file"
            accept=".csv,text/csv"
            style={{ display: 'none' }}
            onChange={e => handlePickFile(e.target.files?.[0] ?? null)}
          />
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <Button variant="secondary" size="xs" icon={<FileUp size={14} />} onClick={() => fileInputRef.current?.click()}>
              {t('pages.import.chooseFile')}
            </Button>
            {file ? (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 'var(--font-size-body)', color: 'var(--color-slate-dark)' }}>
                {file.name}
                <Pill bg="#f1f5f9" color="var(--color-slate)">{formatSize(file.size)}</Pill>
                <Button
                  variant="ghost"
                  icon={<X size={14} color="var(--color-slate)" />}
                  title={t('pages.import.remove')}
                  onClick={() => { handlePickFile(null); if (fileInputRef.current) fileInputRef.current.value = '' }}
                />
              </span>
            ) : (
              <span style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate-light)' }}>
                {t('pages.import.noFile')}
              </span>
            )}
          </div>
          <p style={{ fontSize: 'var(--font-size-table)', color: 'var(--color-slate-light)', margin: '6px 0 0', lineHeight: 1.5 }}>
            {t('pages.import.columnsTitle')}{' '}
            <code style={{ fontSize: 'var(--font-size-table)' }}>
              {entityType === 'incidents' ? t('pages.import.columnsIncidents') : t('pages.import.columnsKb')}
            </code>
            {' — '}{t('pages.import.requiredNote')}
          </p>
        </div>

        {/* Actions */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Button
            variant="secondary"
            icon={running === 'dry' ? spinner : <Play size={14} />}
            disabled={!canDryRun}
            onClick={() => void runImport(true)}
          >
            {running === 'dry' ? t('pages.import.running') : t('pages.import.dryRun')}
          </Button>
          <Button
            variant="primary"
            icon={running === 'import' ? spinner : <Upload size={14} />}
            disabled={!canImport}
            onClick={handleImportClick}
          >
            {running === 'import' ? t('pages.import.running') : t('pages.import.importBtn')}
          </Button>
          {!canImport && !running && (
            <span style={{ fontSize: 'var(--font-size-table)', color: 'var(--color-slate-light)' }}>
              {t('pages.import.importHint')}
            </span>
          )}
        </div>
      </SectionCard>

      {/* Result */}
      {report && (
        <SectionCard
          title={reportKind === 'dry' ? t('pages.import.resultDry') : t('pages.import.resultImport')}
          collapsible={false}
        >
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <Pill bg="#f1f5f9" color="var(--color-slate)">{t('pages.import.statTotal')}: {report.totalRows}</Pill>
            <Pill bg="#dcfce7" color="var(--color-success)">{t('pages.import.statCreated')}: {report.created}</Pill>
            <Pill bg="#f0f4ff" color="var(--color-brand)">{t('pages.import.statUpdated')}: {report.updated}</Pill>
            <Pill bg="#fee2e2" color="var(--color-trigger-sla-breach)">{t('pages.import.statErrors')}: {report.errors.length}</Pill>
          </div>

          {report.errors.length > 0 && (
            <div>
              <FieldLabel>
                {t('pages.import.errors')}{' '}
                <Pill bg="#fee2e2" color="var(--color-trigger-sla-breach)">{report.errors.length}</Pill>
              </FieldLabel>
              <SimpleTable<IssueRow> columns={issueColumns} rows={toIssueRows(report.errors)} />
            </div>
          )}

          {report.warnings.length > 0 && (
            <div>
              <FieldLabel>
                {t('pages.import.warnings')}{' '}
                <Pill bg="#fef3c7" color="#92400e">{report.warnings.length}</Pill>
              </FieldLabel>
              <SimpleTable<IssueRow> columns={issueColumns} rows={toIssueRows(report.warnings)} />
            </div>
          )}

          {report.errors.length === 0 && report.warnings.length === 0 && (
            <p style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-success)', margin: 0 }}>
              {t('pages.import.noIssues')}
            </p>
          )}
        </SectionCard>
      )}
    </>
  )
}
