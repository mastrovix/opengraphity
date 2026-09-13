/**
 * Assistente AI — chat conversazionale fondata sul grafo del tenant.
 * Trasporto SSE (POST /api/assistant/stream), storia inviata a ogni turno.
 * Truth-telling: gli errori compaiono in chat col messaggio reale; l'attività
 * dei tool è mostrata mentre avviene.
 */
import { useState, useRef, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Sparkles, Send, Search, Trash2 } from 'lucide-react'
import { apiUrl, authHeader } from '@/lib/apiBase'
import { PageContainer } from '@/components/PageContainer'
import { PageTitle } from '@/components/PageTitle'
import { colors, palette } from '@/lib/tokens'

interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
  error?: boolean
}

/**
 * I nomi dei tool arrivano dal server come identificatori; l'etichetta a
 * schermo e una CHIAVE, cosi il chip si legge nella lingua del cliente. Un
 * tool che il client non conosce mostra il suo identificatore, invece di
 * sparire.
 */
const TOOL_LABEL_KEY: Record<string, string> = {
  cerca_incident:     'pages.assistant.tool.searchIncidents',
  dettaglio_incident: 'pages.assistant.tool.incidentDetail',
  lista_incident:     'pages.assistant.tool.listIncidents',
  cerca_ci:           'pages.assistant.tool.searchCIs',
  analisi_impatto:    'pages.assistant.tool.impactAnalysis',
  change_aperti:      'pages.assistant.tool.openChanges',
  cerca_kb:           'pages.assistant.tool.searchKB',
}

const SUGGESTION_KEYS = [
  'pages.assistant.suggestion.changesInFlight',
  'pages.assistant.suggestion.shutdownImpact',
  'pages.assistant.suggestion.similarOpenIncidents',
]

