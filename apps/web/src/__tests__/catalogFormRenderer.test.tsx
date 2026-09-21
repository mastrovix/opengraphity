/**
 * IL RENDERER DEI MODULI DEL CATALOGO (@opengraphity/web-core), provato da qui
 * perché è `apps/web` ad avere l'ambiente del browser nei test — ed è la stessa
 * cosa che rende il portale.
 *
 * Quello che questi test tengono fermo NON è il markup, è il comportamento che,
 * sbagliato, diventa un difetto di sicurezza o un modulo che non si può
 * compilare:
 *
 *  - un campo condizionale COMPARE quando la condizione diventa vera, e non
 *    prima. Se il renderer fosse più permissivo del server, chi compila
 *    vedrebbe un campo che l'API poi rifiuta; se fosse più restrittivo, un
 *    obbligatorio invisibile bloccherebbe l'invio senza spiegazioni.
 *  - dal PORTALE i campi non offerti agli utenti finali non ci sono affatto.
 *  - una sezione che resta senza campi visibili sparisce col suo titolo,
 *    invece di lasciare un'intestazione sospesa sul vuoto.
 *  - una nota non ha un controllo da compilare.
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { CatalogFormRenderer, type CatalogFormFieldView } from '@opengraphity/web-core'
import type { CatalogFormDefinition } from '@opengraphity/types'

const CAMPI: CatalogFormFieldView[] = [
  { name: 'ambiente', fieldType: 'enum', label: 'Ambiente', required: true, options: [{ value: 'production', label: 'Produzione' }, { value: 'test', label: 'Collaudo' }] },
  { name: 'costo', fieldType: 'number', label: 'Costo stimato', required: false },
  { name: 'note_interne', fieldType: 'text', label: 'Note interne', required: false },
  { name: 'avviso', fieldType: 'note', label: 'La consegna richiede cinque giorni.', required: false },
  { name: 'sistemi', fieldType: 'multi_enum', label: 'Sistemi', required: false, options: [{ value: 'posta', label: 'Posta' }, { value: 'crm', label: 'CRM' }] },
]

const MODULO: CatalogFormDefinition = {
  version: 1,
  revision: 2,
  sections: [
    {
      id: 'principale',
      title: { it: 'Il dispositivo', en: 'The device' },
      items: [
        { field: 'ambiente' },
        { field: 'costo', visibleWhen: { match: 'all', rules: [{ field: 'ambiente', op: 'eq', value: 'production' }] } },
        { field: 'avviso' },
        { field: 'sistemi' },
      ],
    },
    {
      // Una sezione con il SOLO campo riservato all'area di lavoro: dal portale
      // non deve restare il titolo da solo.
      id: 'interna',
      title: { it: 'Uso interno', en: 'Internal' },
      items: [{ field: 'note_interne', endUser: false }],
    },
  ],
}

function rendi(props: Partial<React.ComponentProps<typeof CatalogFormRenderer>> = {}) {
  const onChange = vi.fn()
  const utils = render(
    <CatalogFormRenderer
      definition={MODULO}
      fields={CAMPI}
      answers={{}}
      onChange={onChange}
      language="it"
      emptyChoiceLabel="—"
      yesLabel="Sì"
      noLabel="No"
      {...props}
    />,
  )
  return { onChange, ...utils }
}

describe('CatalogFormRenderer', () => {
  it('rende le sezioni con il titolo nella lingua chiesta e i campi visibili', () => {
    rendi()
    expect(screen.getByText('Il dispositivo')).toBeInTheDocument()
    expect(screen.getByLabelText(/Ambiente/)).toBeInTheDocument()
    expect(screen.getByText('La consegna richiede cinque giorni.')).toBeInTheDocument()
  })

  it('il campo condizionale non c\'è finché la condizione non è vera', () => {
    const { rerender } = rendi()
    expect(screen.queryByLabelText(/Costo stimato/)).not.toBeInTheDocument()

    rerender(
      <CatalogFormRenderer definition={MODULO} fields={CAMPI} answers={{ ambiente: 'production' }} onChange={vi.fn()} language="it" />,
    )
    expect(screen.getByLabelText(/Costo stimato/)).toBeInTheDocument()

    // Una risposta che non accende la condizione lo fa sparire di nuovo.
    rerender(
      <CatalogFormRenderer definition={MODULO} fields={CAMPI} answers={{ ambiente: 'test' }} onChange={vi.fn()} language="it" />,
    )
    expect(screen.queryByLabelText(/Costo stimato/)).not.toBeInTheDocument()
  })

  it('dal portale il campo non offerto agli utenti finali non c\'è, e la sua sezione sparisce col titolo', () => {
    rendi({ endUser: true })
    expect(screen.queryByLabelText(/Note interne/)).not.toBeInTheDocument()
    expect(screen.queryByText('Uso interno')).not.toBeInTheDocument()
    // Nell'area di lavoro invece ci sono entrambi.
    rendi()
    expect(screen.getByLabelText(/Note interne/)).toBeInTheDocument()
    expect(screen.getByText('Uso interno')).toBeInTheDocument()
  })

  it('una nota non ha un controllo da compilare', () => {
    rendi()
    expect(screen.queryByLabelText(/La consegna richiede/)).not.toBeInTheDocument()
  })

  it('riporta il valore scelto, e la selezione multipla come lista', async () => {
    const { onChange } = rendi()
    await userEvent.selectOptions(screen.getByLabelText(/Ambiente/), 'production')
    expect(onChange).toHaveBeenCalledWith('ambiente', 'production')

    await userEvent.click(screen.getByLabelText('CRM'))
    expect(onChange).toHaveBeenCalledWith('sistemi', ['crm'])
  })

  it('l\'obbligatorietà del modulo vince su quella della libreria, e l\'errore del server si vede sul campo', () => {
    const moduloConSovrascrittura: CatalogFormDefinition = {
      version: 1, revision: 1,
      sections: [{ id: 'a', title: {}, items: [{ field: 'costo', required: true }] }],
    }
    render(
      <CatalogFormRenderer
        definition={moduloConSovrascrittura} fields={CAMPI} answers={{}} onChange={vi.fn()}
        language="it" errors={{ costo: 'Il campo «Costo stimato» è obbligatorio.' }}
      />,
    )
    const campo = screen.getByLabelText(/Costo stimato/)
    expect(campo).toBeRequired()
    expect(campo).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByRole('alert')).toHaveTextContent('obbligatorio')
  })
})
