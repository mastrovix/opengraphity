import { useId, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useMutation, useQuery } from '@apollo/client/react'
import { PageContainer } from '@/components/PageContainer'
import { useTranslation } from 'react-i18next'
import { ArrowLeft } from 'lucide-react'
import { toast } from 'sonner'
import { CREATE_SERVICE_REQUEST } from '@/graphql/mutations'
import { GET_SERVICE_REQUESTS, GET_SERVICE_CATALOG_ADMIN } from '@/graphql/queries'
import { useEnumValues } from '@/hooks/useEnumValues'
import { colors, palette } from '@/lib/tokens'
import { useDomainVocabularies } from '@/contexts/DomainVocabularyContext'
import { useSlaCoverageCheck } from '@/hooks/useSlaCoverageCheck'
import { useValueStyle } from '@/hooks/useValueStyle'
// ── Shared styles ─────────────────────────────────────────────────────────────

const inputBase: React.CSSProperties = {
  width:           '100%',
  padding:         '10px 14px',
  border:          `1px solid ${colors.border}`,
  borderRadius:    6,
  fontSize:        14,
  color:           'var(--color-slate-dark)',
  outline:         'none',
  backgroundColor: colors.white,
  boxSizing:       'border-box',
  transition:      'border-color 150ms, box-shadow 150ms',
}

const selectBase: React.CSSProperties = {
  ...inputBase,
  appearance:         'none',
  backgroundImage:    `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%238892a4' stroke-width='2.5'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E")`,
  backgroundRepeat:   'no-repeat',
  backgroundPosition: 'right 12px center',
  paddingRight:       36,
  cursor:             'pointer',
}

