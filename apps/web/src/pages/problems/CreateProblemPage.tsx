import { useEffect, useId, useState } from 'react'
import { derivePriority, priorityCode } from '@/lib/priority'
import { usePriorityMatrix } from '@/hooks/usePriorityMatrix'
import { useNavigate } from 'react-router-dom'
import { PageContainer } from '@/components/PageContainer'
import { useMutation, useQuery } from '@apollo/client/react'
import { useTranslation } from 'react-i18next'
import { X, Users } from 'lucide-react'
import { toast } from 'sonner'
import { GET_PROBLEMS, GET_ALL_CIS, GET_TEAMS, GET_ITIL_CI_RELATION_RULES } from '@/graphql/queries'
import { CREATE_PROBLEM, ASSIGN_PROBLEM_TO_TEAM } from '@/graphql/mutations'
import { colors, palette, alpha } from '@/lib/tokens'

interface CIRef { id: string; name: string; type: string; environment?: string }
interface Team  { id: string; name: string }

const fieldLabel: React.CSSProperties = {
  display: 'block', fontSize: 'var(--font-size-body)', fontWeight: 600, color: 'var(--color-slate-light)',
  textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 6,
}

const inputBase: React.CSSProperties = {
  width: '100%', padding: '10px 14px',
  border: `1.5px solid ${colors.border}`, borderRadius: 8,
  fontSize: 'var(--font-size-body)', color: 'var(--color-slate-dark)', outline: 'none',
  backgroundColor: colors.white, boxSizing: 'border-box',
  fontFamily: "'Plus Jakarta Sans', system-ui, sans-serif", transition: 'border-color 150ms',
}

const PRIORITY_STYLES: Record<string, { bg: string; border: string; color: string }> = {
  critical: { bg: 'var(--color-danger-bg)', border: 'var(--color-danger)', color: 'var(--color-trigger-sla-breach)' },
  high:     { bg: colors.severity.high.bg, border: 'var(--color-brand)', color: 'var(--color-brand)' },
  medium:   { bg: 'var(--color-warning-bg)', border: 'var(--color-warning)', color: palette.warning.text },
  low:      { bg: 'var(--color-success-bg)', border: 'var(--color-success)', color: palette.success.text },
}

