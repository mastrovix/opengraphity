/**
 * Assistente AI — chat conversazionale fondata sul grafo del tenant.
 * Trasporto SSE (POST /api/assistant/stream), storia inviata a ogni turno.
 * Truth-telling: gli errori compaiono in chat col messaggio reale; l'attività
 * dei tool è mostrata mentre avviene.
 */
import { useState, useRef, useEffect } from 'react'
import { Sparkles, Send, Search, Trash2 } from 'lucide-react'
import { keycloak } from '@/lib/keycloak'
import { PageContainer } from '@/components/PageContainer'

interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
  error?: boolean
}

const TOOL_LABEL: Record<string, string> = {
  cerca_incident:     'Ricerca incident',
  dettaglio_incident: 'Dettaglio incident',
  cerca_ci:           'Ricerca CI',
  analisi_impatto:    'Analisi impatto',
  change_aperti:      'Change aperti',
  cerca_kb:           'Ricerca KB',
}

const SUGGESTIONS = [
  'Quali change sono in corso e che CI toccano?',
  'Se spengo SRV-009 cosa impatto?',
  'Ci sono incident aperti simili tra loro?',
]

export function AssistantPage() {
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
    const apiUrl = import.meta.env['VITE_API_BASE_URL'] ?? ''

    let acc = ''
    let finished = false
    try {
      const res = await fetch(`${apiUrl}/api/assistant/stream`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: keycloak.token ? `Bearer ${keycloak.token}` : '',
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
              setMessages(prev => [...prev, { role: 'assistant', content: `Errore: ${data.message ?? 'sconosciuto'}`, error: true }])
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
        setMessages(prev => [...prev, { role: 'assistant', content: 'Errore: la risposta si è interrotta prima del completamento.', error: true }])
      }
    } catch (err) {
      if (!(err instanceof DOMException && err.name === 'AbortError')) {
        setMessages(prev => [...prev, { role: 'assistant', content: `Errore: ${err instanceof Error ? err.message : String(err)}`, error: true }])
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
          <h1 style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 'var(--font-size-page-title)', fontWeight: 600, color: 'var(--color-slate-dark)', margin: 0 }}>
            <Sparkles size={20} color="var(--color-brand)" /> Assistente AI
          </h1>
          {messages.length > 0 && (
            <button
              onClick={() => setMessages([])}
              disabled={streaming}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '6px 12px', borderRadius: 8, border: '1px solid #e5e7eb', background: '#fff', color: 'var(--color-slate)', fontSize: 'var(--font-size-body)', cursor: 'pointer' }}
            >
              <Trash2 size={13} /> Nuova conversazione
            </button>
          )}
        </div>

        {/* Messaggi */}
        <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 12, padding: '4px 2px 16px' }}>
          {messages.length === 0 && !streaming && (
            <div style={{ margin: 'auto', textAlign: 'center', color: 'var(--color-slate-light)' }}>
              <Sparkles size={28} color="var(--color-brand)" style={{ marginBottom: 10 }} />
              <p style={{ fontSize: 'var(--font-size-body)', margin: '0 0 16px' }}>
                Fai una domanda sul tuo ambiente: incident, CI, impatti, change, knowledge base.<br />
                L'assistente legge il grafo reale — non inventa.
              </p>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'center' }}>
                {SUGGESTIONS.map(s => (
                  <button
                    key={s}
                    onClick={() => void send(s)}
                    style={{ padding: '8px 14px', borderRadius: 18, border: '1px solid #e5e7eb', background: '#fff', color: 'var(--color-slate-dark)', fontSize: 'var(--font-size-body)', cursor: 'pointer' }}
                  >
                    {s}
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
                background: m.error ? 'var(--color-danger-bg)' : m.role === 'user' ? 'var(--color-brand)' : '#fff',
                color: m.error ? 'var(--color-trigger-sla-breach)' : m.role === 'user' ? '#fff' : 'var(--color-slate-dark)',
                border: m.role === 'assistant' ? `1px solid ${m.error ? '#fecaca' : '#e5e7eb'}` : 'none',
              }}
            >
              {m.content}
            </div>
          ))}

          {streaming && (
            <div style={{ alignSelf: 'flex-start', maxWidth: '85%', display: 'flex', flexDirection: 'column', gap: 6 }}>
              {activeTools.length > 0 && (
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {activeTools.map((t, i) => (
                    <span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, padding: '3px 8px', borderRadius: 10, background: '#f0f9ff', border: '1px solid #bae6fd', color: 'var(--color-brand)' }}>
                      <Search size={10} /> {TOOL_LABEL[t] ?? t}
                    </span>
                  ))}
                </div>
              )}
              <div style={{ padding: '10px 14px', borderRadius: 12, background: '#fff', border: '1px solid #e5e7eb', fontSize: 'var(--font-size-body)', lineHeight: 1.5, whiteSpace: 'pre-wrap', color: 'var(--color-slate-dark)' }}>
                {streamText || 'Sto consultando il grafo…'}
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
            placeholder="Chiedi qualcosa sul tuo ambiente…"
            disabled={streaming}
            style={{ flex: 1, padding: '11px 16px', borderRadius: 10, border: '1px solid #e5e7eb', fontSize: 'var(--font-size-body)', outline: 'none', background: '#fff' }}
          />
          <button
            onClick={() => void send(input)}
            disabled={streaming || !input.trim()}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '0 18px', borderRadius: 10, border: 'none', background: streaming || !input.trim() ? '#93c5fd' : 'var(--color-brand)', color: '#fff', fontSize: 'var(--font-size-body)', fontWeight: 500, cursor: streaming || !input.trim() ? 'not-allowed' : 'pointer' }}
          >
            <Send size={14} /> Invia
          </button>
        </div>
      </div>
    </PageContainer>
  )
}
