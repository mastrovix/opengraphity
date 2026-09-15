/**
 * Selettore di colore per i designer (tipi CI, tipi ITIL). Accetta anche un
 * token CSS salvato (`var(--color-brand)`): il selettore mostra il colore
 * risolto e la didascalia dice che è quello del marchio e segue il tema
 * (giro UI del 15 set 2026 · U-15). Scegliere un colore salva quel colore.
 */
import { useTranslation } from 'react-i18next'
import { colorInputValue, isColorToken } from '@/lib/colorInput'

export function ColorField({ id, value, onChange }: { id?: string; value: string; onChange: (hex: string) => void }) {
  const { t } = useTranslation()
  const hex = colorInputValue(value)
  const token = isColorToken(value)
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <input
        id={id}
        type="color"
        value={hex ?? ''}
        onChange={(e) => onChange(e.target.value)}
        style={{ width: 36, height: 36, border: 'none', borderRadius: 4, cursor: 'pointer', padding: 0 }}
      />
      <span data-testid="color-field-caption" style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate)' }}>
        {token ? t('components.colorField.token', { token: value }) : value}
        {hex === null && !token && value !== '' && ` — ${t('components.colorField.unreadable')}`}
      </span>
    </div>
  )
}
