import { useState, useEffect, useRef } from 'react'
import { useMutation, useLazyQuery } from '@apollo/client/react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { Monitor, Code, Key, Wifi, HelpCircle, ShieldAlert, Tag, Paperclip } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { CREATE_TICKET } from '@/graphql/mutations'
import { GET_KB_ARTICLES } from '@/graphql/queries'
import { useFormFieldRules, validateFormFields } from '@/hooks/useFormFieldRules'
import { notifyError } from '@/lib/notify'
import { uploadAttachment } from '@/lib/attachments'
import { colors, palette } from '@/lib/tokens'
import { useTicketCategories } from '@/hooks/useTicketCategories'
import { usePortalSeverityChoices } from '@/hooks/usePortalSeverityChoices'
import { usePortalCustomFields, portalCustomFieldsInput, portalMissingCustomFields } from '@/hooks/usePortalCustomFields'
import { PortalCustomFields } from '@/components/PortalCustomFields'

/**
 * Icone per i valori spediti del vocabolario `category`. Le categorie vengono
 * dal Dizionario del cliente (useTicketCategories): un valore che il cliente ha
 * aggiunto ha l'icona generica, non manca.
 */
const CATEGORY_ICONS: Readonly<Record<string, LucideIcon>> = {
  hardware: Monitor, software: Code, access: Key, network: Wifi, security: ShieldAlert, other: HelpCircle,
}

interface KBArticle { id: string; title: string; slug: string; category: string }

