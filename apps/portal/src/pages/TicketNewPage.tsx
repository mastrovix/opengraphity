import { useState, useEffect, useRef } from 'react'
import { useMutation, useLazyQuery } from '@apollo/client/react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { Monitor, Code, Key, Wifi, HelpCircle, Paperclip } from 'lucide-react'
import { CREATE_TICKET } from '@/graphql/mutations'
import { GET_KB_ARTICLES } from '@/graphql/queries'
import { useFormFieldRules, validateFormFields } from '@/hooks/useFormFieldRules'

const CATEGORIES = [
  { key: 'hardware', icon: Monitor },
  { key: 'software', icon: Code },
  { key: 'access',   icon: Key },
  { key: 'network',  icon: Wifi },
  { key: 'other',    icon: HelpCircle },
] as const

type CategoryKey = typeof CATEGORIES[number]['key']

const PRIORITIES = ['low', 'medium', 'high'] as const

interface KBArticle { id: string; title: string; slug: string; category: string }

export function TicketNewPage() {
  const { t }      = useTranslation()
  const navigate   = useNavigate()

  const [category,    setCategory]    = useState<CategoryKey | ''>('')
  const [title,       setTitle]       = useState('')
  const [description, setDescription] = useState('')
  const [priority,    setPriority]    = useState<'low' | 'medium' | 'high'>('medium')
  const [files,       setFiles]       = useState<File[]>([])
  const [isDragging,  setIsDragging]  = useState(false)
  const fileInputRef                  = useRef<HTMLInputElement>(null)
  const debounceRef                   = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [_fieldErrors, setFieldErrors] = useState<Record<string, string>>({})

  const ticketFormValues = { title, description, priority, category }
  const ticketFieldRules = useFormFieldRules('service_request', null, ticketFormValues)

  const [createTicket, { loading }] = useMutation<{ createTicket: { id: string } }>(CREATE_TICKET, {
    onCompleted: (data) => {
      navigate(`/tickets/${data.createTicket.id}`, { state: { created: true } })
    },
    onError: (e: { message: string }) => alert(e.message),
  })

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

  const canSubmit = category !== '' && title.trim().length > 0 && description.trim().length > 0 && !loading

  function handleSubmit() {
    if (!canSubmit) return
    const missing = validateFormFields(ticketFieldRules, ticketFormValues)
    if (missing.length > 0) {
      const errs: Record<string, string> = {}
      missing.forEach((f) => { errs[f] = t('common.required') })
      setFieldErrors(errs)
      return
    }
    setFieldErrors({})
    void createTicket({ variables: { title: title.trim(), description: description.trim() || undefined, priority, category } })
  }

  return (
    <div style={{ maxWidth: 640, margin: '0 auto' }}>
      <h1 style={{ fontSize: 20, fontWeight: 600, color: '#0F172A', marginBottom: 28 }}>
        {t('ticket.new')}
      </h1>

      {/* Category selection */}
      <div style={{ marginBottom: 24 }}>
        <label style={{ display: 'block', fontSize: 10, fontWeight: 600, color: '#64748B', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 10 }}>
          {t('ticket.fields.category')} *
        </label>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 10 }}>
          {CATEGORIES.map(({ key, icon: Icon }) => (
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
                border:          `2px solid ${category === key ? '#0EA5E9' : '#E2E8F0'}`,
                backgroundColor: category === key ? '#F0F9FF' : '#fff',
                cursor:          'pointer',
                transition:      'border-color 0.15s, background 0.15s',
              }}
            >
              <Icon size={22} style={{ color: category === key ? '#0EA5E9' : '#64748B' }} />
              <span style={{ fontSize: 10, fontWeight: 500, color: category === key ? '#0EA5E9' : '#64748B' }}>
                {t(`ticket.category.${key}`)}
              </span>
            </button>
          ))}
        </div>
      </div>

      {/* Title */}
      <div style={{ marginBottom: 20 }}>
        <label style={{ display: 'block', fontSize: 10, fontWeight: 600, color: '#64748B', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>
          {t('ticket.fields.title')} *
        </label>
        <input
          value={title}
          onChange={e => setTitle(e.target.value)}
          placeholder={t('ticket.fields.title')}
          style={{
            width: '100%', padding: '10px 12px',
            border: '1.5px solid #E2E8F0', borderRadius: 8, fontSize: 10, outline: 'none',
          }}
          onFocus={e => { e.currentTarget.style.borderColor = '#0EA5E9' }}
          onBlur={e  => { e.currentTarget.style.borderColor = '#E2E8F0' }}
        />
      </div>

      {/* Suggested KB articles (after typing title) */}
      {suggestedArticles.length > 0 && (
        <div style={{
          marginBottom:    20,
          padding:         16,
          backgroundColor: '#FFFBEB',
          border:          '1px solid #FDE68A',
          borderRadius:    8,
        }}>
          <div style={{ fontSize: 10, fontWeight: 600, color: '#92400E', marginBottom: 10 }}>
            💡 {t('ticket.suggestedArticles')}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {suggestedArticles.map(a => (
              <a
                key={a.id}
                href={`/kb/${a.slug}`}
                target="_blank"
                rel="noreferrer"
                style={{ fontSize: 10, color: '#0EA5E9', textDecoration: 'underline' }}
              >
                {a.title}
              </a>
            ))}
          </div>
          <div style={{ fontSize: 10, color: '#92400E', marginTop: 8 }}>
            {t('ticket.foundAnswer')}
          </div>
        </div>
      )}

      {/* Description */}
      <div style={{ marginBottom: 20 }}>
        <label style={{ display: 'block', fontSize: 10, fontWeight: 600, color: '#64748B', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>
          {t('ticket.fields.description')}
        </label>
        <textarea
          value={description}
          onChange={e => setDescription(e.target.value)}
          placeholder={t('ticket.fields.description')}
          rows={6}
          style={{
            width: '100%', padding: '10px 12px',
            border: '1.5px solid #E2E8F0', borderRadius: 8, fontSize: 10,
            resize: 'vertical', outline: 'none', lineHeight: 1.6,
          }}
          onFocus={e => { e.currentTarget.style.borderColor = '#0EA5E9' }}
          onBlur={e  => { e.currentTarget.style.borderColor = '#E2E8F0' }}
        />
      </div>

      {/* Priority */}
      <div style={{ marginBottom: 24 }}>
        <label style={{ display: 'block', fontSize: 10, fontWeight: 600, color: '#64748B', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 10 }}>
          {t('ticket.fields.priority')}
        </label>
        <div style={{ display: 'flex', gap: 12 }}>
          {PRIORITIES.map(p => (
            <label key={p} style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 10, color: '#0F172A' }}>
              <input
                type="radio"
                name="priority"
                value={p}
                checked={priority === p}
                onChange={() => setPriority(p)}
                style={{ accentColor: '#0EA5E9' }}
              />
              {t(`ticket.priority.${p}`)}
            </label>
          ))}
        </div>
      </div>

      {/* File drop zone */}
      <div style={{ marginBottom: 28 }}>
        <label style={{ display: 'block', fontSize: 10, fontWeight: 600, color: '#64748B', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 8 }}>
          {t('ticket.fields.attachments')}
        </label>
        <div
          onDragOver={e => { e.preventDefault(); setIsDragging(true) }}
          onDragLeave={() => setIsDragging(false)}
          onDrop={handleDrop}
          onClick={() => fileInputRef.current?.click()}
          style={{
            border:          `2px dashed ${isDragging ? '#0EA5E9' : '#CBD5E1'}`,
            borderRadius:    8,
            padding:         24,
            textAlign:       'center',
            cursor:          'pointer',
            backgroundColor: isDragging ? '#F0F9FF' : '#FAFAFA',
            transition:      'border-color 0.15s, background 0.15s',
          }}
        >
          <Paperclip size={20} style={{ color: '#94A3B8', marginBottom: 6 }} />
          <div style={{ fontSize: 10, color: '#64748B' }}>{t('ticket.dropFiles')}</div>
          <input ref={fileInputRef} type="file" multiple style={{ display: 'none' }} onChange={handleFileInput} />
        </div>
        {files.length > 0 && (
          <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 4 }}>
            {files.map((f, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 10px', backgroundColor: '#F8FAFC', borderRadius: 6, fontSize: 10 }}>
                <span style={{ color: '#0F172A', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.name}</span>
                <button onClick={() => removeFile(i)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#EF4444', fontSize: 10, flexShrink: 0 }}>×</button>
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
          backgroundColor: canSubmit ? '#0EA5E9' : '#E2E8F0',
          color:           canSubmit ? '#fff' : '#94A3B8',
          border:          'none',
          borderRadius:    8,
          fontSize:        15,
          fontWeight:      600,
          cursor:          canSubmit ? 'pointer' : 'not-allowed',
        }}
      >
        {loading ? t('common.loading') : t('ticket.submit')}
      </button>
    </div>
  )
}
