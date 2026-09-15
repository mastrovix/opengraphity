/**
 * ORGANIZZAZIONE: le scelte che valgono per tutti, e non per una persona.
 *
 * Nasce per la lingua predefinita, che era una costante nel codice
 * (`LINGUA_PREDEFINITA = 'it'`): cambiarla voleva dire ricompilare, e per un
 * cliente non italiano metà delle etichette si leggeva in italiano senza
 * rimedio. Ora è configurazione, e questa è la pagina dove si configura —
 * senza script e senza codice, come tutto il resto.
 *
 * La distinzione che questa pagina deve rendere evidente, perché è la fonte di
 * ogni fraintendimento: qui si sceglie la lingua dell'AZIENDA (quella che
 * legge chi non ne ha scelta una), nel Profilo quella di una PERSONA (che vince
 * sempre, per chi l'ha scelta).
 *
 * Impaginazione: la stessa delle sue vicine nel menu Configurazione (Matrici
 * di dominio, Dizionario, CI Type Designer) — `PageContainer` per i margini,
 * titolo con sottotitolo in `--color-slate-light`, e il contenuto in una
 * `SectionCard` non richiudibile col corpo a 16px. Prima era una pagina di
 * ELENCO (`ListPageHeader`, che porta i pulsanti d'azione a destra) e senza
 * `PageContainer`: appoggiata al bordo. Poi ha copiato `EventPolicyPage`, che
 * è l'unica del gruppo a fare diversamente (fieldset, sottotitolo scuro): la
 * regola è la maggioranza, non la prima pagina che si apre.
 */
import { useEffect, useId, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useQuery, useMutation } from '@apollo/client/react'
import { useTranslation } from 'react-i18next'
import { Building2 } from 'lucide-react'
import { toast } from 'sonner'
import { GET_TENANT_LANGUAGE_SETTINGS, GET_TENANT_TIMEZONE_SETTINGS, GET_SERVICE_CALENDARS, GET_PORTAL_SEVERITY_OPTIONS, GET_TENANT_INAPP_RETENTION } from '@/graphql/queries'
import { SET_TENANT_DEFAULT_LANGUAGE, SET_TENANT_TIMEZONE, CREATE_SERVICE_CALENDAR, UPDATE_SERVICE_CALENDAR, DELETE_SERVICE_CALENDAR, SET_PORTAL_SEVERITY_OPTIONS, SET_TENANT_INAPP_RETENTION } from '@/graphql/mutations'
import { PageContainer } from '@/components/PageContainer'
import { PageTitle } from '@/components/PageTitle'
import { SectionCard } from '@/components/ui/SectionCard'
import { FieldLabel, Input, Select } from '@/components/ui/FormControls'
import { Button } from '@/components/Button'
import { Modal } from '@/components/Modal'
import { useConfirm } from '@/hooks/useConfirm'
import { Skeleton } from '@/components/ui/skeleton'
import { QueryError } from '@/components/QueryError'
import { colors } from '@/lib/tokens'
import { applicaLinguaDelCliente, linguaSceltaDallUtente } from '@/i18n/tenantLanguage'
import { useDomainVocabularies } from '@/contexts/DomainVocabularyContext'
import { SeverityBadge } from '@/components/ui/badges'
import { Tabs, type TabItem } from '@/components/ui/Tabs'
import { OrganizationNameSection } from './organization/OrganizationNameSection'
import { BrandSection } from './organization/BrandSection'
import { TicketNumberingSection } from './organization/TicketNumberingSection'
import { AttachmentPolicySection } from './organization/AttachmentPolicySection'
import { AISection } from './organization/AISection'

/**
 * Le schede della pagina (verifica «Cosa resta cablato», ondata 6): con nome,
 * marchio, numerazione, allegati e AI le sezioni erano troppe per una colonna
 * sola. La scheda sta nell'indirizzo (`?tab=ai`), così un avviso «funzione
 * spenta» in un'altra pagina porta dritto al punto giusto.
 */
