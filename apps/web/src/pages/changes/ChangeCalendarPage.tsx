import { useState, useMemo, useCallback } from 'react'
import { useQuery, useLazyQuery } from '@apollo/client/react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import {
  CalendarDays, ChevronLeft, ChevronRight,
  AlertTriangle, X, Search,
} from 'lucide-react'
import { PageContainer } from '@/components/PageContainer'
import { PageTitle } from '@/components/PageTitle'
import { GET_ALL_CIS, CHANGE_CALENDAR_EVENTS, CHANGE_CALENDAR_CONFLICTS, CHANGE_CALENDAR_SUGGESTED_SLOTS } from '@/graphql/queries'
import { colors } from '@/lib/tokens'

// ── Types ──────────────────────────────────────────────────────────────────────

interface CalendarEvent {
  id: string
  title: string
  changeType: string
  status: string
  riskLevel: string
  scheduledStart: string
  scheduledEnd: string
  duration: number
  ciNames: string[]
  teamName: string
  requiresDowntime: boolean
  color: string
}

interface Conflict {
  changeA: { id: string; title: string; changeType: string; scheduledStart: string; scheduledEnd: string }
  changeB: { id: string; title: string; changeType: string; scheduledStart: string; scheduledEnd: string }
  sharedCIs: string[]
  overlapStart: string
  overlapEnd: string
}

interface SuggestedSlot {
  start: string
  end: string
  score: number
  reason: string
}

type ViewMode = 'month' | 'week' | 'day'

// ── Helpers ────────────────────────────────────────────────────────────────────

// Day/month names moved into component for i18n access

function typeColor(changeType: string): string {
  switch (changeType?.toLowerCase()) {
    case 'standard':  return '#16a34a'
    case 'normal':    return '#0284c7'
    case 'emergency': return '#ef4444'
    default:          return '#64748b'
  }
}

function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1)
}

function endOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth() + 1, 0, 23, 59, 59)
}

function startOfWeek(d: Date): Date {
  const day = d.getDay()
  const diff = (day === 0 ? -6 : 1) - day
  const r = new Date(d)
  r.setDate(r.getDate() + diff)
  r.setHours(0, 0, 0, 0)
  return r
}

function endOfWeek(d: Date): Date {
  const s = startOfWeek(d)
  const r = new Date(s)
  r.setDate(r.getDate() + 6)
  r.setHours(23, 59, 59, 999)
  return r
}

function isSameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
}

function isToday(d: Date): boolean {
  return isSameDay(d, new Date())
}

function formatISO(d: Date): string {
  return d.toISOString()
}

function pad(n: number): string {
  return n.toString().padStart(2, '0')
}

// ── Styles ─────────────────────────────────────────────────────────────────────

const btnStyle: React.CSSProperties = {
  padding: '6px 14px', borderRadius: 6, border: '1px solid #e2e8f0', background: '#fff',
  cursor: 'pointer', fontSize: 13, fontWeight: 500, color: '#0f172a', transition: 'all 0.15s',
}

const activeBtnStyle: React.CSSProperties = {
  ...btnStyle, background: '#0284c7', color: '#fff', borderColor: '#0284c7',
}

const cellBaseStyle: React.CSSProperties = {
  minHeight: 100, padding: 4, border: '1px solid #e2e8f0', overflow: 'hidden', cursor: 'pointer',
}

// ── Page ───────────────────────────────────────────────────────────────────────

