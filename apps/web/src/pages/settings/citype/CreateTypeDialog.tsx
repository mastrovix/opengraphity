import { useEffect, useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Modal } from '@/components/Modal'
import { toast } from 'sonner'
import { CIIcon } from '@/lib/ciIcon'
import {
  inputS, selectS,
  btnPrimary, btnSecondary,
} from '../shared/designerStyles'
import { Input, Select } from '@/components/ui/FormControls'
import { FormField } from './CIFieldInlineEditor'
import { checkCITypeName, type KnownCIType } from '@/lib/ciTypeNames'
import { ColorField } from '@/components/ui/ColorField'

// ── Constants ─────────────────────────────────────────────────────────────────

const ICONS = ['box', 'database', 'server', 'shield', 'hard-drive', 'cloud', 'globe', 'cpu', 'network', 'monitor', 'lock']

// ── CreateTypeDialog ──────────────────────────────────────────────────────────

export function CreateTypeDialog({
  open, onClose, onSave, existingTypes = [],
}: {
  open: boolean; onClose: () => void
  onSave: (form: { name: string; label: string; icon: string; color: string }) => Promise<void>
  /** I tipi che ci sono già: servono a dire subito se il nome è preso (A-12). */
  existingTypes?: readonly KnownCIType[]
}) {
  const { t } = useTranslation()
  const id = useId()
  const [form, setForm] = useState({ name: '', label: '', icon: 'box', color: 'var(--color-brand)' })
  const [saving, setSaving] = useState(false)
  /**
   * Il modale RIPARTE VUOTO ogni volta che si apre (revisione totale · G-13):
   * è sempre montato, quindi riaprendo «Nuovo tipo» si ritrovavano nome ed
   * etichetta di quello appena creato, con l'avviso «nome già esistente»
   * addosso — e sembrava un difetto del salvataggio.
   */
  useEffect(() => {
    if (open) setForm({ name: '', label: '', icon: 'box', color: 'var(--color-brand)' })
  }, [open])
  const set = (k: string, v: string) => setForm((p) => ({ ...p, [k]: v }))

  // A-12: il nome non è un'etichetta, è un identificatore. Da qui nascono il
  // tipo GraphQL, le query, le mutation e la label Neo4j: un nome già preso
  // FONDEREBBE in silenzio il tipo nuovo con quello del prodotto. La difesa
  // vera è nell'API (un client con API key non passa dal web); qui si dice
  // subito, con lo stesso messaggio, invece di far cliccare «Crea».
  const nameError = form.name ? checkCITypeName(form.name, existingTypes) : null

  return (
    <Modal open={open} onClose={onClose} title={t('citypeDesigner.newCIType')} width={440}
      footer={
        <>
          <button type="button" style={btnSecondary} onClick={onClose}>{t('common.cancel')}</button>
          <button type="button" style={{ ...btnPrimary, opacity: saving || !!nameError ? 0.6 : 1 }} disabled={saving || !!nameError}
            onClick={async () => {
              if (!form.name || !form.label) { toast.error(t('toast.citype.nameLabelRequired')); return }
              if (nameError) { toast.error(nameError); return }
              setSaving(true)
              // onSave rigetta su errore (toast già mostrato): il dialog resta aperto.
              try { await onSave(form); onClose() } catch { /* errore già notificato */ } finally { setSaving(false) }
            }}>
            {saving ? t('common.creating') : t('citypeDesigner.createType')}
          </button>
        </>
      }>
      <FormField label={t('citypeDesigner.field.slugNameSnake')} htmlFor={`${id}-name`}>
        <Input id={`${id}-name`} style={inputS} value={form.name} placeholder={t('citypeDesigner.field.slugNamePlaceholder')}
          aria-invalid={nameError ? true : undefined}
          aria-describedby={nameError ? `${id}-name-error` : undefined}
          onChange={(e) => set('name', e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_'))} />
        {nameError && (
          <p id={`${id}-name-error`} role="alert" style={{ margin: '6px 0 0', fontSize: 'var(--font-size-body)', color: 'var(--color-danger)' }}>
            {nameError}
          </p>
        )}
      </FormField>
      <FormField label={t('citypeDesigner.field.displayLabel')} htmlFor={`${id}-label`}>
        <Input id={`${id}-label`} style={inputS} value={form.label} placeholder={t('citypeDesigner.labelPlaceholder')}
          onChange={(e) => set('label', e.target.value)} />
      </FormField>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 12, marginBottom: 14 }}>
        <FormField label={t('citypeDesigner.icon')} htmlFor={`${id}-icon`}>
          <Select id={`${id}-icon`} style={selectS} value={form.icon} onChange={(e) => set('icon', e.target.value)}>
            {ICONS.map((i) => <option key={i} value={i}>{i}</option>)}
          </Select>
        </FormField>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, paddingTop: 20 }}>
          <CIIcon icon={form.icon} size={24} color={form.color} />
        </div>
      </div>
      <FormField label={t('citypeDesigner.color')} htmlFor={`${id}-color`}>
        <ColorField id={`${id}-color`} value={form.color} onChange={(hex) => set('color', hex)} />
      </FormField>
    </Modal>
  )
}