export const ORGANIZATION_TABS = ['general', 'service', 'portal', 'tickets', 'ai'] as const
export type OrganizationTab = (typeof ORGANIZATION_TABS)[number]

interface LanguageSettings { available: string[]; defaultLanguage: string | null; fallback: string }
interface TimezoneSettings { timezone: string | null; available: string[] }

export function OrganizationPage() {
  const { t } = useTranslation()
  const uid = useId()
  const [params, setParams] = useSearchParams()
  const rawTab = params.get('tab')
  const tab: OrganizationTab = (ORGANIZATION_TABS as readonly string[]).includes(rawTab ?? '') ? rawTab as OrganizationTab : 'general'
  const tabItems: TabItem<OrganizationTab>[] = ORGANIZATION_TABS.map((key) => ({ key, label: t(`pages.organization.tabs.${key}`) }))
  const fid = (name: string) => `${uid}-${name}`

  const { data, loading, error, refetch } = useQuery<{ tenantLanguageSettings: LanguageSettings }>(
    GET_TENANT_LANGUAGE_SETTINGS, { fetchPolicy: 'cache-and-network' },
  )
  const [salva, { loading: salvando }] = useMutation(SET_TENANT_DEFAULT_LANGUAGE, {
    refetchQueries: [GET_TENANT_LANGUAGE_SETTINGS],
    onCompleted: (d: unknown) => {
      const lingua = (d as { setTenantDefaultLanguage: LanguageSettings }).setTenantDefaultLanguage.defaultLanguage
      toast.success(t('pages.organization.saved'))
      /*
        Chi NON ha una lingua propria deve vedere il cambiamento subito: è la
        sua lingua che è appena cambiata. Chi l'ha scelta nel Profilo non viene
        toccato — la scelta di una persona vince su quella dell'azienda, anche
        quando è l'azienda a cambiare idea.
      */
      if (lingua && !linguaSceltaDallUtente()) void applicaLinguaDelCliente(lingua)
    },
    onError: (e) => toast.error(e.message),
  })

  if (error && !data) {
    return <PageContainer><QueryError message={error.message} onRetry={() => void refetch()} /></PageContainer>
  }

  const impostazioni = data?.tenantLanguageSettings
  const corrente = impostazioni?.defaultLanguage ?? ''

  return (
    <PageContainer>
      <div style={{ marginBottom: 24 }}>
        <PageTitle icon={<Building2 size={22} color="var(--color-icon-accent)" />}>{t('pages.organization.title')}</PageTitle>
        <p style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate-dark)', marginTop: 4, marginBottom: 0 }}>
          {t('pages.organization.subtitle')}
        </p>
      </div>

      <Tabs items={tabItems} value={tab} onChange={(key) => setParams(key === 'general' ? {} : { tab: key }, { replace: true })} ariaLabel={t('pages.organization.tabsLabel')} />

      {tab === 'general' && <>
      <OrganizationNameSection />
      <div style={{ marginTop: 16 }}>
      <SectionCard collapsible={false} title={t('pages.organization.languageTitle')}>
          <div style={{ padding: 16 }}>
            <p style={{ margin: '0 0 14px', color: colors.slateLight, fontSize: 'var(--font-size-body)', lineHeight: 1.55 }}>
              {t('pages.organization.languageDescription')}
            </p>
  
            {!impostazioni && loading ? <Skeleton style={{ height: 38, maxWidth: 240 }} /> : null}
  
            {impostazioni && (
              <>
                <FieldLabel htmlFor={fid('language')}>{t('pages.organization.defaultLanguage')}</FieldLabel>
                <Select
                  id={fid('language')}
                  value={corrente}
                  disabled={salvando}
                  onChange={(e) => { void salva({ variables: { language: e.target.value } }) }}
                  style={{ maxWidth: 260 }}
                >
                  {/*
                    «Non configurata» è una voce vera, e non si può ri-scegliere:
                    è lo stato in cui nasce un cliente, e la diagnostica in cima
                    alla pagina lo dice. Mostrarla invece di far finta che una
                    lingua sia stata scelta è tutto il punto della pagina.
                  */}
                  {corrente === '' && <option value="" disabled>{t('pages.organization.notConfigured')}</option>}
                  {impostazioni.available.map((l) => (
                    <option key={l} value={l}>{t(`languages.${l}`)}</option>
                  ))}
                </Select>
                <p style={{ color: colors.slateLight, margin: '8px 0 0', fontSize: 'var(--font-size-label)', lineHeight: 1.5 }}>
                  {corrente === ''
                    ? t('pages.organization.fallbackInUse', { language: t(`languages.${impostazioni.fallback}`) })
                    : t('pages.organization.personalWins')}
                </p>
              </>
            )}
          </div>
        </SectionCard>
      </div>
      <TimezoneSection />
      <InAppRetentionSection />
      </>}

      {tab === 'service' && <ServiceCalendarsSection />}

      {tab === 'portal' && <>
        <BrandSection />
        <PortalSeveritySection languages={impostazioni?.available ?? null} />
      </>}

      {tab === 'tickets' && <>
        <TicketNumberingSection />
        <AttachmentPolicySection />
      </>}

      {tab === 'ai' && <AISection />}
    </PageContainer>
  )
}

