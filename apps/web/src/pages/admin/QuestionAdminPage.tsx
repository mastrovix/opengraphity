import { useState, useEffect } from 'react'
import { useQuery, useMutation } from '@apollo/client/react'
import { toast } from 'sonner'
import { HelpCircle, Plus, Trash2, X, ChevronUp, ChevronDown } from 'lucide-react'
import { PageContainer } from '@/components/PageContainer'
import { PageTitle } from '@/components/PageTitle'
import {
  GET_QUESTIONS_ADMIN,
  GET_QUESTION_CITYPE_ASSIGNMENTS,
  GET_CI_TYPES,
} from '@/graphql/queries'
import {
  CREATE_QUESTION,
  UPDATE_QUESTION,
  DELETE_QUESTION,
  ASSIGN_QUESTION_TO_CITYPE,
  REMOVE_QUESTION_FROM_CITYPE,
  SET_QUESTION_CORE,
} from '@/graphql/mutations'

interface AnswerOption {
  id?:       string
  label:     string
  score:     number
  sortOrder: number
}

interface Question {
  id:        string
  text:      string
  category:  string
  isCore:    boolean
  isActive:  boolean
  createdAt: string
  options:   AnswerOption[]
}

interface CIType {
  id:     string
  name:   string
  label:  string
  active: boolean
}

interface CITypeAssignment {
  ciTypeId:   string
  ciTypeName: string
  weight:     number
  sortOrder:  number
}

// ── Styles ────────────────────────────────────────────────────────────────────

const inputStyle: React.CSSProperties = {
  width: '100%', padding: '8px 12px', border: '1px solid #e5e7eb',
  borderRadius: 6, fontSize: 'var(--font-size-body)', color: 'var(--color-slate-dark)',
  boxSizing: 'border-box',
}

const labelStyle: React.CSSProperties = {
  display: 'block', fontSize: 'var(--font-size-label)', fontWeight: 600,
  color: 'var(--color-slate-light)', textTransform: 'uppercase', letterSpacing: '0.04em',
  marginBottom: 6,
}

const CATEGORY_COLORS: Record<string, { bg: string; color: string }> = {
  functional: { bg: '#dbeafe', color: '#2563eb' },
  technical:  { bg: '#dcfce7', color: '#16a34a' },
}

function CategoryBadge({ category }: { category: string }) {
  const s = CATEGORY_COLORS[category] ?? { bg: '#f1f5f9', color: 'var(--color-slate)' }
  return (
    <span style={{
      display: 'inline-block', padding: '2px 8px', borderRadius: 6,
      fontSize: 'var(--font-size-label)', fontWeight: 600,
      backgroundColor: s.bg, color: s.color, textTransform: 'uppercase',
    }}>
      {category}
    </span>
  )
}

// ── Component ─────────────────────────────────────────────────────────────────

