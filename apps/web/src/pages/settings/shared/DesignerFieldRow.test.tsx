/** Secondo giro UI del 15 set 2026 · V-6: «required», «Edit», «Delete <campo>» restavano in inglese. */
import { describe, it, expect, afterEach } from 'vitest'
import { screen } from '@testing-library/react'
import i18n from '@/i18n/i18n'
import { renderWithProviders } from '@/test/utils'
import { DesignerFieldRow } from './DesignerFieldRow'

afterEach(async () => { await i18n.changeLanguage('en') })

describe('DesignerFieldRow', () => {
  it('in italiano: obbligatorio, Modifica, Elimina <campo>', async () => {
    await i18n.changeLanguage('it')
    renderWithProviders(<DesignerFieldRow field={{ id: 'f', name: 'vendor_ref', label: 'Vendor reference', fieldType: 'string', required: true, isSystem: false }} onEdit={() => {}} onDelete={() => {}} />)
    expect(screen.getByText('obbligatorio')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Modifica' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Elimina vendor_ref' })).toBeInTheDocument()
    expect(screen.queryByText('required')).toBeNull()
  })
})
