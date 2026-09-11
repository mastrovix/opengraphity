/**
 * Riquadro «Come si calcola» del dettaglio servizio. Per tutti è la lettura
 * in parole delle regole d'impatto; per gli amministratori (ondata 2) è un
 * modulo: soglia giù, soglia degradato, minimo di componenti, che fare dei
 * componenti senza salute e da dove aprire un incident per servizio.
 *
 * Stesso schema della Policy eventi: un aiuto sotto ogni campo, stato
 * «Modifiche non salvate» annunciato (`role="status"`), Salva e Ripristina
 * attivi solo con modifiche, validazione in pagina (interi, scala, «soglia
 * degradato ≤ soglia giù») che blocca il salvataggio.
 *
 * Concorrenza: la mutation porta `expectedVersion` = la versione letta. Se un
 * altro amministratore ha salvato nel frattempo l'API rifiuta e qui compare
 * una riga `role="alert"` con il messaggio del server e «Ricarica» — mai una
 * sovrascrittura silenziosa.
 *
 * Un valore fuori vocabolario salvato sulla mappa (`unknownNodes`,
 * `openIncidentFrom`, `duringStorm`) resta scelto nel select come
 * «Sconosciuto (<valore>)»: non viene corretto di nascosto.
 *
 * Revisione 2 (D6.4): il selettore «Durante una tempesta della sorgente»
 * (`duringStorm`) — sospendi la valutazione (default) o valuta comunque.
 */
import { useEffect, useId, useMemo, useState } from 'react'
import { useMutation } from '@apollo/client/react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { Loader2, RotateCcw } from 'lucide-react'
import { Button } from '@/components/Button'
import { Input, Select, FieldLabel } from '@/components/ui/FormControls'
import { SectionCard } from '@/components/ui/SectionCard'
import { errorMessage } from '@/hooks/useMutationWithToast'
import { UPDATE_SERVICE_IMPACT_RULES } from '@/graphql/mutations'
import { colors, palette } from '@/lib/tokens'
import { ServiceImpactPreviewLine } from './ServiceImpactPreviewLine'
import {
  MIN_NODES_MAX, MIN_NODES_MIN, SHARE_PCT_MAX, SHARE_PCT_MIN,
  SERVICE_OPEN_INCIDENT_FROMS, UNKNOWN_NODES_MODES, DURING_STORM_MODES,
  type ServiceImpactRules, type ServiceImpactRulesInput, type ServiceMapDetail,
} from '@/types/services'

/** I campi a scelta singola delle regole: stesso trattamento (opzioni, aiuto, valore fuori vocabolario). */
type ChoiceField = 'unknownNodes' | 'openIncidentFrom' | 'duringStorm'

type NumField = 'downSharePct' | 'degradedSharePct' | 'minNodes'

const RANGE: Record<NumField, { min: number; max: number }> = {
  downSharePct:     { min: SHARE_PCT_MIN, max: SHARE_PCT_MAX },
  degradedSharePct: { min: SHARE_PCT_MIN, max: SHARE_PCT_MAX },
  minNodes:         { min: MIN_NODES_MIN, max: MIN_NODES_MAX },
}
const NUM_FIELDS = Object.keys(RANGE) as NumField[]

export type RuleError = { key: 'integer' | 'range' | 'degradedOverDown' | 'aboveComponents'; min: number; max: number }
export type RuleErrors = Partial<Record<NumField, RuleError>>

/**
 * Errori per campo: intero dentro la scala, più i due vincoli di coerenza che
 * l'API impone — «soglia degradato ≤ soglia giù» (altrimenti «degradato» non
 * si raggiunge mai prima di «giù») e «minimo di componenti ≤ componenti della
 * mappa» (altrimenti il servizio non può mai degradarsi). Vuoto = si può salvare.
 */
export function validateRulesForm(form: ServiceImpactRulesInput, maxMinNodes = MIN_NODES_MAX): RuleErrors {
  const errors: RuleErrors = {}
  for (const key of NUM_FIELDS) {
    const { min, max } = RANGE[key]
    const value = form[key]
    if (!Number.isInteger(value))            errors[key] = { key: 'integer', min, max }
    else if (value < min || value > max)     errors[key] = { key: 'range', min, max }
  }
  if (!errors.degradedSharePct && !errors.downSharePct && form.degradedSharePct > form.downSharePct) {
    errors.degradedSharePct = { key: 'degradedOverDown', ...RANGE.degradedSharePct }
  }
  if (!errors.minNodes && form.minNodes > maxMinNodes) {
    errors.minNodes = { key: 'aboveComponents', min: RANGE.minNodes.min, max: maxMinNodes }
  }
  return errors
}

/** Le regole della mappa senza `version`: la forma che si rimanda all'API. */
function toForm(rules: ServiceImpactRules): ServiceImpactRulesInput {
  return {
    downSharePct:     rules.downSharePct,
    degradedSharePct: rules.degradedSharePct,
    minNodes:         rules.minNodes,
    unknownNodes:     rules.unknownNodes,
    openIncidentFrom: rules.openIncidentFrom,
    duringStorm:      rules.duringStorm,
  }
}