/**
 * Il fuso orario del cliente (revisione del 14 set 2026 · F7). Si scriveva solo
 * con `onboard-tenant.ts`, eppure ne dipendono le scadenze SLA/OLA, il digest e
 * ogni data nei testi generati.
 */
function TimezoneSection() {
  const { t } = useTranslation()
  const uid = useId()
  const { data, loading, error, refetch } = useQuery<{ tenantTimezoneSettings: TimezoneSettings }>(
    GET_TENANT_TIMEZONE_SETTINGS, { fetchPolicy: 'cache-and-network' },
  )
  const [saveTimezone, { loading: saving }] = useMutation(SET_TENANT_TIMEZONE, {
    refetchQueries: [GET_TENANT_TIMEZONE_SETTINGS],
    onCompleted: () => { toast.success(t('pages.organization.timezoneSaved')) },
    onError: (e) => toast.error(e.message),
  })

  const settings = data?.tenantTimezoneSettings
  const current = settings?.timezone ?? ''

  return (
    <div style={{ marginTop: 16 }}>
      <SectionCard collapsible={false} title={t('pages.organization.timezoneTitle')}>
        <div style={{ padding: 16 }}>
          <p style={{ margin: '0 0 14px', color: colors.slateLight, fontSize: 'var(--font-size-body)', lineHeight: 1.55 }}>
            {t('pages.organization.timezoneDescription')}
          </p>
          {error && !data ? <QueryError message={error.message} onRetry={() => void refetch()} /> : null}
          {!settings && loading ? <Skeleton style={{ height: 38, maxWidth: 240 }} /> : null}
          {settings && (
            <>
              <FieldLabel htmlFor={`${uid}-timezone`}>{t('pages.organization.timezone')}</FieldLabel>
              <Select
                id={`${uid}-timezone`}
                value={current}
                disabled={saving}
                onChange={(e) => { void saveTimezone({ variables: { timezone: e.target.value } }) }}
                style={{ maxWidth: 320 }}
              >
                {current === '' && <option value="" disabled>{t('pages.organization.timezoneNotConfigured')}</option>}
                {settings.available.map((z) => <option key={z} value={z}>{z}</option>)}
              </Select>
              <p style={{ color: current === '' ? 'var(--color-danger)' : colors.slateLight, margin: '8px 0 0', fontSize: 'var(--font-size-label)', lineHeight: 1.5 }}>
                {current === '' ? t('pages.organization.timezoneMissing') : t('pages.organization.timezoneExisting')}
              </p>
            </>
          )}
        </div>
      </SectionCard>
    </div>
  )
}

interface ServiceCalendar {
  id: string; name: string; days: number[]; start: string; end: string; holidays: string[]
  usedBySlaPolicies: string[]; usedByOlaContracts: string[]; usedByWorkflowSteps: string[]
}
interface CalendarDraft { name: string; days: number[]; start: string; end: string; holidays: string }

