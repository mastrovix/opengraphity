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
import { useQuery, useMutation } from '@apollo/client/react'
import { useTranslation } from 'react-i18next'
import { Building2 } from 'lucide-react'
import { toast } from 'sonner'
import { GET_TENANT_LANGUAGE_SETTINGS, GET_TENANT_TIMEZONE_SETTINGS, GET_TENANT_SERVICE_CALENDAR, GET_PORTAL_SEVERITY_OPTIONS } from '@/graphql/queries'
import { SET_TENANT_DEFAULT_LANGUAGE, SET_TENANT_TIMEZONE, SET_TENANT_SERVICE_CALENDAR, SET_PORTAL_SEVERITY_OPTIONS } from '@/graphql/mutations'
import { PageContainer } from '@/components/PageContainer'
import { PageTitle } from '@/components/PageTitle'
import { SectionCard } from '@/components/ui/SectionCard'
import { FieldLabel, Input, Select } from '@/components/ui/FormControls'
import { Button } from '@/components/Button'
import { Skeleton } from '@/components/ui/skeleton'
import { QueryError } from '@/components/QueryError'
import { colors } from '@/lib/tokens'
import { applicaLinguaDelCliente, linguaSceltaDallUtente } from '@/i18n/tenantLanguage'
import { useDomainVocabularies } from '@/contexts/DomainVocabularyContext'
import { SeverityBadge } from '@/components/ui/badges'

interface LanguageSettings { available: string[]; defaultLanguage: string | null; fallback: string }
interface TimezoneSettings { timezone: string | null; available: string[] }

export function OrganizationPage() {
  const { t } = useTranslation()
  const uid = useId()
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

      <TimezoneSection />
      <ServiceCalendarSection />
      <PortalSeveritySection languages={impostazioni?.available ?? null} />
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

interface ServiceCalendar { days: number[]; start: string; end: string; holidays: string[] }

/** L'ordine con cui si leggono i giorni: da lunedì. Il valore è quello di `Date.getDay()` (0 = domenica). */
const WEEK = [1, 2, 3, 4, 5, 6, 0] as const
const WEEKDAY_KEYS: Record<number, string> = {
  0: 'pages.organization.weekday.sunday', 1: 'pages.organization.weekday.monday', 2: 'pages.organization.weekday.tuesday',
  3: 'pages.organization.weekday.wednesday', 4: 'pages.organization.weekday.thursday', 5: 'pages.organization.weekday.friday',
  6: 'pages.organization.weekday.saturday',
}

/**
 * Il calendario di servizio (revisione del 14 set 2026 · F6): i giorni, la
 * fascia oraria e le festività in cui contano le policy SLA e i contratti OLA
 * «in orario lavorativo». Prima erano le 08–18 dal lunedì al venerdì, uguali
 * per tutti e senza festività.
 */
function ServiceCalendarSection() {
  const { t } = useTranslation()
  const uid = useId()
  const { data, loading, error, refetch } = useQuery<{ tenantServiceCalendar: ServiceCalendar | null }>(
    GET_TENANT_SERVICE_CALENDAR, { fetchPolicy: 'cache-and-network' },
  )
  const saved = data?.tenantServiceCalendar ?? null
  const [days, setDays] = useState<number[]>([])
  const [start, setStart] = useState('')
  const [end, setEnd] = useState('')
  const [holidays, setHolidays] = useState('')

  useEffect(() => {
    if (!data) return
    setDays(saved?.days ?? [])
    setStart(saved?.start ?? '')
    setEnd(saved?.end ?? '')
    setHolidays((saved?.holidays ?? []).join(', '))
  }, [data, saved])

  const [saveCalendar, { loading: saving }] = useMutation(SET_TENANT_SERVICE_CALENDAR, {
    refetchQueries: [GET_TENANT_SERVICE_CALENDAR],
    onCompleted: () => { toast.success(t('pages.organization.calendarSaved')) },
    onError: (e) => toast.error(e.message),
  })

  const toggleDay = (d: number) => setDays((cur) => (cur.includes(d) ? cur.filter((x) => x !== d) : [...cur, d]))
  const submit = () => {
    const list = holidays.split(/[\s,;]+/).map((h) => h.trim()).filter(Boolean)
    void saveCalendar({ variables: { calendar: { days: [...days].sort((a, b) => a - b), start, end, holidays: list } } })
  }

  return (
    <div style={{ marginTop: 16 }}>
      <SectionCard collapsible={false} title={t('pages.organization.calendarTitle')}>
        <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 14 }}>
          <p style={{ margin: 0, color: colors.slateLight, fontSize: 'var(--font-size-body)', lineHeight: 1.55 }}>
            {t('pages.organization.calendarDescription')}
          </p>
          {error && !data ? <QueryError message={error.message} onRetry={() => void refetch()} /> : null}
          {!data && loading ? <Skeleton style={{ height: 38, maxWidth: 320 }} /> : null}
          {data && (
            <>
              {saved === null && (
                <p role="status" style={{ margin: 0, color: 'var(--color-danger)', fontSize: 'var(--font-size-label)' }}>
                  {t('pages.organization.calendarMissing')}
                </p>
              )}
              <fieldset style={{ border: 'none', margin: 0, padding: 0 }}>
                <legend style={{ fontSize: 'var(--font-size-label)', fontWeight: 600, color: 'var(--color-slate)', marginBottom: 6 }}>
                  {t('pages.organization.calendarDays')}
                </legend>
                <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                  {WEEK.map((d) => (
                    <label key={d} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 'var(--font-size-body)' }}>
                      <input type="checkbox" checked={days.includes(d)} onChange={() => toggleDay(d)} />
                      {t(WEEKDAY_KEYS[d]!)}
                    </label>
                  ))}
                </div>
              </fieldset>
              <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
                <div>
                  <FieldLabel htmlFor={`${uid}-start`}>{t('pages.organization.calendarStart')}</FieldLabel>
                  <Input id={`${uid}-start`} type="time" value={start} onChange={(e) => setStart(e.target.value)} style={{ width: 140 }} />
                </div>
                <div>
                  <FieldLabel htmlFor={`${uid}-end`}>{t('pages.organization.calendarEnd')}</FieldLabel>
                  <Input id={`${uid}-end`} type="time" value={end} onChange={(e) => setEnd(e.target.value)} style={{ width: 140 }} />
                </div>
              </div>
              <div>
                <FieldLabel htmlFor={`${uid}-holidays`}>{t('pages.organization.calendarHolidays')}</FieldLabel>
                <Input id={`${uid}-holidays`} value={holidays} placeholder="2026-12-25, 2026-12-26" onChange={(e) => setHolidays(e.target.value)} style={{ maxWidth: 520 }} />
                <p style={{ color: colors.slateLight, margin: '6px 0 0', fontSize: 'var(--font-size-label)', lineHeight: 1.5 }}>
                  {t('pages.organization.calendarHolidaysHint')}
                </p>
              </div>
              <div>
                <Button onClick={submit} disabled={saving}>{t('pages.organization.calendarSave')}</Button>
              </div>
            </>
          )}
        </div>
      </SectionCard>
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