export function TicketNewPage() {
  const { t }      = useTranslation()
  const navigate   = useNavigate()

  const { categories, error: categoriesError } = useTicketCategories()
  const [category,    setCategory]    = useState<string>('')
  const [title,       setTitle]       = useState('')
  const [description, setDescription] = useState('')
  // Nessuna severità preselezionata: la sceglie chi apre il ticket, fra quelle offerte dall'amministratore.
  const { choices: severityChoices, error: severityError } = usePortalSeverityChoices()
  const [priority,    setPriority]    = useState('')
  const [files,       setFiles]       = useState<File[]>([])
  const [uploading,   setUploading]   = useState(false)
  const [isDragging,  setIsDragging]  = useState(false)
  const fileInputRef                  = useRef<HTMLInputElement>(null)
  const debounceRef                   = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  // I campi del cliente offerti nel portale (verifica «Cosa resta cablato», ondata 4).
  const { fields: customFields } = usePortalCustomFields('incident', category)
  const [customValues, setCustomValues] = useState<Record<string, string>>({})

  // The mutation creates an Incident (and attachments are uploaded with
  // entityType 'incident'), so the admin-configured field rules that apply
  // are the incident ones — the same set apps/web CreateIncidentPage uses.
  // Service requests have their own flow (ServiceCatalogPage → createServiceRequest).
  const ticketFormValues = { title, description, priority, category }
  const { rules: ticketFieldRules, error: rulesError } = useFormFieldRules('incident', null, ticketFormValues)

  const [createTicket, { loading }] = useMutation<{ createTicket: { id: string } }>(CREATE_TICKET, {
    onCompleted: (data) => {
      void uploadFilesAndNavigate(data.createTicket.id)
    },
    onError: (e: { message: string }) => notifyError(e.message),
  })

  async function uploadFilesAndNavigate(ticketId: string) {
    if (files.length > 0) {
      setUploading(true)
      const failed: string[] = []
      for (const file of files) {
        try {
          await uploadAttachment('incident', ticketId, file)
        } catch {
          failed.push(file.name)
        }
      }
      setUploading(false)
      if (failed.length > 0) notifyError(t('ticket.uploadFailed', { files: failed.join(', ') }))
    }
    navigate(`/tickets/${ticketId}`, { state: { created: true } })
  }

  const [searchKB, { data: kbData }] = useLazyQuery<{ kbArticles: { items: KBArticle[] } }, { search?: string; pageSize?: number }>(GET_KB_ARTICLES)

  // Debounced KB search as user types title
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    if (title.trim().length < 3) return
    debounceRef.current = setTimeout(() => {
      void searchKB({ variables: { search: title.trim(), pageSize: 3 } })
    }, 500)
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current) }
  }, [title, searchKB])

  const suggestedArticles = kbData?.kbArticles?.items ?? []

  function handleDrop(e: React.DragEvent) {
    e.preventDefault()
    setIsDragging(false)
    setFiles(prev => [...prev, ...Array.from(e.dataTransfer.files)])
  }

  function handleFileInput(e: React.ChangeEvent<HTMLInputElement>) {
    if (e.target.files) setFiles(prev => [...prev, ...Array.from(e.target.files!)])
  }

  function removeFile(idx: number) {
    setFiles(prev => prev.filter((_, i) => i !== idx))
  }

  const canSubmit = category !== '' && priority !== '' && title.trim().length > 0 && description.trim().length > 0 && !loading && !uploading

  function handleSubmit() {
    if (!canSubmit) return
    // Rules failed to load: do not silently treat required fields as optional.
    if (rulesError) {
      notifyError(t('ticket.rulesError', { message: rulesError.message }))
      return
    }
    const missing = [...validateFormFields(ticketFieldRules, ticketFormValues), ...portalMissingCustomFields(customFields, customValues)]
    if (missing.length > 0) {
      const errs: Record<string, string> = {}
      missing.forEach((f) => { errs[f] = t('common.required') })
      setFieldErrors(errs)
      return
    }
    setFieldErrors({})
    // `canSubmit` garantisce una descrizione non vuota: nessun ramo «undefined».
    void createTicket({ variables: { title: title.trim(), description: description.trim(), priority, category, customFields: portalCustomFieldsInput(customFields, customValues) } })
  }

  return (
    <div style={{ maxWidth: 640, margin: '0 auto' }}>
      <h1 style={{ fontSize: 20, fontWeight: 600, color: colors.slateDark, marginBottom: 28 }}>
        {t('ticket.new')}
      </h1>
      {Object.keys(fieldErrors).length > 0 && (
        <div role="alert" style={{ background: palette.danger.bg, border: `1px solid ${palette.danger.border}`, color: palette.danger.strong, padding: '10px 14px', borderRadius: 8, fontSize: 13, marginBottom: 16 }}>
          {t('common.required')}: {Object.keys(fieldErrors).map((k) => customFields.find((f) => f.name === k)?.label ?? k).join(', ')}
        </div>
      )}

      {/* Category selection */}
      <div style={{ marginBottom: 24 }}>
        <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: colors.slate, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 10 }}>
          {t('ticket.fields.category')} *
        </label>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(96px, 1fr))', gap: 10 }}>
          {categories.map(({ name: key, label }) => { const Icon = CATEGORY_ICONS[key] ?? Tag; return (
            <button
              key={key}
              onClick={() => setCategory(key)}
              style={{
                display:         'flex',
                flexDirection:   'column',
                alignItems:      'center',
                gap:             8,
                padding:         '16px 8px',
                borderRadius:    10,
                border:          `2px solid ${category === key ? colors.brand : colors.border}`,
                backgroundColor: category === key ? colors.brandLight : colors.white,
                cursor:          'pointer',
                transition:      'border-color 0.15s, background 0.15s',
              }}
            >
              <Icon size={22} style={{ color: category === key ? colors.brand : colors.slate }} />
              <span style={{ fontSize: 12, fontWeight: 500, color: category === key ? colors.brand : colors.slate }}>
                {label}
              </span>
            </button>
          ) })}
        </div>
        {categoriesError && (
          <p role="alert" style={{ marginTop: 8, fontSize: 12, color: palette.danger.strong }}>{categoriesError.message}</p>
        )}
      </div>

      {/* Title */}
      <div style={{ marginBottom: 20 }}>
        <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: colors.slate, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>
          {t('ticket.fields.title')} *
        </label>
        <input
          value={title}
          onChange={e => setTitle(e.target.value)}
          placeholder={t('ticket.fields.title')}
          style={{
            width: '100%', padding: '10px 12px',
            border: `1.5px solid ${colors.border}`, borderRadius: 8, fontSize: 12, outline: 'none',
          }}
          onFocus={e => { e.currentTarget.style.borderColor = colors.brand }}
          onBlur={e  => { e.currentTarget.style.borderColor = colors.border }}
        />
      </div>

      {/* Suggested KB articles (after typing title) */}
      {suggestedArticles.length > 0 && (
        <div style={{
          marginBottom:    20,
          padding:         16,
          backgroundColor: palette.warning.bg,
          border:          `1px solid ${palette.warning.border}`,
          borderRadius:    8,
        }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: palette.warning.strong, marginBottom: 10 }}>
            💡 {t('ticket.suggestedArticles')}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {suggestedArticles.map(a => (
              <a
                key={a.id}
                href={`/kb/${a.slug}`}
                target="_blank"
                rel="noreferrer"
                style={{ fontSize: 12, color: colors.brand, textDecoration: 'underline' }}
              >
                {a.title}
              </a>
            ))}
          </div>
          <div style={{ fontSize: 12, color: palette.warning.strong, marginTop: 8 }}>
            {t('ticket.foundAnswer')}
          </div>
        </div>
      )}

      {/* Description */}
      <div style={{ marginBottom: 20 }}>
        {/* H-35: la descrizione E obbligatoria — senza, «Invia ticket» resta
            grigio — ma l'etichetta non lo diceva, a differenza di categoria,
            titolo e severita: chi compilava tutto il resto non capiva perche
            il pulsante non si accendeva. */}
        <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: colors.slate, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>
          {t('ticket.fields.description')} *
        </label>
        <textarea
          value={description}
          onChange={e => setDescription(e.target.value)}
          placeholder={t('ticket.fields.description')}
          rows={6}
          style={{
            width: '100%', padding: '10px 12px',
            border: `1.5px solid ${colors.border}`, borderRadius: 8, fontSize: 12,
            resize: 'vertical', outline: 'none', lineHeight: 1.6,
          }}
          onFocus={e => { e.currentTarget.style.borderColor = colors.brand }}
          onBlur={e  => { e.currentTarget.style.borderColor = colors.border }}
        />
      </div>

      {/* Campi del cliente */}
      {customFields.length > 0 && (
        <div style={{ marginBottom: 20 }}>
          <PortalCustomFields
            fields={customFields}
            values={customValues}
            errors={fieldErrors}
            onChange={(name, value) => { setCustomValues((v) => ({ ...v, [name]: value })); setFieldErrors((p) => { const n = { ...p }; delete n[name]; return n }) }}
            labelStyle={{ display: 'block', fontSize: 12, fontWeight: 600, color: colors.slate, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}
            inputStyle={{ width: '100%', padding: '10px 12px', border: `1.5px solid ${colors.border}`, borderRadius: 8, fontSize: 12, outline: 'none', background: colors.white, boxSizing: 'border-box' }}
          />
        </div>
      )}

      {/* Severità: la stessa parola della pagina Organizzazione («Severità del portale»), ed è il campo che il ticket salva */}
      <div style={{ marginBottom: 24 }}>
        <div id="ticket-severity-label" style={{ display: 'block', fontSize: 12, fontWeight: 600, color: colors.slate, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 10 }}>
          {t('ticket.fields.severity')} *
        </div>
        <div role="radiogroup" aria-labelledby="ticket-severity-label" aria-required="true" style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          {severityChoices.map(c => (
            <label key={c.value} style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 12, color: colors.slateDark }}>
              <input
                type="radio"
                name="priority"
                value={c.value}
                checked={priority === c.value}
                onChange={() => setPriority(c.value)}
                style={{ accentColor: colors.brand }}
              />
              {c.label}
            </label>
          ))}
        </div>
        {severityError && (
          <p role="alert" style={{ marginTop: 8, fontSize: 12, color: palette.danger.strong }}>{severityError.message}</p>
        )}
      </div>

      {/* File drop zone */}
      <div style={{ marginBottom: 28 }}>
        <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: colors.slate, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 8 }}>
          {t('ticket.fields.attachments')}
        </label>
        {/*
          * UN BOTTONE, NON UN DIV (21 set 2026).
          *
          * Questa zona apriva il selettore dei file con un `onClick` su un
          * `<div>`: col mouse funzionava, col tasto Tab non ci si arrivava
          * nemmeno, e allegare un file era impossibile senza puntatore.
          * Trascinare resta comunque cosa da mouse — per questo l'apertura
          * del selettore doveva essere raggiungibile in altro modo.
          *
          * Il campo `<input type="file">` esce dal bottone: un controllo di
          * modulo dentro un bottone non e' HTML valido.
          */}
        <button
          type="button"
          onDragOver={e => { e.preventDefault(); setIsDragging(true) }}
          onDragLeave={() => setIsDragging(false)}
          onDrop={handleDrop}
          onClick={() => fileInputRef.current?.click()}
          style={{
            display:         'block',
            width:           '100%',
            font:            'inherit',
            border:          `2px dashed ${isDragging ? colors.brand : palette.neutral.borderStrong}`,
            borderRadius:    8,
            padding:         24,
            textAlign:       'center',
            cursor:          'pointer',
            backgroundColor: isDragging ? colors.brandLight : palette.neutral.surface1,
            transition:      'border-color 0.15s, background 0.15s',
          }}
        >
          <Paperclip size={20} style={{ color: colors.slateLight, marginBottom: 6 }} />
          <div style={{ fontSize: 12, color: colors.slate }}>{t('ticket.dropFiles')}</div>
        </button>
        <input ref={fileInputRef} type="file" multiple style={{ display: 'none' }} onChange={handleFileInput} />
        {files.length > 0 && (
          <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 4 }}>
            {files.map((f, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 10px', backgroundColor: palette.neutral.surface1, borderRadius: 6, fontSize: 12 }}>
                <span style={{ color: colors.slateDark, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.name}</span>
                <button onClick={() => removeFile(i)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: colors.danger, fontSize: 12, flexShrink: 0 }}>×</button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Submit */}
      <button
        disabled={!canSubmit}
        onClick={handleSubmit}
        style={{
          width:           '100%',
          padding:         '13px 24px',
          backgroundColor: canSubmit ? colors.brand : colors.border,
          color:           canSubmit ? colors.white : colors.slateLight,
          border:          'none',
          borderRadius:    8,
          fontSize:        15,
          fontWeight:      600,
          cursor:          canSubmit ? 'pointer' : 'not-allowed',
        }}
      >
        {uploading ? t('ticket.uploading') : loading ? t('common.loading') : t('ticket.submit')}
      </button>
    </div>
  )
}
