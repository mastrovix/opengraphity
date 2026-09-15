/**
 * IL MARCHIO (verifica «Cosa resta cablato», ondata 6): logo e nome nel
 * portale, nelle e-mail e nei PDF; nome del mittente e indirizzo di risposta.
 * L'indirizzo da cui si spedisce resta della piattaforma, e la pagina lo dice.
 */
import { useEffect, useId, useRef, useState } from 'react'
import { useQuery, useMutation, useApolloClient } from '@apollo/client/react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { ImageUp, Trash2 } from 'lucide-react'
import { GET_TENANT_BRAND, GET_TENANT_BRAND_SETTINGS } from '@/graphql/queries'
import { SET_TENANT_BRAND } from '@/graphql/mutations'
import { FieldLabel, Input } from '@/components/ui/FormControls'
import { Button } from '@/components/Button'
import { apiUrl, authHeader } from '@/lib/apiBase'
import { useConfirm } from '@/hooks/useConfirm'
import { OrgSection, Hint, GroupLabel } from './shared'
import { showError } from '@/lib/showError'

interface BrandSettings { displayName: string; senderName: string; replyTo: string | null; logoUrl: string | null; logoMimeType: string | null; isDefault: boolean }

const EMAIL_RE = /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;]+$/
const nameOk = (v: string) => v.trim().length > 0 && v.trim().length <= 80 && !/[<>"\r\n]/.test(v)

export function BrandSection() {
  const { t } = useTranslation()
  const uid = useId()
  const confirm = useConfirm()
  const fileRef = useRef<HTMLInputElement>(null)
  const client = useApolloClient()
  const { data, loading, error, refetch } = useQuery<{ tenantBrandSettings: BrandSettings }>(GET_TENANT_BRAND_SETTINGS, { fetchPolicy: 'cache-and-network' })
  const saved = data?.tenantBrandSettings
  const [displayName, setDisplayName] = useState('')
  const [senderName, setSenderName] = useState('')
  const [replyTo, setReplyTo] = useState('')
  const [uploading, setUploading] = useState(false)
  useEffect(() => {
    if (!saved) return
    setDisplayName(saved.displayName); setSenderName(saved.senderName); setReplyTo(saved.replyTo ?? '')
  }, [saved])

  const refreshBrand = () => { void refetch(); void client.refetchQueries({ include: [GET_TENANT_BRAND] }) }
  const [save, { loading: saving }] = useMutation(SET_TENANT_BRAND, {
    onCompleted: () => { toast.success(t('pages.organization.brandSaved')); refreshBrand() },
  })

  const replyOk = replyTo.trim() === '' || EMAIL_RE.test(replyTo.trim())
  const valid = nameOk(displayName) && nameOk(senderName) && replyOk
  const dirty = !!saved && (displayName !== saved.displayName || senderName !== saved.senderName || replyTo.trim() !== (saved.replyTo ?? ''))

  async function uploadLogo(file: File | null) {
    if (!file) return
    setUploading(true)
    try {
      const form = new FormData()
      form.append('file', file)
      const res = await fetch(apiUrl('/api/brand/logo'), { method: 'POST', headers: authHeader(), body: form })
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string | { key?: string | null; message?: string } }
        const err = body.error
        throw new Error(typeof err === 'string' ? err : err?.key ? t(err.key, { defaultValue: err.message ?? '' }) : (err?.message ?? res.statusText))
      }
      toast.success(t('pages.organization.logoSaved'))
      refreshBrand()
    } catch (e) {
      showError(e)
    } finally {
      setUploading(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  async function removeLogo() {
    if (!(await confirm({ title: t('pages.organization.logoRemove'), body: t('pages.organization.logoRemoveConfirm') }))) return
    const res = await fetch(apiUrl('/api/brand/logo'), { method: 'DELETE', headers: authHeader() })
    if (!res.ok) { toast.error(t('pages.organization.logoRemoveFailed')); return }
    toast.success(t('pages.organization.logoRemoved'))
    refreshBrand()
  }

  return (
    <OrgSection title={t('pages.organization.brandTitle')} description={t('pages.organization.brandDescription')}
      loading={!data && loading} error={error && !data ? error : null} onRetry={() => void refetch()}>
      {saved && (
        <>
          {saved.isDefault && <Hint>{t('pages.organization.brandFactory')}</Hint>}
          <GroupLabel>{t('pages.organization.logoGroup')}</GroupLabel>
          <div style={{ display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap' }}>
            <div style={{ width: 200, height: 64, border: '1px dashed var(--color-border)', borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--surface)', overflow: 'hidden' }}>
              <img src={saved.logoUrl ? apiUrl(saved.logoUrl) : '/opengrafo-logo.svg'} alt={t('pages.organization.logoPreview')} style={{ maxWidth: 180, maxHeight: 48 }} />
            </div>
            <input ref={fileRef} type="file" accept="image/png,image/svg+xml,.png,.svg" style={{ display: 'none' }}
              onChange={(e) => void uploadLogo(e.target.files?.[0] ?? null)} aria-label={t('pages.organization.logoUpload')} />
            <Button variant="secondary" icon={<ImageUp size={14} />} disabled={uploading} onClick={() => fileRef.current?.click()}>
              {uploading ? t('pages.organization.logoUploading') : t('pages.organization.logoUpload')}
            </Button>
            {saved.logoUrl && (
              <Button variant="ghost" icon={<Trash2 size={14} />} onClick={() => void removeLogo()}>{t('pages.organization.logoRemove')}</Button>
            )}
          </div>
          <Hint>{saved.logoUrl ? t(saved.logoMimeType === 'image/svg+xml' ? 'pages.organization.logoHintSvg' : 'pages.organization.logoHintPng') : t('pages.organization.logoHintNone')}</Hint>

          <GroupLabel>{t('pages.organization.namesGroup')}</GroupLabel>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 14, maxWidth: 780 }}>
            <div>
              <FieldLabel htmlFor={`${uid}-display`}>{t('pages.organization.displayName')}</FieldLabel>
              <Input id={`${uid}-display`} value={displayName} maxLength={80} onChange={(e) => setDisplayName(e.target.value)} />
              <Hint>{t('pages.organization.displayNameHint')}</Hint>
            </div>
            <div>
              <FieldLabel htmlFor={`${uid}-sender`}>{t('pages.organization.senderName')}</FieldLabel>
              <Input id={`${uid}-sender`} value={senderName} maxLength={80} onChange={(e) => setSenderName(e.target.value)} />
              <Hint>{t('pages.organization.senderNameHint')}</Hint>
            </div>
            <div>
              <FieldLabel htmlFor={`${uid}-reply`}>{t('pages.organization.replyTo')}</FieldLabel>
              <Input id={`${uid}-reply`} type="email" value={replyTo} onChange={(e) => setReplyTo(e.target.value)} placeholder="it-support@example.com" />
              <Hint>{t('pages.organization.replyToHint')}</Hint>
            </div>
          </div>
          {!valid && <Hint tone="danger">{t(!replyOk ? 'pages.organization.replyToInvalid' : 'pages.organization.brandNameInvalid')}</Hint>}
          <div>
            <Button disabled={!dirty || !valid || saving}
              onClick={() => void save({ variables: { input: { displayName: displayName.trim(), senderName: senderName.trim(), replyTo: replyTo.trim() || null } } })}>
              {t('common.save')}
            </Button>
          </div>
        </>
      )}
    </OrgSection>
  )
}
