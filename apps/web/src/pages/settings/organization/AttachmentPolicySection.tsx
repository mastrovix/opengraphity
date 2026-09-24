/**
 * GLI ALLEGATI (verifica «Cosa resta cablato», ondata 6): dimensione massima e
 * tipi di file, dentro i limiti della piattaforma che la pagina mostra.
 */
import { useEffect, useId, useState } from 'react'
import { showError } from '@/lib/showError'
import { useQuery, useMutation } from '@apollo/client/react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { GET_ATTACHMENT_POLICY } from '@/graphql/queries'
import { SET_ATTACHMENT_POLICY } from '@/graphql/mutations'
import { FieldLabel, Input } from '@/components/ui/FormControls'
import { Button } from '@/components/Button'
import { colors } from '@/lib/tokens'
import { OrgSection, Hint, GroupLabel } from './shared'

interface Policy { maxSizeMb: number; extensions: string[]; platformMaxSizeMb: number; platformExtensions: string[]; isDefault: boolean }

export function AttachmentPolicySection() {
  const { t } = useTranslation()
  const uid = useId()
  const { data, loading, error, refetch } = useQuery<{ attachmentPolicy: Policy }>(GET_ATTACHMENT_POLICY, { fetchPolicy: 'cache-and-network' })
  const saved = data?.attachmentPolicy
  const [size, setSize] = useState('')
  const [exts, setExts] = useState<string[]>([])
  useEffect(() => { if (saved) { setSize(String(saved.maxSizeMb)); setExts(saved.extensions) } }, [saved])
  const [save, { loading: saving }] = useMutation(SET_ATTACHMENT_POLICY, {
    /**
     * `onError` c'è (revisione totale · G-16): mancava, e con `void save(...)`
     * la promise rifiutata restava senza gestore — un `unhandledRejection` in
     * console e nessun avviso in pagina, quindi il salvataggio sembrava
     * riuscito. `showError` è lo stesso avviso di tutte le altre mutation.
     */
    onError: (e) => showError(e),
    refetchQueries: [GET_ATTACHMENT_POLICY],
    onCompleted: () => toast.success(t('pages.organization.attachmentsSaved')),
  })

  const n = Number(size)
  const sizeOk = !!saved && Number.isInteger(n) && n >= 1 && n <= saved.platformMaxSizeMb
  const extsOk = exts.length > 0
  const dirty = !!saved && (n !== saved.maxSizeMb || exts.length !== saved.extensions.length || exts.some((e) => !saved.extensions.includes(e)))

  return (
    <OrgSection title={t('pages.organization.attachmentsTitle')} description={t('pages.organization.attachmentsDescription')}
      loading={!data && loading} error={error && !data ? error : null} onRetry={() => void refetch()}>
      {saved && (
        <>
          <div>
            <FieldLabel htmlFor={`${uid}-size`}>{t('pages.organization.attachmentsMaxSize')}</FieldLabel>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <Input id={`${uid}-size`} type="number" min={1} max={saved.platformMaxSizeMb} value={size} onChange={(e) => setSize(e.target.value)} style={{ width: 110 }} />
              <span style={{ fontSize: 'var(--font-size-body)', color: colors.slateLight }}>MB</span>
            </div>
            <Hint>{t('pages.organization.attachmentsPlatformCap', { max: saved.platformMaxSizeMb })}</Hint>
          </div>
          <GroupLabel>{t('pages.organization.attachmentsTypes')}</GroupLabel>
          <div role="group" aria-label={t('pages.organization.attachmentsTypes')} style={{ display: 'flex', flexWrap: 'wrap', gap: 6, maxWidth: 820 }}>
            {saved.platformExtensions.map((ext) => {
              const on = exts.includes(ext)
              return (
                <button key={ext} type="button" aria-pressed={on} onClick={() => setExts(on ? exts.filter((x) => x !== ext) : [...exts, ext])}
                  style={{
                    font: 'inherit', fontSize: 'var(--font-size-body)', cursor: 'pointer', padding: '3px 10px', borderRadius: 999,
                    border: `1px solid ${on ? colors.brand : colors.border}`, background: on ? 'var(--color-brand-light)' : 'var(--surface)',
                    color: on ? colors.brandHover : colors.slate, fontWeight: on ? 600 : 400, fontFamily: 'var(--font-mono, monospace)',
                  }}>
                  .{ext}
                </button>
              )
            })}
          </div>
          <Hint>{t('pages.organization.attachmentsTypesHint', { count: exts.length })}</Hint>
          {(!sizeOk || !extsOk) && <Hint tone="danger">{t(!sizeOk ? 'pages.organization.attachmentsSizeInvalid' : 'pages.organization.attachmentsTypesRequired', { max: saved.platformMaxSizeMb })}</Hint>}
          <div>
            <Button disabled={!dirty || !sizeOk || !extsOk || saving} onClick={() => save({ variables: { input: { maxSizeMb: n, extensions: exts } } })}>
              {t('common.save')}
            </Button>
          </div>
        </>
      )}
    </OrgSection>
  )
}
