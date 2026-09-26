import { Button } from '@/components/Button'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Download, Loader2 } from 'lucide-react'
import { showError } from '@/lib/showError'

interface Props {
  /** Fetches ALL rows to export (not just the current page) and triggers the download. */
  onExport: () => Promise<void>
}

export function ExportCsvButton({ onExport }: Props) {
  const { t } = useTranslation()
  const [busy, setBusy] = useState(false)

  return (
    <Button variant="secondary"
      onClick={() => {
        setBusy(true)
        onExport()
          .catch((err: unknown) => showError(err, err instanceof Error ? err.message : t('csvExport.failed')))
          .finally(() => setBusy(false))
      }}
      disabled={busy}
      title={t('csvExport.tooltip')}
    >
      {busy ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />}
      {t('csvExport.button')}
    </Button>
  )
}