/** L'ordine con cui si leggono i giorni: da lunedì. Il valore è quello di `Date.getDay()` (0 = domenica). */
const WEEK = [1, 2, 3, 4, 5, 6, 0] as const
const WEEKDAY_KEYS: Record<number, string> = {
  0: 'pages.organization.weekday.sunday', 1: 'pages.organization.weekday.monday', 2: 'pages.organization.weekday.tuesday',
  3: 'pages.organization.weekday.wednesday', 4: 'pages.organization.weekday.thursday', 5: 'pages.organization.weekday.friday',
  6: 'pages.organization.weekday.saturday',
}
const WEEKDAY_SHORT_KEYS: Record<number, string> = {
  0: 'pages.organization.weekdayShort.sunday', 1: 'pages.organization.weekdayShort.monday', 2: 'pages.organization.weekdayShort.tuesday',
  3: 'pages.organization.weekdayShort.wednesday', 4: 'pages.organization.weekdayShort.thursday', 5: 'pages.organization.weekdayShort.friday',
  6: 'pages.organization.weekdayShort.saturday',
}
const EMPTY_CALENDAR: CalendarDraft = { name: '', days: [], start: '', end: '', holidays: '' }

/**
 * I CALENDARI DI SERVIZIO CON NOME (verifica «Cosa resta cablato», ondata 2).
 *
 * Prima c'era un solo calendario per organizzazione (revisione del 14 set 2026 ·
 * F6): una policy SLA o un contratto OLA poteva scegliere solo fra 24×7 e
 * quello. Un team di turno o un fornitore con orari suoi non si modellava. Ora
 * si creano quanti calendari servono, e ognuno dice chi lo usa; uno in uso non
 * si elimina.
 */
