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
import { useId } from 'react'
import { useQuery, useMutation } from '@apollo/client/react'
import { useTranslation } from 'react-i18next'
import { Building2 } from 'lucide-react'
import { toast } from 'sonner'
import { GET_TENANT_LANGUAGE_SETTINGS } from '@/graphql/queries'
import { SET_TENANT_DEFAULT_LANGUAGE } from '@/graphql/mutations'
import { PageContainer } from '@/components/PageContainer'
import { PageTitle } from '@/components/PageTitle'
import { SectionCard } from '@/components/ui/SectionCard'
import { FieldLabel, Select } from '@/components/ui/FormControls'
import { Skeleton } from '@/components/ui/skeleton'
import { QueryError } from '@/components/QueryError'
import { colors } from '@/lib/tokens'
import { applicaLinguaDelCliente, linguaSceltaDallUtente } from '@/i18n/tenantLanguage'

interface LanguageSettings { available: string[]; defaultLanguage: string | null; fallback: string }

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
    </PageContainer>
  )
}
