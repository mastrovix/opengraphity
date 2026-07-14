import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Download, Loader2 } from 'lucide-react'

interface Props {
  /** Fetches ALL rows to export (not just the current page) and triggers the download. */
  onExport: () => Promise<void>
}

export function ExportCsvButton({ onExport }: Props) {
  const { t } = useTranslation()
  const [busy, setBusy] = useState(false)

  return (
    <button
      onClick={() => {
        setBusy(true)
        onExport()
          .catch((err: unknown) => toast.error(err instanceof Error ? err.message : t('csvExport.failed')))
          .finally(() => setBusy(false))
      }}
      disabled={busy}
      title={t('csvExport.tooltip')}
      style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 14px', backgroundColor: '#fff', border: '1px solid #cbd5e1', borderRadius: 6, cursor: busy ? 'default' : 'pointer', fontSize: 'var(--font-size-body)', color: 'var(--text-secondary)' }}
    >
      {busy ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />}
      {t('csvExport.button')}
    </button>
  )
}
