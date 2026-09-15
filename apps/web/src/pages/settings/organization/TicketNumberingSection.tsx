/**
 * LA NUMERAZIONE DEI TICKET (verifica «Cosa resta cablato», ondata 6): prefisso
 * e cifre per tipo, solo per i ticket nuovi. L'anteprima mostra il prossimo
 * numero con il formato scelto; il contatore non cambia.
 */
import { useEffect, useId, useState } from 'react'
import { useQuery, useMutation } from '@apollo/client/react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { GET_TICKET_NUMBERING } from '@/graphql/queries'
import { SET_TICKET_NUMBERING } from '@/graphql/mutations'
import { Input } from '@/components/ui/FormControls'
import { Button } from '@/components/Button'
import { useItilTypeLabels } from '@/hooks/useItilTypeLabels'
import { OrgSection, Hint } from './shared'

const KINDS = [
  { key: 'incident', itil: 'incident' },
  { key: 'problem', itil: 'problem' },
  { key: 'change', itil: 'change' },
  { key: 'serviceRequest', itil: 'service_request' },
] as const
type Key = (typeof KINDS)[number]['key']
type Draft = Record<Key, { prefix: string; digits: string }>

/** Le stesse regole dell'API (`lib/ticketNumbering.ts`), come chiave del problema o null. */
export function numberingProblem(draft: Draft): string | null {
  for (const { key } of KINDS) {
    if (!/^[A-Z][A-Z0-9]{0,7}-?$/.test(draft[key].prefix)) return 'pages.organization.numberingPrefixInvalid'
    const d = Number(draft[key].digits)
    if (!Number.isInteger(d) || d < 3 || d > 12) return 'pages.organization.numberingDigitsInvalid'
  }
  for (const a of KINDS) for (const b of KINDS) {
    if (a.key >= b.key) continue
    const pa = draft[a.key].prefix, pb = draft[b.key].prefix
    if (pa.startsWith(pb) || pb.startsWith(pa)) return 'pages.organization.numberingOverlap'
  }
  return null
}

export function TicketNumberingSection() {
  const { t } = useTranslation()
  const uid = useId()
  const { labelOf } = useItilTypeLabels()
  type Saved = Record<Key, { prefix: string; digits: number }> & { isDefault: boolean }
  const { data, loading, error, refetch } = useQuery<{ ticketNumbering: Saved }>(GET_TICKET_NUMBERING, { fetchPolicy: 'cache-and-network' })
  const saved = data?.ticketNumbering
  const [draft, setDraft] = useState<Draft | null>(null)
  useEffect(() => {
    if (saved) setDraft(Object.fromEntries(KINDS.map(({ key }) => [key, { prefix: saved[key].prefix, digits: String(saved[key].digits) }])) as Draft)
  }, [saved])
  const [save, { loading: saving }] = useMutation(SET_TICKET_NUMBERING, {
    refetchQueries: [GET_TICKET_NUMBERING],
    onCompleted: () => toast.success(t('pages.organization.numberingSaved')),
  })

  const problem = draft ? numberingProblem(draft) : null
  const dirty = !!saved && !!draft && KINDS.some(({ key }) => draft[key].prefix !== saved[key].prefix || Number(draft[key].digits) !== saved[key].digits)

  return (
    <OrgSection title={t('pages.organization.numberingTitle')} description={t('pages.organization.numberingDescription')}
      loading={!data && loading} error={error && !data ? error : null} onRetry={() => void refetch()}>
      {saved && draft && (
        <>
          <div style={{ overflowX: 'auto' }}>
          <table style={{ borderCollapse: 'collapse', maxWidth: 620 }}>
            <thead>
              <tr>
                <th style={{ padding: '4px 12px 8px 0', textAlign: 'left' }}>{t('pages.organization.numberingType')}</th>
                <th style={{ padding: '4px 12px 8px 0', textAlign: 'left' }}>{t('pages.organization.numberingPrefix')}</th>
                <th style={{ padding: '4px 12px 8px 0', textAlign: 'left' }}>{t('pages.organization.numberingDigits')}</th>
                <th style={{ padding: '4px 0 8px 0', textAlign: 'left' }}>{t('pages.organization.numberingExample')}</th>
              </tr>
            </thead>
            <tbody>
              {KINDS.map(({ key, itil }) => {
                const row = draft[key]
                const digits = Math.min(Math.max(Number(row.digits) || 0, 0), 12)
                return (
                  <tr key={key} style={{ borderTop: '1px solid var(--color-border)' }}>
                    <td style={{ padding: '8px 12px 8px 0', fontSize: 'var(--font-size-body)', fontWeight: 500 }}>{labelOf(itil)}</td>
                    <td style={{ padding: '8px 12px 8px 0' }}>
                      <Input aria-label={t('pages.organization.numberingPrefixFor', { type: labelOf(itil) })} id={`${uid}-${key}-prefix`}
                        value={row.prefix} maxLength={9} style={{ width: 110, fontFamily: 'var(--font-mono, monospace)' }}
                        onChange={(e) => setDraft({ ...draft, [key]: { ...row, prefix: e.target.value.toUpperCase() } })} />
                    </td>
                    <td style={{ padding: '8px 12px 8px 0' }}>
                      <Input aria-label={t('pages.organization.numberingDigitsFor', { type: labelOf(itil) })} type="number" min={3} max={12}
                        value={row.digits} style={{ width: 80 }}
                        onChange={(e) => setDraft({ ...draft, [key]: { ...row, digits: e.target.value } })} />
                    </td>
                    <td style={{ padding: '8px 0', fontFamily: 'var(--font-mono, monospace)', fontSize: 'var(--font-size-body)', color: 'var(--color-slate-dark)' }}>
                      {row.prefix}{'1'.padStart(digits, '0')}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          </div>
          <Hint>{t('pages.organization.numberingHint')}</Hint>
          {problem && <Hint tone="danger">{t(problem)}</Hint>}
          <div>
            <Button disabled={!dirty || !!problem || saving}
              onClick={() => void save({ variables: { input: Object.fromEntries(KINDS.map(({ key }) => [key, { prefix: draft[key].prefix, digits: Number(draft[key].digits) }])) } })}>
              {t('common.save')}
            </Button>
          </div>
        </>
      )}
    </OrgSection>
  )
}