function ServiceCalendarsSection() {
  const { t } = useTranslation()
  const uid = useId()
  const confirm = useConfirm()
  const { data, loading, error, refetch } = useQuery<{ serviceCalendars: ServiceCalendar[] }>(
    GET_SERVICE_CALENDARS, { fetchPolicy: 'cache-and-network' },
  )
  const calendars = data?.serviceCalendars ?? []
  const [editing, setEditing] = useState<ServiceCalendar | null>(null)
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<CalendarDraft>(EMPTY_CALENDAR)
  const patchDraft = (p: Partial<CalendarDraft>) => setDraft((cur) => ({ ...cur, ...p }))

  const after = { refetchQueries: [GET_SERVICE_CALENDARS], onError: (e: Error) => toast.error(e.message) }
  const [createCalendar, { loading: creating }] = useMutation(CREATE_SERVICE_CALENDAR, {
    ...after, onCompleted: () => { toast.success(t('pages.organization.calendarCreated')); setOpen(false) },
  })
  const [updateCalendar, { loading: updating }] = useMutation(UPDATE_SERVICE_CALENDAR, {
    ...after, onCompleted: () => { toast.success(t('pages.organization.calendarSaved')); setOpen(false) },
  })
  const [deleteCalendar] = useMutation(DELETE_SERVICE_CALENDAR, {
    ...after, onCompleted: () => { toast.success(t('pages.organization.calendarDeleted')) },
  })

  const openNew = () => { setEditing(null); setDraft(EMPTY_CALENDAR); setOpen(true) }
  const openEdit = (c: ServiceCalendar) => {
    setEditing(c)
    setDraft({ name: c.name, days: c.days, start: c.start, end: c.end, holidays: c.holidays.join(', ') })
    setOpen(true)
  }
  const toggleDay = (d: number) => patchDraft({ days: draft.days.includes(d) ? draft.days.filter((x) => x !== d) : [...draft.days, d] })
  const submit = () => {
    const calendar = {
      days: [...draft.days].sort((a, b) => a - b), start: draft.start, end: draft.end,
      holidays: draft.holidays.split(/[\s,;]+/).map((h) => h.trim()).filter(Boolean),
    }
    if (editing) void updateCalendar({ variables: { id: editing.id, name: draft.name.trim(), calendar } })
    else void createCalendar({ variables: { name: draft.name.trim(), calendar } })
  }
  const remove = async (c: ServiceCalendar) => {
    const ok = await confirm({ title: t('pages.organization.calendarDeleteTitle'), body: c.name, danger: true })
    if (ok) void deleteCalendar({ variables: { id: c.id } })
  }

  const usedBy = (c: ServiceCalendar) => [...c.usedBySlaPolicies, ...c.usedByOlaContracts, ...c.usedByWorkflowSteps]
  const canSave = draft.name.trim() !== '' && draft.days.length > 0 && draft.start !== '' && draft.end !== ''

  return (
    <div style={{ marginTop: 16 }}>
      <SectionCard collapsible={false} title={t('pages.organization.calendarsTitle')}>
        <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 14 }}>
          <p style={{ margin: 0, color: colors.slateLight, fontSize: 'var(--font-size-body)', lineHeight: 1.55 }}>
            {t('pages.organization.calendarsDescription')}
          </p>
          {error && !data ? <QueryError message={error.message} onRetry={() => void refetch()} /> : null}
          {!data && loading ? <Skeleton style={{ height: 80, maxWidth: 640 }} /> : null}
          {data && calendars.length === 0 && (
            <p role="status" style={{ margin: 0, color: 'var(--color-slate)', fontSize: 'var(--font-size-body)' }}>
              {t('pages.organization.calendarsEmpty')}
            </p>
          )}
          {calendars.length > 0 && (
            <ul aria-label={t('pages.organization.calendarsTitle')} style={{ listStyle: 'none', margin: 0, padding: 0, border: '1px solid var(--color-border)', borderRadius: 8 }}>
              {calendars.map((c, i) => (
                <li key={c.id} style={{ display: 'flex', gap: 12, alignItems: 'flex-start', padding: '12px 14px', borderTop: i === 0 ? 'none' : '1px solid var(--color-border)' }}>
                  <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
                    <span style={{ fontWeight: 600, color: 'var(--color-slate-dark)', fontSize: 'var(--font-size-body)' }}>{c.name}</span>
                    <span style={{ color: 'var(--color-slate)', fontSize: 'var(--font-size-label)' }}>
                      {WEEK.filter((d) => c.days.includes(d)).map((d) => t(WEEKDAY_SHORT_KEYS[d]!)).join(' ')}
                      {' · '}{c.start}–{c.end}
                      {c.holidays.length > 0 && <>{' · '}{t('pages.organization.calendarHolidayCount', { count: c.holidays.length })}</>}
                    </span>
                    <span style={{ color: usedBy(c).length ? 'var(--color-slate)' : colors.slateLight, fontSize: 'var(--font-size-label)', lineHeight: 1.5 }}>
                      {usedBy(c).length
                        ? t('pages.organization.calendarUsedByList', { users: usedBy(c).join(', ') })
                        : t('pages.organization.calendarUnused')}
                    </span>
                  </div>
                  <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                    <Button variant="ghost" onClick={() => openEdit(c)}>{t('common.edit')}</Button>
                    <Button variant="secondary" size="xs" onClick={() => void remove(c)} disabled={usedBy(c).length > 0} title={usedBy(c).length > 0 ? t('pages.organization.calendarInUse') : undefined}>
                      {t('common.delete')}
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
          <div>
            <Button onClick={openNew}>{t('pages.organization.calendarNew')}</Button>
          </div>
        </div>
      </SectionCard>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={t(editing ? 'pages.organization.calendarEditTitle' : 'pages.organization.calendarNewTitle')}
        width={560}
        footer={
          <>
            <Button variant="secondary" onClick={() => setOpen(false)}>{t('common.cancel')}</Button>
            <Button onClick={submit} disabled={!canSave || creating || updating}>{t('pages.organization.calendarSave')}</Button>
          </>
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div>
            <FieldLabel htmlFor={`${uid}-name`}>{t('pages.organization.calendarName')}</FieldLabel>
            <Input id={`${uid}-name`} value={draft.name} maxLength={80} placeholder={t('pages.organization.calendarNamePlaceholder')} onChange={(e) => patchDraft({ name: e.target.value })} />
          </div>
          <fieldset style={{ border: 'none', margin: 0, padding: 0 }}>
            <legend style={{ fontSize: 'var(--font-size-label)', fontWeight: 600, color: 'var(--color-slate)', marginBottom: 6 }}>
              {t('pages.organization.calendarDays')}
            </legend>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
              {WEEK.map((d) => (
                <label key={d} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 'var(--font-size-body)' }}>
                  <input type="checkbox" checked={draft.days.includes(d)} onChange={() => toggleDay(d)} />
                  {t(WEEKDAY_KEYS[d]!)}
                </label>
              ))}
            </div>
          </fieldset>
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
            <div>
              <FieldLabel htmlFor={`${uid}-start`}>{t('pages.organization.calendarStart')}</FieldLabel>
              <Input id={`${uid}-start`} type="time" value={draft.start} onChange={(e) => patchDraft({ start: e.target.value })} style={{ width: 140 }} />
            </div>
            <div>
              <FieldLabel htmlFor={`${uid}-end`}>{t('pages.organization.calendarEnd')}</FieldLabel>
              <Input id={`${uid}-end`} type="time" value={draft.end} onChange={(e) => patchDraft({ end: e.target.value })} style={{ width: 140 }} />
            </div>
          </div>
          <div>
            <FieldLabel htmlFor={`${uid}-holidays`}>{t('pages.organization.calendarHolidays')}</FieldLabel>
            <Input id={`${uid}-holidays`} value={draft.holidays} placeholder="2026-12-25, 2026-12-26" onChange={(e) => patchDraft({ holidays: e.target.value })} />
            <p style={{ color: colors.slateLight, margin: '6px 0 0', fontSize: 'var(--font-size-label)', lineHeight: 1.5 }}>
              {t('pages.organization.calendarHolidaysHint')}
            </p>
          </div>
          {editing && usedBy(editing).length > 0 && (
            <p style={{ margin: 0, color: colors.slateLight, fontSize: 'var(--font-size-label)', lineHeight: 1.5 }}>
              {t('pages.organization.calendarEditUsedBy', { users: usedBy(editing).join(', ') })}
            </p>
          )}
        </div>
      </Modal>
    </div>
  )
}

interface PortalSeverityOption { value: string; labels: { language: string; label: string }[] }
interface PortalSeverityDraft { offered: boolean; labels: Record<string, string> }

/**
 * LE SEVERITÀ DEL PORTALE SELF-SERVICE (verifica «Cosa resta cablato», ondata
 * 1). Il portale offriva `low / medium / high` scritti nel codice: una severità
 * aggiunta dal cliente non si poteva scegliere, una rinominata veniva mandata
 * comunque. Qui l'amministratore sceglie quali valori del vocabolario offrire
 * e, se vuole, con che parole per chi apre un ticket. Una lingua lasciata vuota
 * usa l'etichetta del Dizionario, che compare come suggerimento nel campo.
 */
function PortalSeveritySection({ languages }: { languages: readonly string[] | null }) {
  const { t } = useTranslation()
  const uid = useId()
  const { entriesOf } = useDomainVocabularies()
  const vocabulary = entriesOf('severity')
  const { data, loading, error, refetch } = useQuery<{ portalSeverityOptions: PortalSeverityOption[] | null }>(
    GET_PORTAL_SEVERITY_OPTIONS, { fetchPolicy: 'cache-and-network' },
  )
  const saved = data?.portalSeverityOptions ?? null
  const [draft, setDraft] = useState<Record<string, PortalSeverityDraft>>({})

  useEffect(() => {
    if (!data || !vocabulary) return
    const next: Record<string, PortalSeverityDraft> = {}
    for (const entry of vocabulary) {
      const option = saved?.find((o) => o.value === entry.value)
      next[entry.value] = {
        offered: option !== undefined,
        labels: Object.fromEntries((option?.labels ?? []).map((l) => [l.language, l.label])),
      }
    }
    setDraft(next)
  }, [data, saved, vocabulary])

  const [saveOptions, { loading: saving }] = useMutation(SET_PORTAL_SEVERITY_OPTIONS, {
    refetchQueries: [GET_PORTAL_SEVERITY_OPTIONS],
    onCompleted: () => { toast.success(t('pages.organization.portalSeveritiesSaved')) },
    onError: (e) => toast.error(e.message),
  })

  const setOffered = (value: string, offered: boolean) =>
    setDraft((cur) => ({ ...cur, [value]: { labels: cur[value]?.labels ?? {}, offered } }))
  const setLabel = (value: string, language: string, label: string) =>
    setDraft((cur) => ({ ...cur, [value]: { offered: cur[value]?.offered ?? false, labels: { ...(cur[value]?.labels ?? {}), [language]: label } } }))

  const submit = () => {
    if (!vocabulary || !languages) return
    const options = vocabulary
      .filter((entry) => draft[entry.value]?.offered)
      .map((entry) => ({
        value: entry.value,
        labels: languages.map((language) => ({ language, label: draft[entry.value]?.labels[language] ?? '' })),
      }))
    void saveOptions({ variables: { options } })
  }

  const offeredCount = Object.values(draft).filter((d) => d.offered).length
  const ready = data && vocabulary && languages

  return (
    <div style={{ marginTop: 16 }}>
      <SectionCard collapsible={false} title={t('pages.organization.portalSeveritiesTitle')}>
        <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 14 }}>
          <p style={{ margin: 0, color: colors.slateLight, fontSize: 'var(--font-size-body)', lineHeight: 1.55 }}>
            {t('pages.organization.portalSeveritiesDescription')}
          </p>
          {error && !data ? <QueryError message={error.message} onRetry={() => void refetch()} /> : null}
          {!ready && loading ? <Skeleton style={{ height: 120, maxWidth: 640 }} /> : null}
          {ready && (
            <>
              {saved === null && (
                <p role="status" style={{ margin: 0, color: 'var(--color-danger)', fontSize: 'var(--font-size-label)' }}>
                  {t('pages.organization.portalSeveritiesMissing')}
                </p>
              )}
              <div role="table" aria-label={t('pages.organization.portalSeveritiesTitle')} style={{ border: '1px solid var(--color-border)', borderRadius: 8, overflowX: 'auto' }}>
                <div role="row" style={{ display: 'grid', gridTemplateColumns: `minmax(96px, 0.8fr) 80px repeat(${languages.length}, minmax(120px, 1.2fr))`, gap: 12, padding: '8px 12px', background: 'var(--color-slate-bg)', fontSize: 'var(--font-size-label)', fontWeight: 600, color: 'var(--color-slate)' }}>
                  <span role="columnheader">{t('pages.organization.portalSeveritiesValue')}</span>
                  <span role="columnheader">{t('pages.organization.portalSeveritiesOffered')}</span>
                  {languages.map((language) => (
                    <span key={language} role="columnheader">{t('pages.organization.portalSeveritiesLabelIn', { language: t(`languages.${language}`) })}</span>
                  ))}
                </div>
                {vocabulary.map((entry) => {
                  const row = draft[entry.value]
                  const dictionaryLabel = (language: string) => entry.labels.find((l) => l.language === language)?.label ?? entry.label
                  return (
                    <div key={entry.value} role="row" style={{ display: 'grid', gridTemplateColumns: `minmax(96px, 0.8fr) 80px repeat(${languages.length}, minmax(120px, 1.2fr))`, gap: 12, padding: '10px 12px', alignItems: 'center', borderTop: '1px solid var(--color-border)' }}>
                      <span role="cell"><SeverityBadge value={entry.value} /></span>
                      <span role="cell">
                        <input
                          id={`${uid}-${entry.value}-offered`}
                          type="checkbox"
                          aria-label={t('pages.organization.portalSeveritiesOfferValue', { value: entry.label })}
                          checked={row?.offered ?? false}
                          onChange={(e) => setOffered(entry.value, e.target.checked)}
                        />
                      </span>
                      {languages.map((language) => (
                        <span key={language} role="cell">
                          <Input
                            aria-label={t('pages.organization.portalSeveritiesLabelFor', { value: entry.label, language: t(`languages.${language}`) })}
                            value={row?.labels[language] ?? ''}
                            placeholder={dictionaryLabel(language)}
                            disabled={!row?.offered}
                            maxLength={80}
                            onChange={(e) => setLabel(entry.value, language, e.target.value)}
                            style={{ width: '100%', minWidth: 0, boxSizing: 'border-box' }}
                          />
                        </span>
                      ))}
                    </div>
                  )
                })}
              </div>
              <p style={{ color: colors.slateLight, margin: 0, fontSize: 'var(--font-size-label)', lineHeight: 1.5 }}>
                {t('pages.organization.portalSeveritiesHint')}
              </p>
              <div>
                <Button onClick={submit} disabled={saving || offeredCount === 0}>{t('pages.organization.portalSeveritiesSave')}</Button>
              </div>
            </>
          )}
        </div>
      </SectionCard>
    </div>
  )
}

