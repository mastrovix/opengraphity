/**
 * Shared condition row editor — used by AutoTriggersPage, BusinessRulesPage
 * and (via adapter di vocabolario) da WorkflowStepPanel.
 * Loads field definitions for the selected entity type, shows appropriate
 * operator options and value input based on field type.
 */
import { useQuery } from '@apollo/client/react'
import { GET_TEAMS } from '@/graphql/queries'
import { UserIdPicker } from '@/components/pickers/UserIdPicker'
import { useEntityFieldMetas, useFormFieldMetas, type FieldMeta } from '@/hooks/useEntityFields'
import { fieldTypeKey, operatorsForFieldType, NO_VALUE_OPERATORS, CHANGED_OPERATOR } from '@/lib/automationOperators'
import { inputS, selectS } from '@/pages/settings/shared/designerStyles'
import { Input, Select } from '@/components/ui/FormControls'
import { X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import i18n from '@/i18n/i18n'
import { colors } from '@/lib/tokens'
import { METAMODEL_FETCH_POLICY } from '@/lib/fetchPolicy'
import { useDomainVocabularies } from '@/contexts/DomainVocabularyContext'

// ── Types ────────────────────────────────────────────────────────────────────

export interface Condition {
  field:    string
  operator: string
  value:    string
}

interface Props {
  condition:  Condition
  entityType: string
  onChange:   (patch: Partial<Condition>) => void
  onRemove:  () => void
  /** `stack`: controlli in colonna, per pannelli stretti (designer workflow). */
  layout?:    'row' | 'stack'
  /** Offre «è cambiato» (V-19): solo per regole e trigger che scattano sugli aggiornamenti. */
  allowChanged?: boolean
}

const removeBtn: React.CSSProperties = {
  background: 'none', border: 'none', cursor: 'pointer', padding: 2,
  display: 'flex', alignItems: 'center',
}

// ── Component ────────────────────────────────────────────────────────────────

export function ConditionRowEditor({ condition, entityType, onChange, onRemove, layout = 'row', allowChanged = false }: Props) {
  const { t } = useTranslation()
  const { fields: metamodelFields, error: fieldsError } = useEntityFieldMetas(entityType)
  // I campi dei moduli del catalogo (ondata 5): il motore li leggeva già
  // (`properties(nodo)`), ma non c'era modo di scrivere la condizione. Un nome
  // che il metamodello ha già vince: è quello che il ticket scrive davvero.
  const formFields = useFormFieldMetas(entityType)
  const allFields = [...metamodelFields, ...formFields.filter((f) => !metamodelFields.some((m) => m.name === f.name))]
  const { data: teamsData } = useQuery<{ teams: { id: string; name: string }[] }>(GET_TEAMS, { fetchPolicy: METAMODEL_FETCH_POLICY })
  const { labelOf } = useDomainVocabularies()

  const selectedField = allFields.find(f => f.name === condition.field)
  const fieldType     = selectedField?.fieldType ?? 'string'
  const operators: { value: string; labelKey: string }[] = allowChanged ? [...operatorsForFieldType(fieldType), CHANGED_OPERATOR] : operatorsForFieldType(fieldType)
  const hideValue     = NO_VALUE_OPERATORS.has(condition.operator)
  const stack         = layout === 'stack'

  // Fail-visible: un campo/operatore persistito che l'editor non conosce
  // (es. `gte` di uno step di workflow, o un campo rimosso dal metamodello)
  // resta selezionato e marcato, invece di cadere in silenzio sulla prima opzione.
  const unknownField    = condition.field !== '' && allFields.length > 0 && !selectedField
  const unknownOperator = condition.operator !== '' && !operators.some(op => op.value === condition.operator)

  const fieldSelect = (
    <Select
      style={{ ...selectS, ...(stack ? { flex: 1 } : { width: 160 }), ...(unknownField ? { borderColor: 'var(--color-danger)', color: 'var(--color-danger)' } : {}) }}
      value={condition.field}
      onChange={e => onChange({ field: e.target.value, value: '' })}
      title={unknownField ? t('conditionEditor.unknownField', { field: condition.field }) : undefined}
    >
      <option value="">{t('conditionEditor.fieldPlaceholder')}</option>
      {unknownField && <option value={condition.field}>?{condition.field} ({t('conditionEditor.notInMetamodel')})</option>}
      {allFields.map(f => (
        <option key={f.name} value={f.name}>{f.label} ({t(fieldTypeKey(f.fieldType))})</option>
      ))}
    </Select>
  )

  const operatorSelect = (
    <Select
      style={{ ...selectS, ...(stack ? {} : { width: 110 }), ...(unknownOperator ? { borderColor: 'var(--color-danger)', color: 'var(--color-danger)' } : {}) }}
      value={condition.operator}
      onChange={e => onChange({ operator: e.target.value })}
      title={unknownOperator ? t('conditionEditor.unknownOperator', { operator: condition.operator }) : undefined}
    >
      {unknownOperator && <option value={condition.operator}>?{condition.operator} ({t('conditionEditor.unsupported')})</option>}
      {operators.map(op => <option key={op.value} value={op.value}>{t(op.labelKey)}</option>)}
    </Select>
  )

  const valueInput = !hideValue && renderValueInput(condition, selectedField, onChange, teamsData?.teams ?? [], labelOf)
  const removeButton = <button type="button" style={removeBtn} onClick={onRemove} title={t('conditionEditor.remove')} aria-label={t('conditionEditor.remove')}><X size={14} color={colors.danger} /></button>

  const errorLine = fieldsError && (
    <div style={{ fontSize: 'var(--font-size-label)', color: 'var(--color-danger)', marginBottom: 4 }}>
      {t('conditionEditor.fieldsUnavailable')}: {fieldsError}
    </div>
  )

  if (stack) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 6 }}>
        {errorLine}
        <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>{fieldSelect}{removeButton}</div>
        {operatorSelect}
        {valueInput}
      </div>
    )
  }

  return (
    <div style={{ marginBottom: 6 }}>
      {errorLine}
      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        {fieldSelect}
        {operatorSelect}
        {valueInput}
        {removeButton}
      </div>
    </div>
  )
}

