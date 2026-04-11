import { useState } from 'react'
import { Modal } from '@/components/Modal'
import { toast } from 'sonner'
import { CIIcon } from '@/lib/ciIcon'
import {
  inputS, selectS,
  btnPrimary, btnSecondary,
} from '../shared/designerStyles'
import { FormField } from './CIFieldInlineEditor'

// ── Constants ─────────────────────────────────────────────────────────────────

const ICONS = ['box', 'database', 'server', 'shield', 'hard-drive', 'cloud', 'globe', 'cpu', 'network', 'monitor', 'lock']

// ── CreateTypeDialog ──────────────────────────────────────────────────────────

export function CreateTypeDialog({
  open, onClose, onSave,
}: {
  open: boolean; onClose: () => void
  onSave: (form: { name: string; label: string; icon: string; color: string }) => Promise<void>
}) {
  const [form, setForm] = useState({ name: '', label: '', icon: 'box', color: 'var(--color-brand)' })
  const [saving, setSaving] = useState(false)
  const set = (k: string, v: string) => setForm((p) => ({ ...p, [k]: v }))

  return (
    <Modal open={open} onClose={onClose} title="Nuovo tipo CI" width={440}
      footer={
        <>
          <button style={btnSecondary} onClick={onClose}>Annulla</button>
          <button style={{ ...btnPrimary, opacity: saving ? 0.6 : 1 }} disabled={saving}
            onClick={async () => {
              if (!form.name || !form.label) { toast.error('Nome e label obbligatori'); return }
              setSaving(true)
              try { await onSave(form); onClose() } finally { setSaving(false) }
            }}>
            {saving ? 'Creazione…' : 'Crea tipo'}
          </button>
        </>
      }>
      <FormField label="name (slug, snake_case) *">
        <input style={inputS} value={form.name} placeholder="es. load_balancer"
          onChange={(e) => set('name', e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_'))} />
      </FormField>
      <FormField label="label (nome visualizzato) *">
        <input style={inputS} value={form.label} placeholder="es. Load Balancer"
          onChange={(e) => set('label', e.target.value)} />
      </FormField>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 12, marginBottom: 14 }}>
        <FormField label="Icona">
          <select style={selectS} value={form.icon} onChange={(e) => set('icon', e.target.value)}>
            {ICONS.map((i) => <option key={i} value={i}>{i}</option>)}
          </select>
        </FormField>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, paddingTop: 20 }}>
          <CIIcon icon={form.icon} size={24} color={form.color} />
        </div>
      </div>
      <FormField label="Colore">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <input type="color" value={form.color} onChange={(e) => set('color', e.target.value)}
            style={{ width: 36, height: 36, border: 'none', borderRadius: 4, cursor: 'pointer', padding: 0 }} />
          <span style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate)' }}>{form.color}</span>
        </div>
      </FormField>
    </Modal>
  )
}