/**
 * PER QUANTI GIORNI SI CONSERVANO LE NOTIFICHE DELLA CAMPANELLA (verifica «Cosa
 * resta cablato», ondata 2). Era una variabile d'ambiente uguale per tutti i
 * clienti; ora la sceglie ogni organizzazione, come fa già per gli allarmi
 * nella Policy eventi.
 */
function InAppRetentionSection() {
  const { t } = useTranslation()
  const uid = useId()
  const { data, loading, error, refetch } = useQuery<{ tenantInAppRetentionDays: number | null }>(
    GET_TENANT_INAPP_RETENTION, { fetchPolicy: 'cache-and-network' },
  )
  const saved = data?.tenantInAppRetentionDays ?? null
  const [days, setDays] = useState('')
  useEffect(() => { if (data) setDays(saved === null ? '' : String(saved)) }, [data, saved])

  const [save, { loading: saving }] = useMutation(SET_TENANT_INAPP_RETENTION, {
    refetchQueries: [GET_TENANT_INAPP_RETENTION],
    onCompleted: () => { toast.success(t('pages.organization.inAppRetentionSaved')) },
    onError: (e) => toast.error(e.message),
  })
  const value = Number(days)
  const valid = days.trim() !== '' && Number.isInteger(value) && value >= 1 && value <= 3650

  return (
    <div style={{ marginTop: 16 }}>
      <SectionCard collapsible={false} title={t('pages.organization.inAppRetentionTitle')}>
        <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 14 }}>
          <p style={{ margin: 0, color: colors.slateLight, fontSize: 'var(--font-size-body)', lineHeight: 1.55 }}>
            {t('pages.organization.inAppRetentionDescription')}
          </p>
          {error && !data ? <QueryError message={error.message} onRetry={() => void refetch()} /> : null}
          {!data && loading ? <Skeleton style={{ height: 38, maxWidth: 240 }} /> : null}
          {data && (
            <>
              {saved === null && (
                <p role="status" style={{ margin: 0, color: 'var(--color-danger)', fontSize: 'var(--font-size-label)' }}>
                  {t('pages.organization.inAppRetentionMissing')}
                </p>
              )}
              <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
                <div>
                  <FieldLabel htmlFor={`${uid}-days`}>{t('pages.organization.inAppRetentionDays')}</FieldLabel>
                  <Input id={`${uid}-days`} type="number" min={1} max={3650} value={days} onChange={(e) => setDays(e.target.value)} style={{ width: 140 }} />
                </div>
                <Button onClick={() => void save({ variables: { days: value } })} disabled={saving || !valid || value === saved}>
                  {t('pages.organization.inAppRetentionSave')}
                </Button>
              </div>
              <p style={{ color: colors.slateLight, margin: 0, fontSize: 'var(--font-size-label)', lineHeight: 1.5 }}>
                {t('pages.organization.inAppRetentionHint')}
              </p>
            </>
          )}
        </div>
      </SectionCard>
    </div>
  )
}