export function QuestionAdminPage() {
  const { data: qData, refetch: refetchQuestions } = useQuery<{ assessmentQuestionsAdmin: Question[] }>(GET_QUESTIONS_ADMIN, {
    fetchPolicy: 'cache-and-network',
  })
  const { data: typesData } = useQuery<{ ciTypes: CIType[] }>(GET_CI_TYPES)

  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [filterCat,  setFilterCat]  = useState<string>('')

  // Editor state
  const [text,      setText]     = useState('')
  const [category,  setCategory] = useState<'functional' | 'technical'>('functional')
  const [isCore,    setIsCore]   = useState(true)
  const [isActive,  setIsActive] = useState(true)
  const [options,   setOptions]  = useState<AnswerOption[]>([])
  const [isNew,     setIsNew]    = useState(false)

  const allQuestions = qData?.assessmentQuestionsAdmin ?? []
  const questions = allQuestions.filter(q =>
    !filterCat || (q.category ?? '').toLowerCase() === filterCat.toLowerCase()
  )
  // eslint-disable-next-line no-console
  console.debug('[QuestionAdmin] filter:', JSON.stringify(filterCat), '| total:', allQuestions.length,
    '| filtered:', questions.length,
    '| categories in data:', Array.from(new Set(allQuestions.map(q => q.category))))
  const ciTypes   = (typesData?.ciTypes ?? []).filter(t => t.active)

  const selected = questions.find(q => q.id === selectedId) ?? null

  useEffect(() => {
    if (selected) {
      setText(selected.text)
      setCategory(selected.category as 'functional' | 'technical')
      setIsCore(selected.isCore)
      setIsActive(selected.isActive)
      setOptions(selected.options.map(o => ({ id: o.id, label: o.label, score: o.score, sortOrder: o.sortOrder })))
      setIsNew(false)
    }
  }, [selectedId]) // eslint-disable-line react-hooks/exhaustive-deps

  const { data: assignData, refetch: refetchAssignments } = useQuery<{ questionCITypeAssignments: CITypeAssignment[] }>(
    GET_QUESTION_CITYPE_ASSIGNMENTS,
    { variables: { questionId: selectedId ?? '' }, skip: !selectedId || isCore },
  )
  const assignments = assignData?.questionCITypeAssignments ?? []

  const [createQuestion] = useMutation<{ createAssessmentQuestion: { id: string } }>(CREATE_QUESTION, {
    onCompleted: async (data) => {
      toast.success('Domanda creata')
      await refetchQuestions()
      if (data?.createAssessmentQuestion?.id) {
        setSelectedId(data.createAssessmentQuestion.id)
      }
      setIsNew(false)
    },
    onError: (e) => { console.error('[createQuestion]', e); toast.error(e.message) },
  })
  const [updateQuestion] = useMutation(UPDATE_QUESTION, {
    onCompleted: () => { toast.success('Domanda aggiornata'); void refetchQuestions() },
    onError: (e) => { console.error('[updateQuestion]', e); toast.error(e.message) },
  })
  const [deleteQuestion] = useMutation(DELETE_QUESTION, {
    onCompleted: () => { toast.success('Domanda eliminata'); setSelectedId(null); void refetchQuestions() },
    onError: (e) => { console.error('[deleteQuestion]', e); toast.error(e.message) },
  })
  const [assignToCIType] = useMutation(ASSIGN_QUESTION_TO_CITYPE, {
    onCompleted: () => { void refetchAssignments() },
    onError: (e) => { console.error('[assignToCIType]', e); toast.error(e.message) },
  })
  const [removeFromCIType] = useMutation(REMOVE_QUESTION_FROM_CITYPE, {
    onCompleted: () => { void refetchAssignments() },
    onError: (e) => { console.error('[removeFromCIType]', e); toast.error(e.message) },
  })
  const [setCore] = useMutation(SET_QUESTION_CORE, {
    onCompleted: () => { void refetchQuestions(); void refetchAssignments() },
    onError: (e) => { console.error('[setQuestionCore]', e); toast.error(e.message) },
  })

  const handleNew = () => {
    setSelectedId(null)
    setText('')
    setCategory('functional')
    setIsCore(true)
    setIsActive(true)
    setOptions([{ label: '', score: 0, sortOrder: 0 }])
    setIsNew(true)
  }

  const handleSave = () => {
    if (!text.trim()) { toast.error('Testo obbligatorio'); return }
    if (options.length === 0) { toast.error('Almeno una opzione'); return }
    const optInput = options.map(o => ({ label: o.label, score: o.score, sortOrder: o.sortOrder }))
    if (isNew) {
      void createQuestion({ variables: { input: { text: text.trim(), category, isCore, options: optInput } } })
    } else if (selectedId) {
      void updateQuestion({ variables: { id: selectedId, input: { text: text.trim(), category, isCore, isActive, options: optInput } } })
    }
  }

  const handleDelete = () => {
    if (!selectedId) return
    if (!window.confirm('Eliminare questa domanda? Non sarà possibile se esistono risposte associate.')) return
    void deleteQuestion({ variables: { id: selectedId } })
  }

  const handleToggleCore = (newCore: boolean) => {
    if (!selectedId) { setIsCore(newCore); return }
    setIsCore(newCore)
    void setCore({ variables: { questionId: selectedId, isCore: newCore } })
  }

  const updateOption = (idx: number, patch: Partial<AnswerOption>) => {
    setOptions(p => p.map((o, i) => i === idx ? { ...o, ...patch } : o))
  }
  const addOption = () => setOptions(p => [...p, { label: '', score: 0, sortOrder: p.length }])
  const removeOption = (idx: number) => setOptions(p => p.filter((_, i) => i !== idx))
  const moveOption = (idx: number, dir: -1 | 1) => {
    setOptions(p => {
      const arr = [...p]
      const j = idx + dir
      if (j < 0 || j >= arr.length) return p
      const a = arr[idx]!; const b = arr[j]!
      arr[idx] = b; arr[j] = a
      return arr.map((o, i) => ({ ...o, sortOrder: i }))
    })
  }

  return (
    <PageContainer>
      <PageTitle icon={<HelpCircle size={22} color="var(--color-brand)" />}>
        Assessment Questions
      </PageTitle>
      <p style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate)', margin: '4px 0 20px' }}>
        Gestisci le domande usate nell'assessment dei change RFC e la loro assegnazione ai tipi di CI.
      </p>

      <div style={{ display: 'grid', gridTemplateColumns: '340px 1fr', gap: 20, alignItems: 'start' }}>

        {/* Left: question list */}
        <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, padding: 16 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <h3 style={{ margin: 0, fontSize: 'var(--font-size-card-title)', color: 'var(--color-slate-dark)' }}>
              Domande ({questions.length}{filterCat && questions.length !== allQuestions.length ? ` / ${allQuestions.length}` : ''})
            </h3>
            <button
              type="button"
              onClick={handleNew}
              style={{
                padding: '6px 12px', borderRadius: 6, border: 'none',
                background: 'var(--color-brand)', color: '#fff',
                fontSize: 'var(--font-size-body)', fontWeight: 600, cursor: 'pointer',
                display: 'flex', alignItems: 'center', gap: 4,
              }}
            >
              <Plus size={14} /> Nuova
            </button>
          </div>

          <select
            value={filterCat}
            onChange={e => setFilterCat(e.target.value)}
            style={{ ...inputStyle, marginBottom: 12 }}
          >
            <option value="">Tutte le categorie</option>
            <option value="functional">Functional</option>
            <option value="technical">Technical</option>
          </select>

          <div style={{ maxHeight: 600, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 6 }}>
            {questions.map(q => {
              const active = q.id === selectedId
              return (
                <div
                  key={q.id}
                  onClick={() => setSelectedId(q.id)}
                  style={{
                    padding: '10px 12px',
                    borderRadius: 8,
                    border: active ? '1.5px solid var(--color-brand)' : '1px solid #e5e7eb',
                    cursor: 'pointer',
                    background: active ? 'var(--color-brand-light)' : '#fff',
                  }}
                >
                  <div style={{ fontSize: 'var(--font-size-body)', fontWeight: 500, color: 'var(--color-slate-dark)', marginBottom: 6, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                    {q.text}
                  </div>
                  <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                    <CategoryBadge category={q.category} />
                    {q.isCore && (
                      <span style={{ fontSize: 'var(--font-size-label)', fontWeight: 600, padding: '2px 6px', borderRadius: 4, background: '#f1f5f9', color: 'var(--color-slate)' }}>CORE</span>
                    )}
                    {!q.isActive && (
                      <span style={{ fontSize: 'var(--font-size-label)', fontWeight: 600, padding: '2px 6px', borderRadius: 4, background: '#fee2e2', color: '#b91c1c' }}>INATTIVA</span>
                    )}
                  </div>
                </div>
              )
            })}
            {questions.length === 0 && (
              <p style={{ color: 'var(--color-slate-light)', fontSize: 'var(--font-size-body)' }}>Nessuna domanda</p>
            )}
          </div>
        </div>

        {/* Right: editor panel */}
        <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, padding: 20 }}>
          {!selectedId && !isNew && (
            <div style={{ padding: 40, textAlign: 'center', color: 'var(--color-slate-light)' }}>
              Seleziona una domanda o creane una nuova
            </div>
          )}
          {(selectedId || isNew) && (
            <>
              <div style={{ marginBottom: 16 }}>
                <label style={labelStyle}>Testo</label>
                <textarea
                  value={text}
                  onChange={e => setText(e.target.value)}
                  rows={3}
                  style={{ ...inputStyle, resize: 'vertical' }}
                />
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 16 }}>
                <div>
                  <label style={labelStyle}>Categoria</label>
                  <select value={category} onChange={e => setCategory(e.target.value as 'functional' | 'technical')} style={inputStyle}>
                    <option value="functional">Functional</option>
                    <option value="technical">Technical</option>
                  </select>
                </div>
                <div>
                  <label style={labelStyle}>Flags</label>
                  <div style={{ display: 'flex', gap: 16, paddingTop: 8 }}>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 'var(--font-size-body)', color: 'var(--color-slate)' }}>
                      <input type="checkbox" checked={isCore} onChange={e => handleToggleCore(e.target.checked)} />
                      Core
                    </label>
                    {!isNew && (
                      <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 'var(--font-size-body)', color: 'var(--color-slate)' }}>
                        <input type="checkbox" checked={isActive} onChange={e => setIsActive(e.target.checked)} />
                        Attiva
                      </label>
                    )}
                  </div>
                </div>
              </div>

              {/* CIType assignments — visibile direttamente quando Core è OFF */}
              {!isCore && (
                <div style={{ marginBottom: 16 }}>
                  <label style={labelStyle}>Assegnazioni CI Type</label>
                  {isNew ? (
                    <p style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate-light)', margin: 0, padding: '8px 0' }}>
                      Salva la domanda per poterla assegnare a CI Type specifici.
                    </p>
                  ) : (
                    ciTypes.map(ct => {
                      const assign = assignments.find(a => a.ciTypeId === ct.id)
                      const assigned = !!assign
                      return (
                        <div key={ct.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', borderBottom: '1px solid #f3f4f6' }}>
                          <input
                            type="checkbox"
                            checked={assigned}
                            onChange={e => {
                              if (e.target.checked) {
                                void assignToCIType({ variables: { questionId: selectedId, ciTypeId: ct.id, weight: 1, sortOrder: 0 } })
                              } else {
                                void removeFromCIType({ variables: { questionId: selectedId, ciTypeId: ct.id } })
                              }
                            }}
                          />
                          <span style={{ flex: 1, fontSize: 'var(--font-size-body)', color: 'var(--color-slate-dark)' }}>{ct.label}</span>
                          {assigned && (
                            <>
                              <input
                                type="number"
                                value={assign.weight}
                                onChange={e => {
                                  const w = parseInt(e.target.value, 10) || 1
                                  void assignToCIType({ variables: { questionId: selectedId, ciTypeId: ct.id, weight: w, sortOrder: assign.sortOrder } })
                                }}
                                style={{ ...inputStyle, width: 80 }}
                                title="Weight"
                              />
                              <input
                                type="number"
                                value={assign.sortOrder}
                                onChange={e => {
                                  const s = parseInt(e.target.value, 10) || 0
                                  void assignToCIType({ variables: { questionId: selectedId, ciTypeId: ct.id, weight: assign.weight, sortOrder: s } })
                                }}
                                style={{ ...inputStyle, width: 80 }}
                                title="Sort order"
                              />
                            </>
                          )}
                        </div>
                      )
                    })
                  )}
                </div>
              )}

              {isCore && !isNew && (
                <div style={{ marginBottom: 16, padding: 10, background: '#f1f5f9', borderRadius: 6, fontSize: 'var(--font-size-body)', color: 'var(--color-slate)' }}>
                  Questa domanda è <strong>core</strong>: assegnata automaticamente a tutti i CI Type attivi.
                </div>
              )}

              <div style={{ marginBottom: 16 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                  <label style={{ ...labelStyle, marginBottom: 0 }}>Opzioni</label>
                  <button type="button" onClick={addOption} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-brand)', fontSize: 'var(--font-size-body)', fontWeight: 600, display: 'flex', alignItems: 'center', gap: 4 }}>
                    <Plus size={12} /> Aggiungi
                  </button>
                </div>
                {options.map((opt, i) => (
                  <div key={i} style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 6 }}>
                    <input
                      type="text"
                      value={opt.label}
                      onChange={e => updateOption(i, { label: e.target.value })}
                      placeholder="Label"
                      style={{ ...inputStyle, flex: 2 }}
                    />
                    <input
                      type="number"
                      value={opt.score}
                      onChange={e => updateOption(i, { score: parseInt(e.target.value, 10) || 0 })}
                      placeholder="Score"
                      style={{ ...inputStyle, width: 90 }}
                    />
                    <button type="button" onClick={() => moveOption(i, -1)} disabled={i === 0} style={{ background: 'none', border: '1px solid #e5e7eb', cursor: i === 0 ? 'not-allowed' : 'pointer', padding: 6, borderRadius: 4 }}>
                      <ChevronUp size={12} />
                    </button>
                    <button type="button" onClick={() => moveOption(i, 1)} disabled={i === options.length - 1} style={{ background: 'none', border: '1px solid #e5e7eb', cursor: i === options.length - 1 ? 'not-allowed' : 'pointer', padding: 6, borderRadius: 4 }}>
                      <ChevronDown size={12} />
                    </button>
                    <button type="button" onClick={() => removeOption(i)} style={{ background: 'none', border: '1px solid #fecaca', color: 'var(--color-danger)', cursor: 'pointer', padding: 6, borderRadius: 4 }}>
                      <X size={12} />
                    </button>
                  </div>
                ))}
              </div>

              {/* Actions */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderTop: '1px solid #f3f4f6', paddingTop: 16 }}>
                {!isNew && selectedId && (
                  <button
                    type="button"
                    onClick={handleDelete}
                    style={{ padding: '8px 16px', borderRadius: 8, border: '1.5px solid var(--color-danger)', background: '#fff', color: 'var(--color-danger)', fontWeight: 600, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4 }}
                  >
                    <Trash2 size={14} /> Elimina
                  </button>
                )}
                <div style={{ marginLeft: 'auto' }}>
                  <button
                    type="button"
                    onClick={handleSave}
                    style={{ padding: '8px 24px', borderRadius: 8, border: 'none', background: 'var(--color-brand)', color: '#fff', fontWeight: 600, cursor: 'pointer' }}
                  >
                    Salva
                  </button>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </PageContainer>
  )
}
