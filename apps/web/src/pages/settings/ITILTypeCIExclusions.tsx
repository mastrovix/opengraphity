/**
 * I tipi di CI che questo tipo di ticket NON può coinvolgere (revisione del 15
 * set 2026 · CM-8, decisione del proprietario).
 *
 * Prima qui si elencavano i tipi AMMESSI, con un tipo di relazione e una
 * direzione che nessuno leggeva, e la regola valeva solo aggiungendo un CI a un
 * ticket già aperto. Adesso si spuntano i tipi esclusi: nessuna spunta = tutti
 * ammessi, e l'esclusione vale ovunque — alla creazione e dopo, dal web,
 * dall'API, dal portale e dagli incident che apre il monitoraggio.
 */
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery } from '@apollo/client/react'
import { toast } from 'sonner'
import { Save } from 'lucide-react'
import { GET_TICKET_CI_EXCLUSIONS } from '@/graphql/queries'
import { SET_TICKET_CI_EXCLUSIONS } from '@/graphql/mutations'
import { showError } from '@/lib/showError'
import { btnPrimary } from './shared/designerStyles'

const TICKET_CI_TYPES = ['incident', 'problem', 'change', 'service_request'] as const

export interface ITILTypeCIExclusionsProps {
  /** Il nome del tipo ITIL (incident, problem, change, service_request). */
  ticketType: string
  ciTypes:    { id: string; name: string; label: string }[]
}

export function ITILTypeCIExclusions({ ticketType, ciTypes }: ITILTypeCIExclusionsProps) {
  const { t } = useTranslation()
  const linksCIs = (TICKET_CI_TYPES as readonly string[]).includes(ticketType)
  const { data, loading, error } = useQuery<{ ticketCIExclusions: { ticketType: string; ciTypes: string[] }[] }>(GET_TICKET_CI_EXCLUSIONS, {
    variables: { ticketType }, skip: !linksCIs, fetchPolicy: 'network-only',
  })
  const saved = data?.ticketCIExclusions.find((x) => x.ticketType === ticketType)?.ciTypes
  const [selected, setSelected] = useState<Set<string>>(new Set())
  useEffect(() => { if (saved) setSelected(new Set(saved)) }, [saved])

  const [save, { loading: saving }] = useMutation(SET_TICKET_CI_EXCLUSIONS, {
    refetchQueries: [{ query: GET_TICKET_CI_EXCLUSIONS, variables: { ticketType } }],
    onCompleted: () => toast.success(t('itilDesigner.saved')),
    onError: (e) => showError(e),
  })

  if (!linksCIs) return <p style={{ color: 'var(--color-slate-light)' }}>{t('itilDesigner.ciExclusions.notLinked')}</p>
  if (error) return <p role="alert" style={{ color: 'var(--color-danger)' }}>{t('itilDesigner.ciExclusions.loadError', { error: error.message })}</p>
  if (loading || !saved) return <p style={{ color: 'var(--color-slate-light)' }}>{t('common.loading')}</p>

  const dirty = [...selected].sort().join(',') !== [...saved].sort().join(',')
  const toggle = (name: string) => setSelected((prev) => {
    const next = new Set(prev)
    if (next.has(name)) next.delete(name); else next.add(name)
    return next
  })

  return (
    <div>
      <p style={{ margin: '0 0 12px', color: 'var(--color-slate)', maxWidth: '70ch' }}>{t('itilDesigner.ciExclusions.intro')}</p>
      <fieldset style={{ border: 'none', padding: 0, margin: '0 0 16px' }}>
        <legend style={{ fontWeight: 600, marginBottom: 8 }}>{t('itilDesigner.ciExclusions.legend')}</legend>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 8 }}>
          {ciTypes.map((ct) => (
            <label key={ct.id} style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
              <input type="checkbox" checked={selected.has(ct.name)} onChange={() => toggle(ct.name)} />
              <span>{ct.label}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <p style={{ margin: '0 0 12px', color: 'var(--color-slate-light)' }}>
        {selected.size === 0 ? t('itilDesigner.ciExclusions.none') : t('itilDesigner.ciExclusions.summary', { selected: selected.size })}
      </p>
      <button type="button" style={btnPrimary} disabled={!dirty || saving}
        onClick={() => void save({ variables: { ticketType, ciTypes: [...selected] } })}>
        <Save size={13} /> {t('itilDesigner.save')}
      </button>
    </div>
  )
}