export function ChangeCalendarPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()

  const DAYS = useMemo(() => [
    t('pages.changeCalendar.dayMon'), t('pages.changeCalendar.dayTue'),
    t('pages.changeCalendar.dayWed'), t('pages.changeCalendar.dayThu'),
    t('pages.changeCalendar.dayFri'), t('pages.changeCalendar.daySat'),
    t('pages.changeCalendar.daySun'),
  ], [t])
  const MONTHS = useMemo(() => [
    t('pages.changeCalendar.monthJan'), t('pages.changeCalendar.monthFeb'),
    t('pages.changeCalendar.monthMar'), t('pages.changeCalendar.monthApr'),
    t('pages.changeCalendar.monthMay'), t('pages.changeCalendar.monthJun'),
    t('pages.changeCalendar.monthJul'), t('pages.changeCalendar.monthAug'),
    t('pages.changeCalendar.monthSep'), t('pages.changeCalendar.monthOct'),
    t('pages.changeCalendar.monthNov'), t('pages.changeCalendar.monthDec'),
  ], [t])

  const [currentDate, setCurrentDate] = useState(new Date())
  const [view, setView] = useState<ViewMode>('month')
  const [showSlotFinder, setShowSlotFinder] = useState(false)

  // Slot finder state
  const [slotDuration, setSlotDuration] = useState(4)
  const [slotCISearch, setSlotCISearch] = useState('')
  const [slotCIIds, setSlotCIIds] = useState<string[]>([])
  const [slotFrom, setSlotFrom] = useState('')
  const [slotTo, setSlotTo] = useState('')

  // Compute query range
  const queryRange = useMemo(() => {
    if (view === 'month') return { from: formatISO(startOfMonth(currentDate)), to: formatISO(endOfMonth(currentDate)) }
    if (view === 'week') return { from: formatISO(startOfWeek(currentDate)), to: formatISO(endOfWeek(currentDate)) }
    const dayStart = new Date(currentDate)
    dayStart.setHours(0, 0, 0, 0)
    const dayEnd = new Date(currentDate)
    dayEnd.setHours(23, 59, 59, 999)
    return { from: formatISO(dayStart), to: formatISO(dayEnd) }
  }, [currentDate, view])

  // Queries
  const { data: eventsData } = useQuery<{ changeCalendarEvents: CalendarEvent[] }>(CHANGE_CALENDAR_EVENTS, {
    variables: queryRange,
  })

  const { data: conflictsData } = useQuery<{ changeCalendarConflicts: Conflict[] }>(CHANGE_CALENDAR_CONFLICTS, {
    variables: queryRange,
  })

  const [searchSlots, { data: slotsData, loading: slotsLoading }] = useLazyQuery<{
    changeCalendarSuggestedSlots: SuggestedSlot[]
  }>(CHANGE_CALENDAR_SUGGESTED_SLOTS)

  const { data: slotCIData } = useQuery<{ allCIs: { items: { id: string; name: string; type: string }[] } }>(GET_ALL_CIS, {
    variables: { search: slotCISearch, limit: 10 },
    skip: slotCISearch.length < 2,
  })

  const events = eventsData?.changeCalendarEvents ?? []
  const conflicts = conflictsData?.changeCalendarConflicts ?? []
  const slots = slotsData?.changeCalendarSuggestedSlots ?? []

  // Navigation
  const goToday = useCallback(() => setCurrentDate(new Date()), [])

  const goPrev = useCallback(() => {
    const d = new Date(currentDate)
    if (view === 'month') d.setMonth(d.getMonth() - 1)
    else if (view === 'week') d.setDate(d.getDate() - 7)
    else d.setDate(d.getDate() - 1)
    setCurrentDate(d)
  }, [currentDate, view])

  const goNext = useCallback(() => {
    const d = new Date(currentDate)
    if (view === 'month') d.setMonth(d.getMonth() + 1)
    else if (view === 'week') d.setDate(d.getDate() + 7)
    else d.setDate(d.getDate() + 1)
    setCurrentDate(d)
  }, [currentDate, view])

  // Period label
  const periodLabel = useMemo(() => {
    if (view === 'month') return `${MONTHS[currentDate.getMonth()]} ${currentDate.getFullYear()}`
    if (view === 'week') {
      const s = startOfWeek(currentDate)
      const e = endOfWeek(currentDate)
      return `${s.getDate()}-${e.getDate()} ${MONTHS[s.getMonth()].slice(0, 3)} ${s.getFullYear()}`
    }
    return `${currentDate.getDate()} ${MONTHS[currentDate.getMonth()]} ${currentDate.getFullYear()}`
  }, [currentDate, view, MONTHS])

  // Events for a given day
  const eventsForDay = useCallback((day: Date): CalendarEvent[] => {
    return events.filter(ev => {
      const start = new Date(ev.scheduledStart)
      const end = new Date(ev.scheduledEnd)
      return start <= new Date(day.getFullYear(), day.getMonth(), day.getDate(), 23, 59, 59) &&
             end >= new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, 0, 0)
    })
  }, [events])

  // ── Month View Grid ──────────────────────────────────────────
  const monthGrid = useMemo(() => {
    const first = startOfMonth(currentDate)
    const last = endOfMonth(currentDate)
    const startDay = first.getDay() === 0 ? 6 : first.getDay() - 1

    const cells: { date: Date; inMonth: boolean }[] = []
    for (let i = 0; i < startDay; i++) {
      const d = new Date(first)
      d.setDate(d.getDate() - (startDay - i))
      cells.push({ date: d, inMonth: false })
    }
    for (let d = 1; d <= last.getDate(); d++) {
      cells.push({ date: new Date(currentDate.getFullYear(), currentDate.getMonth(), d), inMonth: true })
    }
    const remainder = 7 - (cells.length % 7)
    if (remainder < 7) {
      for (let i = 1; i <= remainder; i++) {
        const d = new Date(last)
        d.setDate(d.getDate() + i)
        cells.push({ date: d, inMonth: false })
      }
    }
    return cells
  }, [currentDate])

  // ── Week days ────────────────────────────────────────────────
  const weekDays = useMemo(() => {
    const s = startOfWeek(currentDate)
    return Array.from({ length: 7 }, (_, i) => {
      const d = new Date(s)
      d.setDate(d.getDate() + i)
      return d
    })
  }, [currentDate])

  // ── Slot finder handlers ─────────────────────────────────────
  const handleSearchSlots = useCallback(() => {
    if (!slotFrom || !slotTo) return
    searchSlots({
      variables: {
        duration: slotDuration,
        ciIds: slotCIIds.length > 0 ? slotCIIds : null,
        from: new Date(slotFrom).toISOString(),
        to: new Date(slotTo).toISOString(),
      },
    })
  }, [slotDuration, slotCIIds, slotFrom, slotTo, searchSlots])

  const scoreColor = (score: number): string => {
    if (score >= 80) return '#16a34a'
    if (score >= 50) return '#eab308'
    return '#f97316'
  }

  // ── Render ───────────────────────────────────────────────────

  const renderEventPill = (ev: CalendarEvent) => (
    <div
      key={ev.id}
      style={{
        padding: '2px 6px', borderRadius: 4, fontSize: 10, fontWeight: 500,
        borderLeft: `3px solid ${typeColor(ev.changeType)}`,
        background: `${typeColor(ev.changeType)}10`,
        color: '#0f172a', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        marginBottom: 2, cursor: 'pointer',
      }}
      title={ev.title}
      onClick={e => { e.stopPropagation(); navigate(`/changes/${ev.id}`) }}
    >
      {ev.title}
    </div>
  )

  return (
    <PageContainer>
      <PageTitle icon={<CalendarDays size={22} color={colors.brand} />}>
        {t('pages.changeCalendar.title')}
      </PageTitle>
      <p style={{ color: colors.slate, margin: '4px 0 20px', fontSize: 14 }}>
        {t('pages.changeCalendar.subtitle')}
      </p>

      {/* ── Header Controls ─────────────────────────────────── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
        {/* View toggle */}
        <div style={{ display: 'flex', gap: 0 }}>
          {(['month', 'week', 'day'] as const).map(v => (
            <button
              key={v}
              onClick={() => setView(v)}
              style={{
                ...(view === v ? activeBtnStyle : btnStyle),
                borderRadius: v === 'month' ? '6px 0 0 6px' : v === 'day' ? '0 6px 6px 0' : 0,
              }}
            >
              {t(`pages.changeCalendar.${v}`)}
            </button>
          ))}
        </div>

        {/* Navigation */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <button onClick={goPrev} style={{ ...btnStyle, padding: '6px 8px' }}><ChevronLeft size={16} /></button>
          <button onClick={goToday} style={btnStyle}>{t('pages.changeCalendar.today')}</button>
          <button onClick={goNext} style={{ ...btnStyle, padding: '6px 8px' }}><ChevronRight size={16} /></button>
        </div>

        <span style={{ fontWeight: 600, fontSize: 16, color: '#0f172a' }}>{periodLabel}</span>

        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
          {conflicts.length > 0 && (
            <span style={{
              display: 'inline-flex', alignItems: 'center', gap: 4,
              padding: '4px 10px', borderRadius: 9999, fontSize: 12, fontWeight: 600,
              background: '#fef2f2', color: '#ef4444',
            }}>
              <AlertTriangle size={14} /> {conflicts.length} {t('pages.changeCalendar.conflicts')}
            </span>
          )}
          <button onClick={() => setShowSlotFinder(v => !v)} style={{ ...btnStyle, display: 'flex', alignItems: 'center', gap: 4 }}>
            <Search size={14} /> {t('pages.changeCalendar.findSlot')}
          </button>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 20 }}>
        {/* ── Calendar Area ──────────────────────────────────── */}
        <div style={{ flex: 1, minWidth: 0 }}>
          {/* ── Month View ────────────────────────────────────── */}
          {view === 'month' && (
            <div style={{ border: '1px solid #e2e8f0', borderRadius: 10, overflow: 'hidden', background: '#fff' }}>
              {/* Day headers */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)' }}>
                {DAYS.map(d => (
                  <div key={d} style={{
                    padding: '8px 4px', textAlign: 'center', fontSize: 11, fontWeight: 600,
                    color: '#64748b', background: '#f9fafb', borderBottom: '1px solid #e2e8f0',
                  }}>
                    {d}
                  </div>
                ))}
              </div>
              {/* Day cells */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)' }}>
                {monthGrid.map((cell, i) => {
                  const dayEvents = eventsForDay(cell.date)
                  const maxPills = 3
                  return (
                    <div
                      key={i}
                      style={{
                        ...cellBaseStyle,
                        background: isToday(cell.date) ? '#eff6ff' : '#fff',
                        opacity: cell.inMonth ? 1 : 0.4,
                      }}
                      onClick={() => { setCurrentDate(cell.date); setView('day') }}
                    >
                      <div style={{
                        fontSize: 12, fontWeight: isToday(cell.date) ? 700 : 400,
                        color: isToday(cell.date) ? '#0284c7' : '#0f172a', marginBottom: 4,
                      }}>
                        {cell.date.getDate()}
                      </div>
                      {dayEvents.slice(0, maxPills).map(renderEventPill)}
                      {dayEvents.length > maxPills && (
                        <div style={{ fontSize: 10, color: '#0284c7', fontWeight: 500, paddingLeft: 6 }}>
                          {t('pages.changeCalendar.more', { count: dayEvents.length - maxPills })}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {/* ── Week View ─────────────────────────────────────── */}
          {view === 'week' && (
            <div style={{ border: '1px solid #e2e8f0', borderRadius: 10, overflow: 'hidden', background: '#fff' }}>
              {/* Header */}
              <div style={{ display: 'grid', gridTemplateColumns: '60px repeat(7, 1fr)' }}>
                <div style={{ borderBottom: '1px solid #e2e8f0', background: '#f9fafb' }} />
                {weekDays.map((d, i) => (
                  <div key={i} style={{
                    padding: '8px 4px', textAlign: 'center', fontSize: 11, fontWeight: 600,
                    color: isToday(d) ? '#0284c7' : '#64748b', background: '#f9fafb',
                    borderBottom: '1px solid #e2e8f0', borderLeft: '1px solid #e2e8f0',
                  }}>
                    {DAYS[i]} {d.getDate()}
                  </div>
                ))}
              </div>
              {/* Time grid */}
              <div style={{ position: 'relative', maxHeight: 576, overflowY: 'auto' }}>
                {Array.from({ length: 24 }, (_, h) => (
                  <div key={h} style={{ display: 'grid', gridTemplateColumns: '60px repeat(7, 1fr)', height: 48 }}>
                    <div style={{
                      fontSize: 10, color: '#94a3b8', padding: '2px 8px', textAlign: 'right',
                      borderBottom: '1px solid #f1f5f9',
                    }}>
                      {pad(h)}:00
                    </div>
                    {weekDays.map((day, di) => {
                      const dayEvents = eventsForDay(day).filter(ev => {
                        const startH = new Date(ev.scheduledStart).getHours()
                        return startH === h
                      })
                      return (
                        <div key={di} style={{
                          position: 'relative', borderLeft: '1px solid #e2e8f0',
                          borderBottom: '1px solid #f1f5f9',
                        }}>
                          {dayEvents.map((ev, ei) => {
                            const start = new Date(ev.scheduledStart)
                            const durationHours = Math.max(ev.duration / 60, 0.5)
                            const topOffset = (start.getMinutes() / 60) * 48
                            return (
                              <div
                                key={ev.id}
                                style={{
                                  position: 'absolute',
                                  top: topOffset,
                                  left: ei > 0 ? '50%' : 2,
                                  right: 2,
                                  height: Math.max(durationHours * 48, 20),
                                  background: typeColor(ev.changeType),
                                  color: '#fff',
                                  borderRadius: 4,
                                  padding: '2px 4px',
                                  fontSize: 10,
                                  fontWeight: 500,
                                  overflow: 'hidden',
                                  cursor: 'pointer',
                                  zIndex: 2,
                                }}
                                title={ev.title}
                                onClick={() => navigate(`/changes/${ev.id}`)}
                              >
                                {ev.title}
                              </div>
                            )
                          })}
                        </div>
                      )
                    })}
                  </div>
                ))}
                {/* Current time line */}
                {weekDays.some(d => isToday(d)) && (() => {
                  const now = new Date()
                  const topPx = (now.getHours() * 48) + (now.getMinutes() / 60 * 48)
                  return (
                    <div style={{
                      position: 'absolute', top: topPx, left: 60, right: 0,
                      height: 2, background: '#ef4444', zIndex: 10, pointerEvents: 'none',
                    }} />
                  )
                })()}
              </div>
            </div>
          )}

          {/* ── Day View ──────────────────────────────────────── */}
          {view === 'day' && (
            <div style={{ border: '1px solid #e2e8f0', borderRadius: 10, overflow: 'hidden', background: '#fff' }}>
              <div style={{
                padding: '10px 16px', background: '#f9fafb', borderBottom: '1px solid #e2e8f0',
                fontWeight: 600, fontSize: 14, color: isToday(currentDate) ? '#0284c7' : '#0f172a',
              }}>
                {DAYS[(currentDate.getDay() + 6) % 7]} {currentDate.getDate()} {MONTHS[currentDate.getMonth()]}
              </div>
              <div style={{ position: 'relative', maxHeight: 576, overflowY: 'auto' }}>
                {Array.from({ length: 24 }, (_, h) => {
                  const hourEvents = eventsForDay(currentDate).filter(ev => {
                    const startH = new Date(ev.scheduledStart).getHours()
                    return startH === h
                  })
                  return (
                    <div key={h} style={{ display: 'grid', gridTemplateColumns: '60px 1fr', height: 48 }}>
                      <div style={{ fontSize: 10, color: '#94a3b8', padding: '2px 8px', textAlign: 'right', borderBottom: '1px solid #f1f5f9' }}>
                        {pad(h)}:00
                      </div>
                      <div style={{ position: 'relative', borderLeft: '1px solid #e2e8f0', borderBottom: '1px solid #f1f5f9' }}>
                        {hourEvents.map(ev => {
                          const start = new Date(ev.scheduledStart)
                          const durationHours = Math.max(ev.duration / 60, 0.5)
                          const topOffset = (start.getMinutes() / 60) * 48
                          return (
                            <div
                              key={ev.id}
                              onClick={() => navigate(`/changes/${ev.id}`)}
                              style={{
                                position: 'absolute', top: topOffset, left: 4, right: 4,
                                height: Math.max(durationHours * 48, 36),
                                background: typeColor(ev.changeType), color: '#fff',
                                borderRadius: 6, padding: '6px 10px', cursor: 'pointer',
                                zIndex: 2,
                              }}
                            >
                              <div style={{ fontWeight: 600, fontSize: 13 }}>{ev.title}</div>
                              <div style={{ fontSize: 11, opacity: 0.9, marginTop: 2, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                                <span style={{
                                  padding: '1px 6px', borderRadius: 4,
                                  background: 'rgba(255,255,255,0.2)', fontSize: 10,
                                }}>
                                  {ev.changeType}
                                </span>
                                {ev.teamName && <span>{ev.teamName}</span>}
                                {ev.ciNames?.length > 0 && <span>{ev.ciNames.join(', ')}</span>}
                              </div>
                            </div>
                          )
                        })}
                      </div>
                    </div>
                  )
                })}
                {/* Current time line */}
                {isToday(currentDate) && (() => {
                  const now = new Date()
                  const topPx = (now.getHours() * 48) + (now.getMinutes() / 60 * 48)
                  return (
                    <div style={{
                      position: 'absolute', top: topPx, left: 60, right: 0,
                      height: 2, background: '#ef4444', zIndex: 10, pointerEvents: 'none',
                    }} />
                  )
                })()}
              </div>
            </div>
          )}

          {/* ── No events message ─────────────────────────────── */}
          {events.length === 0 && (
            <div style={{
              textAlign: 'center', padding: 40, color: '#94a3b8', fontSize: 14, marginTop: 16,
            }}>
              {t('pages.changeCalendar.noEvents')}
            </div>
          )}
        </div>

        {/* ── Slot Finder Panel ──────────────────────────────── */}
        {showSlotFinder && (
          <div style={{
            width: 320, flexShrink: 0, background: '#fff', border: '1px solid #e2e8f0',
            borderRadius: 12, padding: 20, alignSelf: 'flex-start',
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
              <span style={{ fontWeight: 600, fontSize: 15, color: '#0f172a' }}>{t('pages.changeCalendar.findSlot')}</span>
              <button onClick={() => setShowSlotFinder(false)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#94a3b8' }}>
                <X size={18} />
              </button>
            </div>

            {/* Duration */}
            <label style={{ display: 'block', marginBottom: 12 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: '#64748b', marginBottom: 4 }}>
                {t('pages.changeCalendar.slotDuration')}
              </div>
              <input
                type="number"
                min={1}
                max={48}
                value={slotDuration}
                onChange={e => setSlotDuration(Number(e.target.value))}
                style={{
                  width: '100%', padding: '8px 12px', border: '1px solid #e2e8f0',
                  borderRadius: 8, fontSize: 14, outline: 'none', boxSizing: 'border-box',
                }}
              />
            </label>

            {/* CI picker */}
            <label style={{ display: 'block', marginBottom: 12 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: '#64748b', marginBottom: 4 }}>
                {t('pages.changeCalendar.slotCIs')}
              </div>
              <div style={{ position: 'relative' }}>
                <input
                  placeholder={t('pages.whatIf.searchCI')}
                  value={slotCISearch}
                  onChange={e => setSlotCISearch(e.target.value)}
                  style={{
                    width: '100%', padding: '8px 12px', border: '1px solid #e2e8f0',
                    borderRadius: 8, fontSize: 13, outline: 'none', boxSizing: 'border-box',
                  }}
                />
                {slotCISearch.length >= 2 && slotCIData?.allCIs?.items && (
                  <div style={{
                    position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 50,
                    background: '#fff', border: '1px solid #e2e8f0', borderRadius: 8,
                    maxHeight: 150, overflowY: 'auto', boxShadow: '0 4px 12px rgba(0,0,0,0.1)',
                  }}>
                    {slotCIData.allCIs.items.map(ci => (
                      <div
                        key={ci.id}
                        style={{ padding: '6px 10px', cursor: 'pointer', fontSize: 12 }}
                        onClick={() => {
                          if (!slotCIIds.includes(ci.id)) setSlotCIIds(prev => [...prev, ci.id])
                          setSlotCISearch('')
                        }}
                        onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = '#f1f5f9' }}
                        onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = '' }}
                      >
                        {ci.name} <span style={{ color: '#94a3b8' }}>({ci.type})</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
              {slotCIIds.length > 0 && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 6 }}>
                  {slotCIIds.map(id => (
                    <span
                      key={id}
                      style={{
                        padding: '2px 8px', borderRadius: 9999, fontSize: 11, background: '#f1f5f9',
                        color: '#64748b', cursor: 'pointer',
                      }}
                      onClick={() => setSlotCIIds(prev => prev.filter(x => x !== id))}
                    >
                      {id} x
                    </span>
                  ))}
                </div>
              )}
            </label>

            {/* Date range */}
            <div style={{ fontSize: 12, fontWeight: 600, color: '#64748b', marginBottom: 4 }}>
              {t('pages.changeCalendar.slotRange')}
            </div>
            <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
              <input
                type="date"
                value={slotFrom}
                onChange={e => setSlotFrom(e.target.value)}
                style={{
                  flex: 1, padding: '6px 8px', border: '1px solid #e2e8f0',
                  borderRadius: 6, fontSize: 12, outline: 'none',
                }}
              />
              <input
                type="date"
                value={slotTo}
                onChange={e => setSlotTo(e.target.value)}
                style={{
                  flex: 1, padding: '6px 8px', border: '1px solid #e2e8f0',
                  borderRadius: 6, fontSize: 12, outline: 'none',
                }}
              />
            </div>

            <button
              onClick={handleSearchSlots}
              disabled={!slotFrom || !slotTo || slotsLoading}
              style={{
                width: '100%', padding: '10px 0', borderRadius: 8, border: 'none',
                background: slotFrom && slotTo ? '#0284c7' : '#94a3b8',
                color: '#fff', fontWeight: 600, fontSize: 13, cursor: slotFrom && slotTo ? 'pointer' : 'not-allowed',
                marginBottom: 16,
              }}
            >
              {slotsLoading ? t('common.loading') : t('pages.changeCalendar.searchSlots')}
            </button>

            {/* Slot results */}
            {slots.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {slots.map((slot, i) => {
                  const start = new Date(slot.start)
                  const end = new Date(slot.end)
                  return (
                    <div key={i} style={{
                      padding: 10, borderRadius: 8, border: '1px solid #e2e8f0', background: '#f8fafc',
                    }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                        <span style={{ fontWeight: 600, fontSize: 12, color: '#0f172a' }}>
                          {start.toLocaleDateString()} {pad(start.getHours())}:{pad(start.getMinutes())} - {pad(end.getHours())}:{pad(end.getMinutes())}
                        </span>
                        <span style={{
                          padding: '2px 8px', borderRadius: 9999, fontSize: 10, fontWeight: 700,
                          background: scoreColor(slot.score) + '15', color: scoreColor(slot.score),
                        }}>
                          {t('pages.changeCalendar.score')}: {slot.score}
                        </span>
                      </div>
                      <div style={{ fontSize: 11, color: '#64748b', marginBottom: 6 }}>{slot.reason}</div>
                      <button
                        onClick={() => {
                          navigator.clipboard.writeText(`${start.toISOString()} - ${end.toISOString()}`)
                        }}
                        style={{
                          padding: '4px 10px', borderRadius: 6, border: '1px solid #e2e8f0',
                          background: '#fff', fontSize: 11, fontWeight: 500, cursor: 'pointer', color: '#0284c7',
                        }}
                      >
                        {t('pages.changeCalendar.useSlot')}
                      </button>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )}
      </div>
    </PageContainer>
  )
}
