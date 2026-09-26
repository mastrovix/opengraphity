import { Button } from '@/components/Button'
import type { LucideIcon } from 'lucide-react'
import { Trans, useTranslation } from 'react-i18next'
import { CIIcon } from '@/lib/ciIcon'
import { CI_ICON_KEYS } from '@/lib/ciIconPaths'
import { FormField } from './citype/CIFieldInlineEditor'
import { Input, Select, Textarea } from '@/components/ui/FormControls'
import type { SettingsFormState } from './useITILTypeDesigner'
import { ColorField } from '@/components/ui/ColorField'

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
          value={settingsForm.label}
          onChange={(e) => setSettingsForm((p) => p && ({ ...p, label: e.target.value }))}
        />
      </FormField>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 12, marginBottom: 14 }}>
        <FormField label={t('citypeDesigner.icon')}>
          <Select
            value={settingsForm.icon}
            onChange={(e) => setSettingsForm((p) => p && ({ ...p, icon: e.target.value }))}
          >
            <option value="">{t('citypeDesigner.noIcon')}</option>
            {CI_ICON_KEYS.map((i) => <option key={i} value={i}>{i}</option>)}
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
        <Textarea
          aria-label={t('citypeDesigner.validationScript')}
          value={settingsForm.validationScript}
          onChange={(e) => setSettingsForm((p) => p && ({ ...p, validationScript: e.target.value }))}
          placeholder={t('itilDesigner.validationPlaceholder')}
          style={{ minHeight: 100 }}
        />
      </FormField>

      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <Button variant="primary"
          disabled={settingsSaving}
          onClick={() => onSaveSettings()}
        >
          {settingsSaving ? t('common.saving') : t('citypeDesigner.saveSettings')}
        </Button>
      </div>
    </div>
  )
}
