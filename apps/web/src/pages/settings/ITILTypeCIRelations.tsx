import { useTranslation } from 'react-i18next'
import { Plus, X, Check } from 'lucide-react'
import { inputS, selectS, labelS, btnPrimary, btnSecondary } from './shared/designerStyles'
import type { ITILCIRelationRule, RelFormState } from './useITILTypeDesigner'

const RELATION_SUGGESTIONS = ['IMPACTS', 'AFFECTED_BY', 'MODIFIES', 'TARGETS', 'ROOT_CAUSE', 'DEPENDS_ON', 'HOSTED_ON']

export interface ITILTypeCIRelationsProps {
  typeName:       string
  rules:          ITILCIRelationRule[]
  ciTypes:        { id: string; name: string; label: string }[]
  showRelForm:    boolean
  setShowRelForm: (v: boolean) => void
  relForm:        RelFormState
  setRelForm:     React.Dispatch<React.SetStateAction<RelFormState>>
  onCreateRule:   (variables: { itilType: string; ciType: string; relationType: string; direction: string; description: string | null }) => void
  onDeleteRule:   (id: string) => void
}

export function ITILTypeCIRelations({
  typeName, rules, ciTypes, showRelForm, setShowRelForm,
  relForm, setRelForm, onCreateRule, onDeleteRule,
}: ITILTypeCIRelationsProps) {
  const { t } = useTranslation()
  const usedCITypes = new Set(rules.map((r) => r.ciType.toLowerCase()))

  return (
    <div>
      {/* Add-relation inline form */}
      {showRelForm ? (
        <div style={{ background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 8, padding: 16, marginBottom: 16 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
            <div>
              <label style={labelS}>{t('itilDesigner.ciRelations.ciType')} *</label>
              <select style={selectS} value={relForm.ciType}
                onChange={(e) => setRelForm((f) => ({ ...f, ciType: e.target.value }))}>
                <option value="">{t('itilDesigner.ciRelations.selectCIType')}</option>
                {ciTypes
                  .filter((ct) => !usedCITypes.has(ct.name.toLowerCase()))
                  .map((ct) => (
                  <option key={ct.id} value={ct.name}>{ct.label}</option>
                ))}
              </select>
            </div>
            <div>
              <label style={labelS}>{t('itilDesigner.ciRelations.relationType')} *</label>
              <input style={inputS} list="rel-type-suggestions"
                value={relForm.relationType}
                onChange={(e) => setRelForm((f) => ({ ...f, relationType: e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '_') }))}
                placeholder="IMPACTS" />
              <datalist id="rel-type-suggestions">
                {RELATION_SUGGESTIONS.map((s) => <option key={s} value={s} />)}
              </datalist>
              <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 3 }}>{t('itilDesigner.ciRelations.suggestions')}</div>
            </div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
            <div>
              <label style={labelS}>{t('itilDesigner.ciRelations.direction')}</label>
              <select style={selectS} value={relForm.direction}
                onChange={(e) => setRelForm((f) => ({ ...f, direction: e.target.value }))}>
                <option value="outgoing">{t('itilDesigner.ciRelations.outgoing')}</option>
                <option value="incoming">{t('itilDesigner.ciRelations.incoming')}</option>
              </select>
            </div>
            <div>
              <label style={labelS}>{t('itilDesigner.ciRelations.description')}</label>
              <input style={inputS} value={relForm.description}
                onChange={(e) => setRelForm((f) => ({ ...f, description: e.target.value }))}
                placeholder="Es. Server impattati dall'incident" />
            </div>
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <button style={btnSecondary} onClick={() => setShowRelForm(false)}>
              <X size={13} /> {t('itilDesigner.ciRelations.cancel')}
            </button>
            <button style={btnPrimary}
              disabled={!relForm.ciType || !relForm.relationType}
              onClick={() => void onCreateRule({
                itilType:     typeName,
                ciType:       relForm.ciType,
                relationType: relForm.relationType,
                direction:    relForm.direction,
                description:  relForm.description || null,
              })}>
              <Check size={13} /> {t('itilDesigner.ciRelations.add')}
            </button>
          </div>
        </div>
      ) : (
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}>
          <button style={btnPrimary} onClick={() => setShowRelForm(true)}>
            <Plus size={13} /> {t('itilDesigner.ciRelations.addRelation')}
          </button>
        </div>
      )}

      {/* Rules table */}
      {rules.length === 0 ? (
        <p style={{ color: '#94a3b8', fontSize: 13 }}>{t('itilDesigner.ciRelations.empty')}</p>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ borderBottom: '2px solid #e5e7eb' }}>
              {[
                t('itilDesigner.ciRelations.ciType'),
                t('itilDesigner.ciRelations.relationType'),
                t('itilDesigner.ciRelations.direction'),
                t('itilDesigner.ciRelations.description'),
                '',
              ].map((h) => (
                <th key={h} style={{ textAlign: 'left', padding: '6px 8px', fontSize: 11, color: '#94a3b8', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rules.map((rule) => {
              const ciLabel = ciTypes.find((ct) => ct.name === rule.ciType)?.label ?? rule.ciType
              return (
                <tr key={rule.id} style={{ borderBottom: '1px solid #f3f4f6' }}>
                  <td style={{ padding: '8px' }}><span style={{ padding: '2px 8px', borderRadius: 4, background: '#eff6ff', color: '#2563eb', fontSize: 12, fontWeight: 500 }}>{ciLabel}</span></td>
                  <td style={{ padding: '8px', fontFamily: 'monospace', fontSize: 12, fontWeight: 600, color: 'var(--color-slate-dark)' }}>{rule.relationType}</td>
                  <td style={{ padding: '8px' }}>
                    <span style={{ padding: '2px 8px', borderRadius: 4, background: rule.direction === 'outgoing' ? '#f0fdf4' : '#fef9c3', color: rule.direction === 'outgoing' ? '#16a34a' : '#854d0e', fontSize: 11 }}>
                      {rule.direction === 'outgoing' ? '\u2192' : '\u2190'} {rule.direction}
                    </span>
                  </td>
                  <td style={{ padding: '8px', color: '#64748b', fontSize: 12 }}>{rule.description ?? '\u2014'}</td>
                  <td style={{ padding: '8px' }}>
                    <button
                      style={{ background: 'none', border: '1px solid #fecaca', borderRadius: 4, padding: '3px 8px', cursor: 'pointer', color: '#dc2626', fontSize: 12 }}
                      onClick={() => onDeleteRule(rule.id)}
                    ><X size={12} /></button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
    </div>
  )
}
