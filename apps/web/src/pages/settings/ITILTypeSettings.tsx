import type { LucideIcon } from 'lucide-react'
import { CIIcon } from '@/lib/ciIcon'
import { FormField } from './citype/CIFieldInlineEditor'
import { inputS, selectS, textareaS, btnPrimary } from './shared/designerStyles'
import type { SettingsFormState } from './useITILTypeDesigner'

const ICONS = ['box', 'database', 'server', 'shield', 'hard-drive', 'cloud', 'globe', 'cpu', 'network', 'monitor', 'lock', 'alert-circle', 'bug', 'git-pull-request', 'inbox']

export interface ITILTypeSettingsProps {
  settingsForm:    SettingsFormState
  setSettingsForm: React.Dispatch<React.SetStateAction<SettingsFormState | null>>
  settingsSaving:  boolean
  onSaveSettings:  () => void
  FallbackIcon:    LucideIcon
}

export function ITILTypeSettings({ settingsForm, setSettingsForm, settingsSaving, onSaveSettings, FallbackIcon }: ITILTypeSettingsProps) {
  return (
    <div style={{ maxWidth: 480 }}>
      <FormField label="Label">
        <input
          style={inputS}
          value={settingsForm.label}
          onChange={(e) => setSettingsForm((p) => p && ({ ...p, label: e.target.value }))}
        />
      </FormField>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 12, marginBottom: 14 }}>
        <FormField label="Icona">
          <select
            style={selectS}
            value={settingsForm.icon}
            onChange={(e) => setSettingsForm((p) => p && ({ ...p, icon: e.target.value }))}
          >
            <option value="">— nessuna —</option>
            {ICONS.map((i) => <option key={i} value={i}>{i}</option>)}
          </select>
        </FormField>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', paddingTop: 20 }}>
          {settingsForm.icon ? (
            <CIIcon icon={settingsForm.icon} size={24} color={settingsForm.color || 'var(--color-brand)'} />
          ) : (
            <FallbackIcon size={24} color={settingsForm.color || 'var(--color-brand)'} />
          )}
        </div>
      </div>

      <FormField label="Colore">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <input
            type="color"
            value={settingsForm.color}
            onChange={(e) => setSettingsForm((p) => p && ({ ...p, color: e.target.value }))}
            style={{ width: 36, height: 36, border: 'none', borderRadius: 4, cursor: 'pointer', padding: 0 }}
          />
          <span style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate)' }}>{settingsForm.color}</span>
        </div>
      </FormField>

      <FormField label="Validation script (opzionale)">
        <p style={{ fontSize: 'var(--font-size-body)', color: '#94a3b8', margin: '0 0 6px' }}>
          Variabili: <code>input</code>. Usa <code>throw 'msg'</code> per errore globale.
        </p>
        <textarea
          style={{ ...textareaS, minHeight: 100 }}
          value={settingsForm.validationScript}
          onChange={(e) => setSettingsForm((p) => p && ({ ...p, validationScript: e.target.value }))}
          placeholder={"// Esempio:\nif (!input.title) throw 'Titolo obbligatorio'"}
        />
      </FormField>

      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <button
          style={{ ...btnPrimary, opacity: settingsSaving ? 0.6 : 1 }}
          disabled={settingsSaving}
          onClick={() => void onSaveSettings()}
        >
          {settingsSaving ? 'Salvataggio…' : 'Salva impostazioni'}
        </button>
      </div>
    </div>
  )
}
