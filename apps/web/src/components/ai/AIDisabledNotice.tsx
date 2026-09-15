/**
 * «Questa funzione AI è spenta per la tua organizzazione» (verifica «Cosa resta
 * cablato», ondata 6): dice quale funzione, e chi può riaccenderla. L'admin
 * trova il collegamento alla scheda AI della pagina Organizzazione.
 */
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { SparklesIcon } from 'lucide-react'
import { useMe } from '@/hooks/useMe'
import type { AIFeature } from '@/hooks/useAIFeature'

/** Il testo breve, per il `title` di un bottone spento. */
export function useAIDisabledText(feature: AIFeature): string {
  const { t } = useTranslation()
  const { isAdmin } = useMe()
  return t(isAdmin ? 'components.aiDisabled.adminShort' : 'components.aiDisabled.userShort', { feature: t(`pages.organization.aiFeature.${feature}`) })
}

export function AIDisabledNotice({ feature }: { feature: AIFeature }) {
  const { t } = useTranslation()
  const { isAdmin } = useMe()
  const name = t(`pages.organization.aiFeature.${feature}`)
  return (
    <div role="status" data-testid={`ai-disabled-${feature}`}
      style={{ display: 'flex', gap: 8, alignItems: 'flex-start', padding: '10px 12px', borderRadius: 8, background: 'var(--surface-2)', border: '1px solid var(--color-border)', fontSize: 'var(--font-size-body)', color: 'var(--color-slate-dark)', lineHeight: 1.5 }}>
      <SparklesIcon size={15} aria-hidden="true" style={{ flexShrink: 0, marginTop: 2, color: 'var(--color-slate-light)' }} />
      <span>
        {t('components.aiDisabled.text', { feature: name })}{' '}
        {isAdmin
          ? <Link to="/settings/organization?tab=ai" style={{ color: 'var(--color-brand)' }}>{t('components.aiDisabled.adminLink')}</Link>
          : t('components.aiDisabled.askAdmin')}
      </span>
    </div>
  )
}
