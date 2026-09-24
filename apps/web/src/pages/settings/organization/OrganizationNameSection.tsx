/** Il nome dell'organizzazione (verifica «Cosa resta cablato», ondata 6): prima solo da riga di comando. */
import { useEffect, useId, useState } from 'react'
import { showError } from '@/lib/showError'
import { useQuery, useMutation } from '@apollo/client/react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { GET_TENANT_NAME } from '@/graphql/queries'
import { SET_TENANT_NAME } from '@/graphql/mutations'
import { FieldLabel, Input } from '@/components/ui/FormControls'
import { Button } from '@/components/Button'
import { OrgSection, Hint } from './shared'

export function OrganizationNameSection() {
  const { t } = useTranslation()
  const uid = useId()
  const { data, loading, error, refetch } = useQuery<{ tenantName: string }>(GET_TENANT_NAME, { fetchPolicy: 'cache-and-network' })
  const [name, setName] = useState('')
  useEffect(() => { if (data) setName(data.tenantName) }, [data])
  const [save, { loading: saving }] = useMutation(SET_TENANT_NAME, {
    /**
     * `onError` c'è (revisione totale · G-16): mancava, e con `void save(...)`
     * la promise rifiutata restava senza gestore — un `unhandledRejection` in
     * console e nessun avviso in pagina, quindi il salvataggio sembrava
     * riuscito. `showError` è lo stesso avviso di tutte le altre mutation.
     */
    onError: (e) => showError(e),
    refetchQueries: [GET_TENANT_NAME],
    onCompleted: () => toast.success(t('pages.organization.nameSaved')),
  })
  const trimmed = name.trim()
  const valid = trimmed.length > 0 && trimmed.length <= 120

  return (
    <OrgSection title={t('pages.organization.nameTitle')} description={t('pages.organization.nameDescription')}
      loading={!data && loading} error={error && !data ? error : null} onRetry={() => void refetch()}>
      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 280px', maxWidth: 420 }}>
          <FieldLabel htmlFor={`${uid}-name`}>{t('pages.organization.nameLabel')}</FieldLabel>
          <Input id={`${uid}-name`} value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />
        </div>
        <Button onClick={() => save({ variables: { name: trimmed } })} disabled={saving || !valid || trimmed === data?.tenantName}>
          {t('common.save')}
        </Button>
      </div>
      {!valid && <Hint tone="danger">{t('pages.organization.nameInvalid')}</Hint>}
    </OrgSection>
  )
}