function renderValueInput(
  condition: Condition,
  field: FieldMeta | undefined,
  onChange: (patch: Partial<Condition>) => void,
  teams: { id: string; name: string }[],
  /** L'etichetta di un valore di vocabolario, `null` quando non la conosciamo. */
  labelOf: (vocabolario: string, valore: string) => string | null,
) {
  if (!field) {
    return <Input style={{ ...inputS, flex: 1, minWidth: 80 }} placeholder={i18n.t('conditionEditor.value')} value={condition.value} onChange={e => onChange({ value: e.target.value })} />
  }

  // User → a search among the people who can be given tickets (review of 23
  // Sep 2026: a plain select of the whole directory, end users included).
  if (field.fieldType === 'user') {
    return (
      <UserIdPicker style={{ flex: 1 }} value={condition.value} onChange={(id) => onChange({ value: id })}
        permission="ticket.assignable" hint={i18n.t('pickers.users.assignable')} label={i18n.t('pickers.users.label')} />
    )
  }

  // Team → dropdown with teams
  if (field.fieldType === 'team') {
    return (
      <Select style={{ ...selectS, flex: 1 }} value={condition.value} onChange={e => onChange({ value: e.target.value })}>
        <option value="">{i18n.t('conditionEditor.teamPlaceholder')}</option>
        {teams.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
      </Select>
    )
  }

  /**
   * Enum → tendina. Anche la SCELTA MULTIPLA (moduli del catalogo, ondata 5):
   * la condizione confronta UNA scelta per volta («contiene produzione»),
   * quindi il valore è un valore del vocabolario come per l'enum. Scritto a
   * mano sarebbe una trappola: un `produzione` invece di `production` dà una
   * regola che non scatta mai, e nessuno se ne accorge.
   */
  if ((field.fieldType === 'enum' || field.fieldType === 'multi_enum') && field.enumValues.length > 0) {
    return (
      <Select style={{ ...selectS, flex: 1 }} value={condition.value} onChange={e => onChange({ value: e.target.value })}>
        <option value="">{i18n.t('conditionEditor.valuePlaceholder')}</option>
        {/* L'etichetta del valore, col valore nel title: è il valore che finisce nella condizione. */}
        {field.enumValues.map(v => (
          <option key={v} value={v} title={v}>
            {(field.enumTypeName ? labelOf(field.enumTypeName, v) : null) ?? v}
          </option>
        ))}
      </Select>
    )
  }

  // Boolean → Sì/No dropdown
  if (field.fieldType === 'boolean') {
    return (
      <Select style={{ ...selectS, flex: 1 }} value={condition.value} onChange={e => onChange({ value: e.target.value })}>
        <option value="">{i18n.t('conditionEditor.valuePlaceholder')}</option>
        <option value="true">{i18n.t('common.yes')}</option>
        <option value="false">{i18n.t('common.no')}</option>
      </Select>
    )
  }

  // Date → date picker
  if (field.fieldType === 'date') {
    return <Input type="date" style={{ ...inputS, flex: 1 }} value={condition.value} onChange={e => onChange({ value: e.target.value })} />
  }

  // Number → numeric input
  if (field.fieldType === 'number') {
    return <Input type="number" style={{ ...inputS, flex: 1, minWidth: 80 }} placeholder={i18n.t('conditionEditor.value')} value={condition.value} onChange={e => onChange({ value: e.target.value })} />
  }

  // String → text input
  return <Input style={{ ...inputS, flex: 1, minWidth: 80 }} placeholder={i18n.t('conditionEditor.value')} value={condition.value} onChange={e => onChange({ value: e.target.value })} />
}
