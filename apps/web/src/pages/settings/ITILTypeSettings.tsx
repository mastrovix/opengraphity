import type { LucideIcon } from 'lucide-react'
import { Trans, useTranslation } from 'react-i18next'
import { CIIcon } from '@/lib/ciIcon'
import { FormField } from './citype/CIFieldInlineEditor'
import { inputS, selectS, textareaS, btnPrimary } from './shared/designerStyles'
import { Input, Select } from '@/components/ui/FormControls'
import type { SettingsFormState } from './useITILTypeDesigner'
import { ColorField } from '@/components/ui/ColorField'

const ICONS = ['box', 'database', 'server', 'shield', 'hard-drive', 'cloud', 'globe', 'cpu', 'network', 'monitor', 'lock', 'alert-circle', 'bug', 'git-pull-request', 'inbox']

export interface ITILTypeSettingsProps {
  settingsForm:    SettingsFormState
  setSettingsForm: React.Dispatch<React.SetStateAction<SettingsFormState | null>>
  settingsSaving:  boolean
  onSaveSettings:  () => void
  FallbackIcon:    LucideIcon
}

export function ITILTypeSettings({ settingsForm, setSettingsForm, settingsSaving, onSaveSettings, FallbackIcon }: ITILTypeSettingsProps) {
  const { t } = useTranslation()
  return (
    <div style={{ maxWidth: 480 }}>
      <FormField label={t('common.label')}>
        <Input
          style={inputS}
          value={settingsForm.label}
          onChange={(e) => setSettingsForm((p) => p && ({ ...p, label: e.target.value }))}
        />
      </FormField>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 12, marginBottom: 14 }}>
        <FormField label={t('citypeDesigner.icon')}>
          <Select
            style={selectS}
            value={settingsForm.icon}
            onChange={(e) => setSettingsForm((p) => p && ({ ...p, icon: e.target.value }))}
          >
            <option value="">{t('citypeDesigner.noIcon')}</option>
            {ICONS.map((i) => <option key={i} value={i}>{i}</option>)}
          </Select>
        </FormField>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', paddingTop: 20 }}>
          {settingsForm.icon ? (
            <CIIcon icon={settingsForm.icon} size={24} color={settingsForm.color || 'var(--color-brand)'} />
          ) : (
            <FallbackIcon size={24} color={settingsForm.color || 'var(--color-brand)'} />
          )}
        </div>
      </div>

      <FormField label={t('citypeDesigner.color')}>
        <ColorField label={t('citypeDesigner.color')} value={settingsForm.color} onChange={(hex) => setSettingsForm((p) => p && ({ ...p, color: hex }))} />
      </FormField>

      <FormField label={t('citypeDesigner.validationScript')}>
        <p style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate-light)', margin: '0 0 6px' }}>
          <Trans i18nKey="citypeDesigner.validationScriptHint" components={{ code: <code /> }} />
        </p>
        <textarea
          aria-label={t('citypeDesigner.validationScript')}
          style={{ ...textareaS, minHeight: 100 }}
          value={settingsForm.validationScript}
          onChange={(e) => setSettingsForm((p) => p && ({ ...p, validationScript: e.target.value }))}
          placeholder={t('itilDesigner.validationPlaceholder')}
        />
      </FormField>

      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <button type="button"
          style={{ ...btnPrimary, opacity: settingsSaving ? 0.6 : 1 }}
          disabled={settingsSaving}
          onClick={() => void onSaveSettings()}
        >
          {settingsSaving ? t('common.saving') : t('citypeDesigner.saveSettings')}
        </button>
      </div>
    </div>
  )
}