/** Opzioni del select: il vocabolario più, se serve, il valore salvato fuori vocabolario. */
function optionsWith(vocabulary: readonly string[], current: string): string[] {
  return vocabulary.includes(current) ? [...vocabulary] : [...vocabulary, current]
}

function optionLabel(t: TFunction, group: ChoiceField, value: string, vocabulary: readonly string[]): string {
  return vocabulary.includes(value)
    ? t(`monitoring.services.rulesEdit.${group}Options.${value}`)
    : t('monitoring.services.health.outOfVocabulary', { value })
}

const hint: React.CSSProperties = { margin: '4px 0 0', fontSize: 'var(--font-size-label)', color: colors.slateLight, lineHeight: 1.5 }

interface Props {
  map: ServiceMapDetail
  /** Solo gli amministratori vedono i controlli; per gli altri il riquadro resta la lettura in parole. */
  canEdit: boolean
  /** Rilegge la mappa dopo un conflitto di versione. */
  onReload: () => void
}

export function ServiceRulesCard({ map, canEdit, onReload }: Props) {
  const { t } = useTranslation()
  const uid = useId()
  const fid = (name: string) => `${uid}-${name}`

  const [update, { loading: saving }] = useMutation<{ updateServiceImpactRules: ServiceMapDetail }>(UPDATE_SERVICE_IMPACT_RULES)
  const [saveError, setSaveError] = useState<string | null>(null)

  // Chiave stabile delle regole salvate: il polling ogni 15 s rinnova l'oggetto
  // della cache, ma finché i valori non cambiano le modifiche non salvate restano.
  const baselineKey = JSON.stringify(toForm(map.rules))
  const baseline = useMemo(() => JSON.parse(baselineKey) as ServiceImpactRulesInput, [baselineKey])
  const [form, setForm] = useState<ServiceImpactRulesInput>(baseline)
  useEffect(() => { setForm(JSON.parse(baselineKey) as ServiceImpactRulesInput); setSaveError(null) }, [baselineKey])

  // Il minimo di componenti non può superare i componenti della mappa: è il
  // limite che applica anche l'API, detto qui prima di provare a salvare.
  const maxMinNodes = Math.max(1, map.nodeCount)
  const errors  = validateRulesForm(form, maxMinNodes)
  const invalid = Object.keys(errors).length > 0
  const dirty   = JSON.stringify(form) !== baselineKey

  const set = <K extends keyof ServiceImpactRulesInput>(key: K, value: ServiceImpactRulesInput[K]) => setForm((f) => ({ ...f, [key]: value }))
  // Campo vuoto → NaN (non 0): la validazione lo segnala invece di salvare uno zero mai scritto.
  const setNum = (key: NumField) => (e: React.ChangeEvent<HTMLInputElement>) =>
    set(key, e.target.value.trim() === '' ? Number.NaN : Number(e.target.value))

  async function save() {
    if (invalid || !dirty) return
    setSaveError(null)
    try {
      const res = await update({ variables: { id: map.id, expectedVersion: map.version, rules: form } })
      if (!res.data?.updateServiceImpactRules) throw new Error(t('monitoring.services.detail.noResult', { operation: 'updateServiceImpactRules' }))
    } catch (e) {
      setSaveError(errorMessage(e))
    }
  }

  const helpId  = (key: keyof ServiceImpactRulesInput) => `${fid(key)}-help`
  const errorId = (key: NumField) => `${fid(key)}-error`

  const numberField = (key: NumField) => {
    const err = errors[key]
    const max = key === 'minNodes' ? maxMinNodes : RANGE[key].max
    return (
      <div>
        <FieldLabel htmlFor={fid(key)}>{t(`monitoring.services.rulesEdit.${key}`)}</FieldLabel>
        <Input
          id={fid(key)} type="number" step={1} min={RANGE[key].min} max={max}
          value={Number.isNaN(form[key]) ? '' : String(form[key])}
          onChange={setNum(key)} disabled={saving}
          aria-invalid={err ? true : undefined}
          aria-describedby={[err ? errorId(key) : null, helpId(key)].filter(Boolean).join(' ')}
        />
        {err && (
          <p id={errorId(key)} role="alert" style={{ ...hint, color: colors.danger, fontWeight: 500 }}>
            {t(`monitoring.services.rulesEdit.validation.${err.key}`, { min: err.min, max: err.max })}
          </p>
        )}
        <p id={helpId(key)} style={hint}>{t(`monitoring.services.rulesEdit.help.${key}`)}</p>
      </div>
    )
  }

  const selectField = (key: ChoiceField, vocabulary: readonly string[]) => (
    <div>
      <FieldLabel htmlFor={fid(key)}>{t(`monitoring.services.rulesEdit.${key}`)}</FieldLabel>
      <Select id={fid(key)} value={form[key]} onChange={(e) => set(key, e.target.value)} disabled={saving} aria-describedby={helpId(key)}>
        {optionsWith(vocabulary, form[key]).map((v) => <option key={v} value={v}>{optionLabel(t, key, v, vocabulary)}</option>)}
      </Select>
      <p id={helpId(key)} style={hint}>{t(`monitoring.services.rulesEdit.help.${key}`)}</p>
    </div>
  )

  if (!canEdit) {
    return (
      <SectionCard title={t('monitoring.services.detail.rules')} defaultOpen>
        <ReadOnlyRules rules={map.rules} />
      </SectionCard>
    )
  }

  return (
    <SectionCard title={t('monitoring.services.detail.rules')} defaultOpen>
      <div data-testid="service-rules-form" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {numberField('downSharePct')}
        {numberField('degradedSharePct')}
        {numberField('minNodes')}
        {selectField('unknownNodes', UNKNOWN_NODES_MODES)}
        {selectField('openIncidentFrom', SERVICE_OPEN_INCIDENT_FROMS)}
        <p style={{ ...hint, marginTop: 0 }}>{t('monitoring.services.rulesEdit.openIncidentNote')}</p>
        {/* D6.4: una tempesta è di norma un guasto della raccolta, non N guasti reali: di default la valutazione si sospende. */}
        {selectField('duringStorm', DURING_STORM_MODES)}

        {saveError && (
          <div role="alert" style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', padding: '8px 12px', borderRadius: 8, background: palette.danger.bg, border: `1px solid ${palette.danger.border}`, color: palette.danger.text, fontSize: 'var(--font-size-body)' }}>
            <span>{t('monitoring.services.rulesEdit.saveFailed', { error: saveError })}</span>
            <Button variant="secondary" size="xs" onClick={onReload}>{t('monitoring.services.rulesEdit.reload')}</Button>
          </div>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <span role="status" data-testid="rules-dirty" style={{ fontSize: 'var(--font-size-body)', color: invalid ? colors.danger : dirty ? palette.warning.text : colors.slateLight }}>
            {invalid ? t('monitoring.services.rulesEdit.blocked') : dirty ? t('monitoring.services.rulesEdit.unsaved') : t('monitoring.services.rulesEdit.noChanges')}
          </span>
          <Button variant="secondary" size="xs" disabled={saving || !dirty} icon={<RotateCcw size={13} aria-hidden="true" />} onClick={() => setForm(baseline)}>
            {t('common.reset')}
          </Button>
          <Button size="xs" disabled={saving || invalid || !dirty} icon={saving ? <Loader2 size={13} className="animate-spin" aria-hidden="true" /> : undefined} onClick={() => void save()}>
            {t('common.save')}
          </Button>
        </div>

        {/* Anteprima con le regole in corso di modifica: nessuna scrittura. */}
        {!invalid && <ServiceImpactPreviewLine mapId={map.id} rules={form} testId="rules-preview" />}

        <p style={{ ...hint, marginTop: 0 }}>{t('monitoring.services.detail.rulesVersion', { version: map.rules.version })}</p>
      </div>
    </SectionCard>
  )
}

/** Le regole in parole (sola lettura): la stessa lista dell'ondata 1. */
function ReadOnlyRules({ rules }: { rules: ServiceImpactRules }) {
  const { t } = useTranslation()
  return (
    <>
      <ul style={{ margin: 0, paddingLeft: 18, fontSize: 'var(--font-size-body)', color: colors.slateDark, lineHeight: 1.7 }}>
        <li>{t('monitoring.services.detail.rulesFields.downSharePct', { pct: rules.downSharePct })}</li>
        <li>{t('monitoring.services.detail.rulesFields.degradedSharePct', { pct: rules.degradedSharePct })}</li>
        <li>{t('monitoring.services.detail.rulesFields.minNodes', { count: rules.minNodes })}</li>
        <li>{t('monitoring.services.detail.rulesFields.unknownNodes', { value: readOnlyLabel(t, 'unknownNodes', rules.unknownNodes, UNKNOWN_NODES_MODES) })}</li>
        <li>{t('monitoring.services.detail.rulesFields.openIncidentFrom', { value: readOnlyLabel(t, 'openIncidentFrom', rules.openIncidentFrom, SERVICE_OPEN_INCIDENT_FROMS) })}</li>
        <li>{t('monitoring.services.detail.rulesFields.duringStorm', { value: readOnlyLabel(t, 'duringStorm', rules.duringStorm, DURING_STORM_MODES) })}</li>
      </ul>
      <p style={{ margin: '8px 0 0', fontSize: 'var(--font-size-table)', color: colors.slateLight }}>
        {t('monitoring.services.detail.rulesVersion', { version: rules.version })}
      </p>
    </>
  )
}

/**
 * Etichetta dentro la frase di sola lettura («Componenti senza salute:
 * ignorati»): minuscola, diversa da quella del select. Fuori vocabolario →
 * «Sconosciuto (<valore>)», mai il valore taciuto.
 */
function readOnlyLabel(t: TFunction, group: ChoiceField, value: string, vocabulary: readonly string[]): string {
  return vocabulary.includes(value)
    ? t(`monitoring.services.detail.rulesFields.${group}Values.${value}`)
    : t('monitoring.services.health.outOfVocabulary', { value })
}