export function AssistantPage() {
  const { t } = useTranslation()
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState(false)
  const [streamText, setStreamText] = useState('')
  const [activeTools, setActiveTools] = useState<string[]>([])
  const bottomRef = useRef<HTMLDivElement>(null)
  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, streamText])

  useEffect(() => () => abortRef.current?.abort(), [])

  async function send(text: string) {
    const question = text.trim()
    if (!question || streaming) return
    const history = [...messages.filter(m => !m.error), { role: 'user' as const, content: question }]
    setMessages(prev => [...prev, { role: 'user', content: question }])
    setInput('')
    setStreaming(true)
    setStreamText('')
    setActiveTools([])

    const abort = new AbortController()
    abortRef.current = abort
    let acc = ''
    let finished = false
    try {
      const res = await fetch(apiUrl('/api/assistant/stream'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...authHeader(),
        },
        body: JSON.stringify({ messages: history.map(({ role, content }) => ({ role, content })) }),
        signal: abort.signal,
      })
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      const processBlock = (block: string) => {
        let event = ''
        for (const line of block.split('\n')) {
          if (line.startsWith('event: ')) event = line.slice(7).trim()
          else if (line.startsWith('data: ')) {
            const data = JSON.parse(line.slice(6)) as { delta?: string; name?: string; text?: string; message?: string }
            if (event === 'text' && data.delta) { acc += data.delta; setStreamText(acc) }
            else if (event === 'tool' && data.name) setActiveTools(prev => [...prev, data.name!])
            else if (event === 'done') {
              finished = true
              setMessages(prev => [...prev, { role: 'assistant', content: data.text ?? acc }])
            } else if (event === 'error') {
              finished = true
              setMessages(prev => [...prev, { role: 'assistant', content: t('pages.assistant.error', { message: data.message ?? t('pages.assistant.unknownError') }), error: true }])
            }
          }
        }
      }

      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const blocks = buffer.split('\n\n')
        buffer = blocks.pop() ?? ''
        for (const b of blocks) if (b.trim()) processBlock(b)
      }
      if (buffer.trim()) processBlock(buffer)

      // Stream chiuso senza done/error: esito NON affidabile — dillo.
      if (!finished) {
        setMessages(prev => [...prev, { role: 'assistant', content: t('pages.assistant.streamTruncated'), error: true }])
      }
    } catch (err) {
      if (!(err instanceof DOMException && err.name === 'AbortError')) {
        setMessages(prev => [...prev, { role: 'assistant', content: t('pages.assistant.error', { message: err instanceof Error ? err.message : String(err) }), error: true }])
      }
    } finally {
      setStreaming(false)
      setStreamText('')
      setActiveTools([])
    }
  }

  return (
    <PageContainer style={{ display: 'flex', flexDirection: 'column', height: 'calc(100vh - 56px)' }}>
      <div style={{ maxWidth: 780, width: '100%', margin: '0 auto', display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px 0 12px' }}>
          {/* Il titolo passa da PageTitle come le altre pagine: era un <h1> scritto a mano, con l'icona piu piccola e di un altro colore. */}
          <PageTitle icon={<Sparkles size={22} color="var(--color-icon-accent)" />}>{t('sidebar.assistant')}</PageTitle>
          {messages.length > 0 && (
            <button type="button"
              onClick={() => setMessages([])}
              disabled={streaming}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '6px 12px', borderRadius: 8, border: '1px solid var(--border)', background: colors.white, color: 'var(--color-slate)', fontSize: 'var(--font-size-body)', cursor: 'pointer' }}
            >
              <Trash2 size={13} /> {t('pages.reportsAI.newConversation')}
            </button>
          )}
        </div>

        {/* Messaggi */}
        <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 12, padding: '4px 2px 16px' }}>
          {messages.length === 0 && !streaming && (
            <div style={{ margin: 'auto', textAlign: 'center', color: 'var(--color-slate-light)' }}>
              <Sparkles size={28} color="var(--color-brand)" style={{ marginBottom: 10 }} />
              <p style={{ fontSize: 'var(--font-size-body)', margin: '0 0 16px' }}>
                {t('pages.assistant.intro')}<br />
                {t('pages.assistant.introNote')}
              </p>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'center' }}>
                {SUGGESTION_KEYS.map(k => (
                  <button type="button"
                    key={k}
                    onClick={() => void send(t(k))}
                    style={{ padding: '8px 14px', borderRadius: 18, border: '1px solid var(--border)', background: colors.white, color: 'var(--color-slate-dark)', fontSize: 'var(--font-size-body)', cursor: 'pointer' }}
                  >
                    {t(k)}
                  </button>
                ))}
              </div>
            </div>
          )}

          {messages.map((m, i) => (
            <div
              key={i}
              style={{
                alignSelf: m.role === 'user' ? 'flex-end' : 'flex-start',
                maxWidth: '85%',
                padding: '10px 14px',
                borderRadius: 12,
                fontSize: 'var(--font-size-body)',
                lineHeight: 1.5,
                whiteSpace: 'pre-wrap',
                background: m.error ? 'var(--color-danger-bg)' : m.role === 'user' ? 'var(--color-brand)' : colors.white,
                color: m.error ? 'var(--color-trigger-sla-breach)' : m.role === 'user' ? colors.white : 'var(--color-slate-dark)',
                border: m.role === 'assistant' ? `1px solid ${m.error ? palette.danger.border : 'var(--border)'}` : 'none',
              }}
            >
              {m.content}
            </div>
          ))}

          {streaming && (
            <div style={{ alignSelf: 'flex-start', maxWidth: '85%', display: 'flex', flexDirection: 'column', gap: 6 }}>
              {activeTools.length > 0 && (
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {activeTools.map((tool, i) => (
                    <span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, padding: '3px 8px', borderRadius: 10, background: palette.info.light, border: `1px solid ${palette.info.border}`, color: 'var(--color-brand)' }}>
                      <Search size={10} /> {TOOL_LABEL_KEY[tool] ? t(TOOL_LABEL_KEY[tool]) : tool}
                    </span>
                  ))}
                </div>
              )}
              <div style={{ padding: '10px 14px', borderRadius: 12, background: colors.white, border: '1px solid var(--border)', fontSize: 'var(--font-size-body)', lineHeight: 1.5, whiteSpace: 'pre-wrap', color: 'var(--color-slate-dark)' }}>
                {streamText || t('pages.assistant.thinking')}
              </div>
            </div>
          )}
          <div ref={bottomRef} />
        </div>

        {/* Input */}
        <div style={{ display: 'flex', gap: 8, padding: '12px 0 20px' }}>
          <input
            type="text"
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(input) } }}
            placeholder={t('pages.assistant.placeholder')}
            disabled={streaming}
            style={{ flex: 1, padding: '11px 16px', borderRadius: 10, border: '1px solid var(--border)', fontSize: 'var(--font-size-body)', outline: 'none', background: colors.white }}
          />
          <button type="button"
            onClick={() => void send(input)}
            disabled={streaming || !input.trim()}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '0 18px', borderRadius: 10, border: 'none', background: streaming || !input.trim() ? palette.info.border : 'var(--color-brand)', color: colors.white, fontSize: 'var(--font-size-body)', fontWeight: 500, cursor: streaming || !input.trim() ? 'not-allowed' : 'pointer' }}
          >
            <Send size={14} /> {t('pages.reportsAI.send')}
          </button>
        </div>
      </div>
    </PageContainer>
  )
}
