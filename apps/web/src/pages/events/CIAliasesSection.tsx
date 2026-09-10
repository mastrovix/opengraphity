/**
 * Alias di un CI (hostname/IP/FQDN/ID esterno con cui le sorgenti lo
 * riconoscono): elenco con origine, elimina e aggiungi (solo admin). Unica
 * implementazione per il dettaglio evento (`variant="card"`: una SectionCard
 * "Alias del CI x") e per la sezione Salute del dettaglio CI
 * (`variant="inline"`: sotto-sezione con titolo e aiuto). Prima erano due
 * copie identiche da tenere allineate.
 */
import { useId, useState } from 'react'
import { useQuery, useMutation } from '@apollo/client/react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Trash2, Plus, Loader2 } from 'lucide-react'
import { QueryError } from '@/components/QueryError'
import { Button } from '@/components/Button'
import { SectionCard } from '@/components/ui/SectionCard'
import { Pill } from '@/components/ui/Pill'
import { Input, Select, FieldLabel } from '@/components/ui/FormControls'
import { useConfirm } from '@/hooks/useConfirm'
import { errorMessage } from '@/hooks/useMutationWithToast'
import { GET_CI_ALIASES } from '@/graphql/queries'
import { CREATE_CI_ALIAS, DELETE_CI_ALIAS } from '@/graphql/mutations'
import { formatDateTime } from '@/lib/datetime'
import { colors } from '@/lib/tokens'
import { TINT_INFO } from '@/lib/eventPalette'
import { CI_ALIAS_KINDS, type CIAlias, type CIAliasKind } from '@/types/events'

const hint: React.CSSProperties = { margin: 0, fontSize: 'var(--font-size-table)', color: colors.slateLight, lineHeight: 1.5 }
const bodyMuted: React.CSSProperties = { color: colors.slateLight, fontSize: 'var(--font-size-body)', margin: 0 }

interface Props {
  ci:      { id: string; name: string }
  canEdit: boolean
  /** `card`: SectionCard a sé (dettaglio evento); `inline`: sotto-sezione dentro un'altra scheda (Salute del CI). */
  variant: 'card' | 'inline'
}

export function CIAliasesSection({ ci, canEdit, variant }: Props) {
  const { t } = useTranslation()
  const confirm = useConfirm()
  const kindId = useId()
  const valueId = useId()
  const [kind, setKind] = useState<CIAliasKind>('hostname')
  const [value, setValue] = useState('')

  const { data, loading, error, refetch } = useQuery<{ ciAliases: CIAlias[] }>(GET_CI_ALIASES, { variables: { ciId: ci.id } })
  const [deleteAlias] = useMutation(DELETE_CI_ALIAS)
  const [createAlias, { loading: creating }] = useMutation(CREATE_CI_ALIAS)
  const aliases = data?.ciAliases ?? []

  async function handleDelete(alias: CIAlias) {
    const ok = await confirm({ title: t('events.aliases.deleteTitle'), body: `${t(`events.aliases.kind.${alias.kind}`)}: ${alias.value}`, danger: true })
    if (!ok) return
    try {
      await deleteAlias({ variables: { id: alias.id } })
      toast.success(t('toast.events.aliasDeleted'))
      void refetch()
    } catch (err) { toast.error(t('toast.events.actionFailed', { error: errorMessage(err) })) }
  }

  async function handleCreate() {
    const v = value.trim()
    if (!v) return
    try {
      await createAlias({ variables: { ciId: ci.id, kind, value: v } })
      toast.success(t('toast.events.aliasCreated'))
      setValue('')
      void refetch()
    } catch (err) { toast.error(t('toast.events.actionFailed', { error: errorMessage(err) })) }
  }

  const inline = variant === 'inline'
  const emptyStyle = inline ? hint : bodyMuted

  const body = (
    <>
      {error && <QueryError message={error.message} onRetry={() => void refetch()} />}
      {!error && loading && !data && <p style={emptyStyle}>{t('common.loading')}</p>}
      {!error && data && aliases.length === 0 && <p style={emptyStyle}>{t('events.aliases.empty')}</p>}
      {aliases.length > 0 && (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
          {aliases.map((a) => (
            <li key={a.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 'var(--font-size-body)' }}>
              <Pill bg={TINT_INFO.bg} color={TINT_INFO.color} style={{ fontSize: 'var(--font-size-label)' }}>{t(`events.aliases.kind.${a.kind}`)}</Pill>
              <span style={{ fontFamily: 'monospace', color: colors.slateDark, wordBreak: 'break-all' }}>{a.value}</span>
              <span style={{ color: colors.slateLight, marginLeft: 'auto', whiteSpace: 'nowrap' }} title={formatDateTime(a.createdAt)}>{a.source}</span>
              {canEdit && (
                <Button variant="danger" size="xs" aria-label={t('events.aliases.delete', { value: a.value })} title={t('common.delete')} onClick={() => void handleDelete(a)} style={{ padding: 4 }}>
                  <Trash2 size={13} aria-hidden="true" />
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {canEdit && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap', ...(inline ? { marginTop: 10 } : { paddingTop: 8, borderTop: `1px solid ${colors.border}` }) }}>
          <div style={{ flex: '0 0 130px' }}>
            <FieldLabel htmlFor={kindId}>{t('events.aliases.kindLabel')}</FieldLabel>
            <Select id={kindId} value={kind} onChange={(e) => setKind(e.target.value as CIAliasKind)} disabled={creating}>
              {CI_ALIAS_KINDS.map((k) => <option key={k} value={k}>{t(`events.aliases.kind.${k}`)}</option>)}
            </Select>
          </div>
          <div style={{ flex: 1, minWidth: 140 }}>
            <FieldLabel htmlFor={valueId}>{t('events.aliases.valueLabel')}</FieldLabel>
            <Input id={valueId} value={value} onChange={(e) => setValue(e.target.value)} disabled={creating} placeholder={t('events.aliases.valuePlaceholder')} />
          </div>
          <Button size="xs" disabled={creating || !value.trim()} icon={creating ? <Loader2 size={13} className="animate-spin" aria-hidden="true" /> : <Plus size={13} aria-hidden="true" />} onClick={() => void handleCreate()}>
            {t('events.aliases.add')}
          </Button>
        </div>
      )}
    </>
  )

  if (inline) {
    return (
      <div style={{ paddingTop: 12, borderTop: `1px solid ${colors.border}` }}>
        <div style={{ fontSize: 'var(--font-size-label)', fontWeight: 600, color: colors.slate, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 }}>{t('monitoring.ciHealth.aliases')}</div>
        <p style={{ ...hint, marginBottom: 8 }}>{t('monitoring.ciHealth.aliasesHint')}</p>
        {body}
      </div>
    )
  }
  return (
    <SectionCard title={t('events.aliases.title', { ci: ci.name })} count={aliases.length} defaultOpen>
      {body}
    </SectionCard>
  )
}