function focusHandlers(hasError: boolean) {
  return {
    onFocus: (e: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => {
      e.currentTarget.style.borderColor = 'var(--color-brand)'
      e.currentTarget.style.boxShadow   = `0 0 0 3px ${colors.brandLight}`
    },
    onBlur: (e: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => {
      e.currentTarget.style.borderColor = hasError ? 'var(--color-trigger-sla-breach)' : colors.border
      e.currentTarget.style.boxShadow   = 'none'
    },
  }
}

// ── Component ─────────────────────────────────────────────────────────────────

export function CreateServiceRequestPage() {
  const { t } = useTranslation()
  // F9: il pallino della priorità col colore del Dizionario.
  const styleOf = useValueStyle()
  const { labelOf } = useDomainVocabularies()
  const navigate = useNavigate()
  const ids = { catalog: useId(), title: useId(), priority: useId(), dueDate: useId(), description: useId() }

  const [title, setTitle]           = useState('')
  const [priority, setPriority]     = useState('medium')
  const [description, setDescription] = useState('')
  const [dueDate, setDueDate]       = useState('')
  const [catalogItemId, setCatalogItemId] = useState('')
  const { values: priorityValues, loading: priorityLoading } = useEnumValues('service_request', 'priority')
  const [submitted, setSubmitted]   = useState(false)

  interface CatalogItem { id: string; name: string; description: string | null; category: string | null; requiresApproval: boolean; active: boolean }
  const { data: catalogData } = useQuery<{ serviceCatalogItems: CatalogItem[] }>(GET_SERVICE_CATALOG_ADMIN, { fetchPolicy: 'cache-and-network' })
  const catalogItems = (catalogData?.serviceCatalogItems ?? []).filter((i) => i.active)
  const selectedItem = catalogItems.find((i) => i.id === catalogItemId) ?? null

  const onSelectCatalogItem = (id: string) => {
    setCatalogItemId(id)
    const item = catalogItems.find((i) => i.id === id)
    if (item) {
      setTitle(item.name)
      if (item.description && !description.trim()) setDescription(item.description)
    }
  }

  const titleError = submitted && !title.trim() ? t('forms.fieldRequired') : ''

  const [createRequest, { loading }] = useMutation(CREATE_SERVICE_REQUEST, {
    refetchQueries: [{ query: GET_SERVICE_REQUESTS }],
    onCompleted: () => { toast.success(t('toast.request.created')); navigate('/requests') },
    onError:     (err) => toast.error(err.message),
  })

  const checkSlaCoverage = useSlaCoverageCheck()
  const [checkingSla, setCheckingSla] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setSubmitted(true)
    if (!title.trim() || loading || checkingSla) return
    // Prima di creare: una policy SLA copre questa richiesta? Se no, chi la
    // crea lo sa adesso e decide (useSlaCoverageCheck).
    setCheckingSla(true)
    let decisione: Awaited<ReturnType<typeof checkSlaCoverage>>
    try {
      decisione = await checkSlaCoverage({
        entityType: 'service_request',
        priority, priorityLabel: labelOf('priority', priority) ?? priority,
        category: null, categoryLabel: null, teamId: null, teamName: null,
      })
    } catch (err) {
      toast.error(t('toast.request.slaCoverageUnavailable', { error: err instanceof Error ? err.message : String(err) }))
      return
    } finally {
      setCheckingSla(false)
    }
    if (decisione === 'cancelled') return
    await createRequest({
      variables: {
        input: {
          title:       title.trim(),
          priority,
          description: description || undefined,
          // La scadenza del modulo va all'API (giro nel browser del 14 set 2026:
          // si raccoglieva e non si inviava).
          dueDate:     dueDate || undefined,
          catalogItemId: catalogItemId || undefined,
          ...(decisione === 'accepted' ? { acknowledgeNoSla: true } : {}),
        },
      },
    })
  }

  return (
    <PageContainer>

      {/* Back link */}
      <button
        type="button"
        onClick={() => navigate('/requests')}
        style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'none', border: 'none', cursor: 'pointer', fontSize: 'var(--font-size-body)', color: 'var(--color-slate-light)', marginBottom: 32, padding: 0 }}
        onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = 'var(--color-brand)' }}
        onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = 'var(--color-slate-light)' }}
      >
        <ArrowLeft size={14} />
        {t('pages.createRequest.back')}
      </button>

      {/* Page header */}
      <div style={{ marginBottom: 32 }}>
        <h1 style={{ fontSize: 'var(--font-size-page-title)', fontWeight: 600, color: 'var(--color-slate-dark)', letterSpacing: '-0.02em', margin: 0 }}>
          {t('pages.createRequest.title')}
        </h1>
        <p style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate-light)', marginTop: 6, marginBottom: 0 }}>
          {t('pages.createRequest.subtitle')}
        </p>
      </div>

      {/* Form card */}
      <div style={{ backgroundColor: colors.white, border: `1px solid ${colors.border}`, borderRadius: 12, padding: 32 }}>
        <form onSubmit={handleSubmit} noValidate>

          {/* Catalog item (consigliato, ma la richiesta generica resta possibile) */}
          <div style={{ marginBottom: 24 }}>
            <label htmlFor={ids.catalog} style={{ display: 'block', fontSize: 'var(--font-size-card-title)', fontWeight: 600, color: 'var(--color-slate)', marginBottom: 6, letterSpacing: '0.01em' }}>
              {t('pages.createRequest.catalogItem')} <span style={{ fontWeight: 400, color: 'var(--color-slate-light)' }}>{t('pages.createRequest.recommended')}</span>
            </label>
            <select
              id={ids.catalog}
              value={catalogItemId}
              onChange={(e) => onSelectCatalogItem(e.target.value)}
              style={selectBase}
              {...focusHandlers(false)}
            >
              <option value="">{t('pages.createRequest.genericItem')}</option>
              {catalogItems.map((it) => (
                <option key={it.id} value={it.id}>{it.category ? `${it.category} · ` : ''}{it.name}</option>
              ))}
            </select>
            {selectedItem?.requiresApproval && (
              <p style={{ margin: '6px 0 0', fontSize: 'var(--font-size-body)', color: palette.warning.text }}>
                {t('pages.createRequest.needsApproval')}
              </p>
            )}
          </div>

          {/* Title */}
          <div style={{ marginBottom: 24 }}>
            <label htmlFor={ids.title} style={{ display: 'block', fontSize: 'var(--font-size-card-title)', fontWeight: 600, color: 'var(--color-slate)', marginBottom: 6, letterSpacing: '0.01em' }}>
              Title <span style={{ color: 'var(--color-trigger-sla-breach)' }}>*</span>
            </label>
            <input
              id={ids.title}
              type="text"
              value={title}
              onChange={(e) => { setTitle(e.target.value); if (submitted) setSubmitted(false) }}
              placeholder={t('pages.createRequest.titlePlaceholder')}
              style={{ ...inputBase, borderColor: titleError ? 'var(--color-trigger-sla-breach)' : colors.border }}
              {...focusHandlers(!!titleError)}
            />
            {titleError && (
              <p style={{ margin: '4px 0 0', fontSize: 'var(--font-size-body)', color: 'var(--color-trigger-sla-breach)' }}>{titleError}</p>
            )}
          </div>

          {/* Priority + Due date in grid */}
          <div className="og-pair" style={{ marginBottom: 24 }}>

            {/* Priority */}
            <div>
              <label htmlFor={ids.priority} style={{ display: 'block', fontSize: 'var(--font-size-card-title)', fontWeight: 600, color: 'var(--color-slate)', marginBottom: 6, letterSpacing: '0.01em' }}>
                Priority <span style={{ color: 'var(--color-trigger-sla-breach)' }}>*</span>
              </label>
              <div style={{ position: 'relative' }}>
                <span style={{ position: 'absolute', left: 13, top: '50%', transform: 'translateY(-50%)', width: 8, height: 8, borderRadius: '50%', backgroundColor: styleOf('priority', priority).accent, pointerEvents: 'none', zIndex: 1 }} />
                <select id={ids.priority} value={priority} onChange={(e) => setPriority(e.target.value)} disabled={priorityLoading} style={{ ...selectBase, paddingLeft: 30 }} {...focusHandlers(false)}>
                  {priorityLoading
                    ? <option value="">{t('common.loading')}</option>
                    : priorityValues.map(v => (
                        <option key={v} value={v}>{v.charAt(0).toUpperCase() + v.slice(1)}</option>
                      ))
                  }
                </select>
              </div>
            </div>

            {/* Due date */}
            <div>
              <label htmlFor={ids.dueDate} style={{ display: 'block', fontSize: 'var(--font-size-card-title)', fontWeight: 600, color: 'var(--color-slate)', marginBottom: 6, letterSpacing: '0.01em' }}>
                {t('detail.dueDate')}
              </label>
              <input
                id={ids.dueDate}
                type="date"
                value={dueDate}
                onChange={(e) => setDueDate(e.target.value)}
                style={inputBase}
                {...focusHandlers(false)}
              />
            </div>

          </div>

          {/* Description */}
          <div style={{ marginBottom: 0 }}>
            <label htmlFor={ids.description} style={{ display: 'block', fontSize: 'var(--font-size-card-title)', fontWeight: 600, color: 'var(--color-slate)', marginBottom: 6, letterSpacing: '0.01em' }}>
              {t('common.description')}
            </label>
            <textarea
              id={ids.description}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t('pages.createRequest.descriptionPlaceholder')}
              rows={4}
              style={{ ...inputBase, minHeight: 120, resize: 'vertical' }}
              {...focusHandlers(false)}
            />
          </div>

          {/* Footer */}
          <div style={{ borderTop: `1px solid ${palette.neutral.borderLight}`, marginTop: 32, paddingTop: 24, display: 'flex', justifyContent: 'flex-end', gap: 12 }}>
            <button
              type="button"
              onClick={() => navigate('/requests')}
              style={{ padding: '8px 20px', border: `1px solid ${colors.border}`, backgroundColor: colors.white, borderRadius: 6, fontSize: 'var(--font-size-card-title)', fontWeight: 500, cursor: 'pointer', color: 'var(--color-slate)' }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.backgroundColor = palette.neutral.surface2 }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.backgroundColor = colors.white }}
            >
              {t('common.cancel')}
            </button>
            <button
              type="submit"
              disabled={loading || checkingSla}
              style={{ padding: '8px 20px', backgroundColor: 'var(--color-brand)', color: colors.white, border: 'none', borderRadius: 6, fontSize: 'var(--font-size-card-title)', fontWeight: 500, cursor: loading || checkingSla ? 'not-allowed' : 'pointer', opacity: loading || checkingSla ? 0.8 : 1 }}
              onMouseEnter={(e) => { if (!loading) (e.currentTarget as HTMLElement).style.backgroundColor = 'var(--color-brand-hover)' }}
              onMouseLeave={(e) => { if (!loading) (e.currentTarget as HTMLElement).style.backgroundColor = 'var(--color-brand)' }}
            >
              {loading ? t('common.creating') : t('pages.createRequest.submit')}
            </button>
          </div>

        </form>
      </div>
    </PageContainer>
  )
}