export function CreateProblemPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const ids = { title: useId(), description: useId(), ciSearch: useId(), teamSearch: useId() }

  const [title,       setTitle]       = useState('')
  // Dalla matrice DEL CLIENTE, non da una copia nel web (revisione · C·N-3).
  const { matrix } = usePriorityMatrix()
  const [impact,      setImpact]      = useState('')
  const [urgency,     setUrgency]     = useState('')
  useEffect(() => {
    if (!matrix) return
    setImpact((v) => (v === '' ? (matrix.impacts[Math.floor((matrix.impacts.length - 1) / 2)] ?? '') : v))
    setUrgency((v) => (v === '' ? (matrix.urgencies[Math.floor((matrix.urgencies.length - 1) / 2)] ?? '') : v))
  }, [matrix])
  const priority = derivePriority(matrix, impact, urgency) ?? ''
  const [description, setDescription] = useState('')
  const [selectedTeam,     setSelectedTeam]     = useState<Team | null>(null)
  const [teamSearch,       setTeamSearch]       = useState('')
  const [teamDropdownOpen, setTeamDropdownOpen] = useState(false)
  const [ciSearch,    setCiSearch]    = useState('')
  const [selectedCIs, setSelectedCIs] = useState<CIRef[]>([])

  const { data: ciRulesData } = useQuery<{ itilCIRelationRules: { ciType: string }[] }>(
    GET_ITIL_CI_RELATION_RULES,
    { variables: { itilType: 'problem' }, fetchPolicy: 'network-only' },
  )

  const ciTypesFilter = ciRulesData?.itilCIRelationRules?.length
    ? [...new Set(ciRulesData.itilCIRelationRules.map(r => r.ciType.toLowerCase()))]
    : undefined

  const { data: ciData } = useQuery<{ allCIs: { items: CIRef[] } }>(GET_ALL_CIS, {
    variables: { search: ciSearch, limit: 20, ciTypes: ciTypesFilter },
    skip: ciSearch.length < 2 || ciRulesData === undefined,
    fetchPolicy: 'network-only',
  })
  const { data: teamsData } = useQuery<{ teams: Team[] }>(GET_TEAMS)

  const ciResults     = (ciData?.allCIs?.items ?? [])
    .filter(ci => !selectedCIs.find(s => s.id === ci.id))
    .filter(ci => !ciTypesFilter || ciTypesFilter.includes(ci.type.toLowerCase()))
  const teams         = teamsData?.teams ?? []
  const filteredTeams = teams.filter(t => t.name.toLowerCase().includes(teamSearch.toLowerCase()))
  const canSubmit     = title.trim().length > 0 && description.trim().length > 0

  const [assignToTeam] = useMutation(ASSIGN_PROBLEM_TO_TEAM, {
    onError: (err) => toast.error(t('toast.problem.teamAssignmentFailed', { error: err.message })),
  })

  const [createProblem, { loading }] = useMutation<{ createProblem: { id: string } }>(CREATE_PROBLEM, {
    refetchQueries: [{ query: GET_PROBLEMS }],
    onCompleted: async (data) => {
      if (selectedTeam) {
        await assignToTeam({ variables: { problemId: data.createProblem.id, teamId: selectedTeam.id } })
      }
      toast.success(t('toast.problem.created'))
      navigate('/problems', { state: { refresh: true } })
    },
    onError: (err) => toast.error(err.message),
  })

  const handleSubmit = () => {
    if (!canSubmit || loading) return
    void createProblem({
      variables: {
        input: {
          title:           title.trim(),
          impact,
          urgency,
          description:     description.trim() || undefined,
          affectedCIs:     selectedCIs.map(ci => ci.id),
        },
      },
    })
  }

  return (
    <PageContainer style={{ minHeight: '100%', backgroundColor: 'var(--color-slate-bg)', paddingBottom: '64px' }}>
      <div style={{ maxWidth: 580, margin: '0 auto' }}>

        {/* Header */}
        <button
          type="button"
          onClick={() => navigate('/problems')}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 5, background: 'none', border: 'none', cursor: 'pointer', fontSize: 'var(--font-size-body)', color: 'var(--color-slate-light)', marginBottom: 16, padding: 0 }}
          onMouseEnter={e => { (e.currentTarget as HTMLElement).style.color = 'var(--color-brand)' }}
          onMouseLeave={e => { (e.currentTarget as HTMLElement).style.color = 'var(--color-slate-light)' }}
        >
          ← Problems
        </button>

        <h1 style={{ fontSize: 'var(--font-size-page-title)', fontWeight: 600, color: 'var(--color-slate-dark)', margin: '0 0 4px', letterSpacing: '-0.02em' }}>
          Nuovo Problem
        </h1>
        <p style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate)', margin: '0 0 24px' }}>
          Compila i dettagli del problem da aprire
        </p>

        {/* Card */}
        <div style={{ background: colors.white, border: `1px solid ${colors.border}`, borderRadius: 12, padding: '28px 32px', boxShadow: `0 1px 4px ${alpha.black06}` }}>

          {/* TITOLO */}
          <div style={{ marginBottom: 20 }}>
            <label htmlFor={ids.title} style={fieldLabel}>
              Titolo <span style={{ color: 'var(--color-trigger-sla-breach)' }}>*</span>
            </label>
            <input
              id={ids.title}
              type="text"
              value={title}
              onChange={e => setTitle(e.target.value)}
              placeholder="Es. Memory leak nel servizio di autenticazione"
              style={inputBase}
              onFocus={e => { (e.currentTarget as HTMLElement).style.borderColor = 'var(--color-brand)' }}
              onBlur={e  => { (e.currentTarget as HTMLElement).style.borderColor = colors.border }}
            />
          </div>

          {/* IMPATTO × URGENZA → PRIORITÀ */}
          <div style={{ marginBottom: 20, display: 'flex', gap: 24, flexWrap: 'wrap', alignItems: 'flex-start' }}>
            {([['Impatto', impact, setImpact, matrix?.impacts ?? []], ['Urgenza', urgency, setUrgency, matrix?.urgencies ?? []]] as const).map(([label, val, setVal, options]) => (
              <div key={label}>
                <div style={fieldLabel}>{label} <span style={{ color: 'var(--color-trigger-sla-breach)' }}>*</span></div>
                <div style={{ display: 'flex', gap: 6 }}>
                  {options.map(o => {
                    const sel = val === o
                    return (
                      <button key={o} type="button" onClick={() => setVal(o)}
                        style={{ padding: '7px 14px', borderRadius: 6, fontSize: 'var(--font-size-body)', cursor: 'pointer',
                          border: `1.5px solid ${sel ? 'var(--color-brand)' : colors.border}`,
                          background: sel ? palette.info.light : 'var(--color-slate-bg)',
                          color: sel ? 'var(--color-brand)' : 'var(--color-slate)', fontWeight: sel ? 600 : 400 }}>
                        {o}
                      </button>
                    )
                  })}
                </div>
              </div>
            ))}
            <div>
              <div style={fieldLabel}>Priorità (calcolata)</div>
              <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8, padding: '7px 14px', borderRadius: 6,
                border: `1.5px solid ${(PRIORITY_STYLES[priority]?.border ?? colors.border)}`,
                background: PRIORITY_STYLES[priority]?.bg ?? 'var(--color-slate-bg)',
                color: PRIORITY_STYLES[priority]?.color ?? 'var(--color-slate)', fontWeight: 600 }}>
                <span>{priority === '' ? '—' : priorityCode(matrix?.priorities ?? [], priority)}</span>
                <span style={{ textTransform: 'capitalize' }}>{priority === '' ? 'da compilare nella matrice' : priority}</span>
              </div>
            </div>
          </div>

          {/* DESCRIZIONE */}
          <div style={{ marginBottom: 20 }}>
            <label htmlFor={ids.description} style={fieldLabel}>
              Descrizione <span style={{ color: 'var(--color-trigger-sla-breach)' }}>*</span>
            </label>
            <textarea
              id={ids.description}
              value={description}
              onChange={e => setDescription(e.target.value)}
              placeholder="Descrivi il problema e il suo impatto..."
              rows={3}
              style={{ ...inputBase, resize: 'vertical', lineHeight: 1.6 }}
              onFocus={e => { (e.currentTarget as HTMLElement).style.borderColor = 'var(--color-brand)' }}
              onBlur={e  => { (e.currentTarget as HTMLElement).style.borderColor = colors.border }}
            />
          </div>

          {/* CI IMPATTATI */}
          <div style={{ marginBottom: 20 }}>
            <label htmlFor={ids.ciSearch} style={fieldLabel}>
              CI Impattati{' '}
              <span style={{ fontSize: 'var(--font-size-body)', fontWeight: 400, textTransform: 'none', letterSpacing: 0, color: 'var(--color-slate-light)' }}>(opzionale)</span>
            </label>

            <div style={{ position: 'relative' }}>
              <span style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', fontSize: 'var(--font-size-card-title)', pointerEvents: 'none', color: 'var(--color-slate-light)' }}>
                🔍
              </span>
              <input
                id={ids.ciSearch}
                type="text"
                value={ciSearch}
                onChange={e => setCiSearch(e.target.value)}
                placeholder="Cerca per nome..."
                style={{ ...inputBase, paddingLeft: 36 }}
                onFocus={e => { (e.currentTarget as HTMLElement).style.borderColor = 'var(--color-brand)' }}
                onBlur={e  => { (e.currentTarget as HTMLElement).style.borderColor = colors.border }}
              />

              {ciResults.length > 0 && ciSearch.length >= 2 && (
                <div style={{ position: 'absolute', left: 0, right: 0, top: '100%', marginTop: 4, background: colors.white, border: `1px solid ${colors.border}`, borderRadius: 8, boxShadow: `0 4px 12px ${alpha.black10}`, maxHeight: 200, overflowY: 'auto', zIndex: 20 }}>
                  {ciResults.map(ci => (
                    <button
                      type="button"
                      key={ci.id}
                      onClick={() => { setSelectedCIs(p => [...p, ci]); setCiSearch('') }}
                      className="hover-bg"
                      style={{ width: '100%', background: 'none', border: 'none', borderRadius: 0, font: 'inherit', color: 'inherit', textAlign: 'left', padding: '8px 12px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8, borderBottom: `1px solid ${palette.neutral.borderLight}` }}
                    >
                      <span style={{ fontSize: 'var(--font-size-card-title)', fontWeight: 500, color: 'var(--color-slate-dark)', flex: 1 }}>{ci.name}</span>
                      <span style={{ fontSize: 'var(--font-size-body)', padding: '1px 6px', borderRadius: 4, backgroundColor: 'var(--color-border-light)', color: 'var(--color-slate)' }}>
                        {ci.type}{ci.environment ? ` · ${ci.environment}` : ''}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>

            {selectedCIs.length > 0 && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
                {selectedCIs.map(ci => (
                  <span key={ci.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '3px 8px 3px 10px', borderRadius: 6, background: 'var(--color-brand-light)', border: `1px solid ${palette.info.border}`, color: 'var(--color-brand-hover)', fontSize: 'var(--font-size-body)' }}>
                    {ci.name}
                    <button
                      type="button"
                      onClick={() => setSelectedCIs(p => p.filter(c => c.id !== ci.id))}
                      style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-brand-hover)', padding: 0, lineHeight: 1, display: 'flex', alignItems: 'center', opacity: 0.7 }}
                    >
                      <X size={12} />
                    </button>
                  </span>
                ))}
              </div>
            )}
          </div>

          {/* TEAM */}
          <div style={{ marginBottom: 20 }}>
            <label htmlFor={ids.teamSearch} style={fieldLabel}>
              Team{' '}
              <span style={{ fontSize: 'var(--font-size-body)', fontWeight: 400, textTransform: 'none', letterSpacing: 0, color: 'var(--color-slate-light)' }}>(opzionale)</span>
            </label>

            {selectedTeam && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '3px 8px 3px 10px', borderRadius: 6, background: 'var(--color-success-bg)', border: `1px solid ${palette.success.border}`, color: palette.success.text, fontSize: 'var(--font-size-body)' }}>
                  {selectedTeam.name}
                  <button
                    type="button"
                    onClick={() => { setSelectedTeam(null); setTeamSearch('') }}
                    style={{ background: 'none', border: 'none', cursor: 'pointer', color: palette.success.text, padding: 0, lineHeight: 1, display: 'flex', alignItems: 'center', opacity: 0.7 }}
                  >
                    <X size={12} />
                  </button>
                </span>
              </div>
            )}

            {!selectedTeam && (
              <div style={{ position: 'relative' }}>
                <span style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', fontSize: 'var(--font-size-card-title)', pointerEvents: 'none', color: 'var(--color-slate-light)' }}>
                  🔍
                </span>
                <input
                  id={ids.teamSearch}
                  type="text"
                  value={teamSearch}
                  onChange={e => { setTeamSearch(e.target.value); setTeamDropdownOpen(true) }}
                  onFocus={() => setTeamDropdownOpen(true)}
                  onBlur={() => setTimeout(() => setTeamDropdownOpen(false), 150)}
                  placeholder="Cerca team per nome..."
                  style={{ ...inputBase, paddingLeft: 36 }}
                  onFocusCapture={e => { (e.currentTarget as HTMLElement).style.borderColor = 'var(--color-brand)' }}
                  onBlurCapture={e  => { (e.currentTarget as HTMLElement).style.borderColor = colors.border }}
                />

                {teamDropdownOpen && filteredTeams.length > 0 && (
                  <div style={{ position: 'absolute', left: 0, right: 0, top: '100%', marginTop: 4, background: colors.white, border: `1px solid ${colors.border}`, borderRadius: 8, boxShadow: `0 4px 12px ${alpha.black10}`, maxHeight: 200, overflowY: 'auto', zIndex: 20 }}>
                    {filteredTeams.map(tm => (
                      <button
                        type="button"
                        key={tm.id}
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => { setSelectedTeam(tm); setTeamSearch(''); setTeamDropdownOpen(false) }}
                        className="hover-bg"
                        style={{ width: '100%', background: 'none', border: 'none', borderRadius: 0, font: 'inherit', color: 'inherit', textAlign: 'left', padding: '8px 12px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8, borderBottom: `1px solid ${palette.neutral.borderLight}` }}
                      >
                        <Users size={14} color="var(--color-slate-light)" />
                        <span style={{ fontSize: 'var(--font-size-card-title)', fontWeight: 500, color: 'var(--color-slate-dark)' }}>{tm.name}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Footer */}
          <div style={{ borderTop: `1px solid ${palette.neutral.borderLight}`, marginTop: 8, paddingTop: 20, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <button
              type="button"
              onClick={() => navigate('/problems')}
              style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 'var(--font-size-body)', color: 'var(--color-slate)', padding: 0 }}
            >
              Annulla
            </button>
            <button
              type="button"
              onClick={handleSubmit}
              disabled={!canSubmit || loading}
              style={{
                background: 'var(--color-brand)', color: colors.white, border: 'none', borderRadius: 8,
                padding: '10px 24px', fontSize: 'var(--font-size-card-title)', fontWeight: 600,
                cursor: canSubmit && !loading ? 'pointer' : 'not-allowed',
                opacity: canSubmit && !loading ? 1 : 0.5,
                transition: 'opacity 150ms',
              }}
            >
              {loading ? 'Creazione…' : 'Crea Problem'}
            </button>
          </div>

        </div>
      </div>
    </PageContainer>
  )
}
