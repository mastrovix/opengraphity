/**
 * L'AIUTO DEGLI SCRIPT, da aprire dov'è la casella (18 set 2026).
 *
 * Chiesto dal proprietario dopo aver dovuto domandare due cose che il prodotto
 * non diceva da nessuna parte: «come faccio a referenziare un altro campo?» e
 * «e se devo settare il valore in un altro campo?». La risposta stava nel
 * codice del server e in una riga di aiuto sotto la casella — cioè non stava
 * dove serve, che è davanti a chi scrive lo script.
 *
 * Tre cose, in quest'ordine, perché è l'ordine in cui servono:
 *
 *  1. LE REGOLE che si sbagliano: si referenzia col NOME TECNICO e non con
 *     l'etichetta; un campo non ancora compilato arriva `null`; la formula
 *     RESTITUISCE, la validazione LANCIA.
 *  2. I CAMPI CHE PUOI LEGGERE, con nome ed etichetta: senza, per ritrovare un
 *     nome bisogna chiudere e andare in libreria — e se il modale è aperto, si
 *     perde quello che si è scritto.
 *  3. GLI ESEMPI, che si INSERISCONO nella casella giusta con un clic. Si
 *     aggiungono in coda e non sostituiscono: chi ha già scritto qualcosa non
 *     lo perde per aver guardato un esempio.
 *
 * Gli esempi usano nomi di campo INGLESI (`input.unit_cost`) perché la lingua
 * del prodotto è l'inglese e i nomi dei campi sono codice; le spiegazioni
 * passano da i18n, quindi chi lavora in italiano legge italiano.
 */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, ChevronRight, Plus } from 'lucide-react'
import { colors, fontWeight } from '@/lib/tokens'

/** Un campo leggibile da uno script: il nome è quello che si scrive, l'etichetta serve a riconoscerlo. */
export interface CampoLeggibile {
  name: string
  label: string
}

interface Esempio {
  /** La chiave della spiegazione: il codice non si traduce, la frase sì. */
  chiave: string
  codice: string
}

const FORMULE: readonly Esempio[] = [
  { chiave: 'multiply',   codice: 'return input.unit_cost * input.quantity' },
  { chiave: 'empty',      codice: 'if (input.quantity == null) return 0\nreturn input.quantity * 1.22' },
  { chiave: 'text',       codice: "return [input.first_name, input.last_name].filter(Boolean).join(' ')" },
  { chiave: 'days',       codice: 'const ms = new Date(input.end_date) - new Date(input.start_date)\nreturn Math.max(0, Math.round(ms / 86400000))' },
  { chiave: 'choice',     codice: "return input.environment === 'production' ? 'high' : 'low'" },
]

const VALIDAZIONI: readonly Esempio[] = [
  { chiave: 'negative',   codice: "if (value < 0) throw new Error('It cannot be negative')" },
  { chiave: 'otherField', codice: "if (value > input.budget) throw new Error('Above the approved budget')" },
  { chiave: 'format',     codice: "if (!/^[A-Z]{2}[0-9]{4}$/.test(value)) throw new Error('Format: two letters, four digits')" },
  { chiave: 'future',     codice: "if (new Date(value) < new Date()) throw new Error('The date must be in the future')" },
  { chiave: 'conditional', codice: "if (input.environment === 'production' && !value) throw new Error('Required in production')" },
]

const codiceStile: React.CSSProperties = {
  margin: 0, padding: '6px 8px', borderRadius: 6, background: 'var(--color-surface-2)',
  fontFamily: 'var(--font-mono)', fontSize: 'var(--font-size-table)', color: 'var(--color-slate-dark)',
  whiteSpace: 'pre-wrap', overflowX: 'auto', flex: 1, minWidth: 0,
}

export function ScriptHelp({ campi, conFormula, onInserisci }: {
  campi: readonly CampoLeggibile[]
  /** La sezione delle formule si mostra solo dove una formula è possibile. */
  conFormula: boolean
  onInserisci: (dove: 'formula' | 'validation', codice: string) => void
}) {
  const { t } = useTranslation()
  const [aperto, setAperto] = useState(false)

  const gruppo = (dove: 'formula' | 'validation', esempi: readonly Esempio[]) => (
    <div style={{ marginTop: 12 }}>
      <div style={{ fontSize: 'var(--font-size-table)', fontWeight: fontWeight.medium, color: 'var(--color-slate)', marginBottom: 6 }}>
        {t(dove === 'formula' ? 'pages.catalogForms.library.help.formulaExamples' : 'pages.catalogForms.library.help.validationExamples')}
      </div>
      {esempi.map((e) => (
        <div key={e.chiave} style={{ marginBottom: 8 }}>
          <div style={{ fontSize: 'var(--font-size-table)', color: 'var(--color-slate)', marginBottom: 3 }}>
            {t(`pages.catalogForms.library.help.ex.${e.chiave}`)}
          </div>
          <div style={{ display: 'flex', gap: 6, alignItems: 'flex-start' }}>
            <pre style={codiceStile}>{e.codice}</pre>
            {/* «Inserisci» e non «Copia»: la casella è a due centimetri da qui,
                e un appunti che su un tablet chiede un permesso è un modo di
                non funzionare. Si aggiunge in coda: non si sovrascrive quello
                che c'è già. */}
            <button
              type="button"
              onClick={() => { onInserisci(dove, e.codice) }}
              title={t('pages.catalogForms.library.help.insert')}
              aria-label={t('pages.catalogForms.library.help.insert')}
              style={{
                display: 'flex', alignItems: 'center', gap: 4, flex: '0 0 auto',
                padding: '5px 8px', borderRadius: 6, border: `1px solid ${colors.border}`,
                background: colors.white, cursor: 'pointer',
                fontSize: 'var(--font-size-table)', color: 'var(--color-brand)',
              }}
            >
              <Plus size={12} /> {t('pages.catalogForms.library.help.insert')}
            </button>
          </div>
        </div>
      ))}
    </div>
  )

  return (
    <div style={{ marginTop: 12, border: `1px solid ${colors.border}`, borderRadius: 8 }}>
      <button
        type="button"
        aria-expanded={aperto}
        onClick={() => { setAperto((x) => !x) }}
        style={{
          display: 'flex', alignItems: 'center', gap: 6, width: '100%', textAlign: 'left',
          padding: '8px 10px', borderRadius: 8, border: 'none', background: 'none', cursor: 'pointer',
          fontSize: 'var(--font-size-body)', color: 'var(--color-brand)', fontWeight: fontWeight.medium,
        }}
      >
        {aperto ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        {t('pages.catalogForms.library.help.title')}
      </button>

      {aperto && (
        <div style={{ padding: '0 10px 12px' }}>
          {/* Le tre regole che si sbagliano, prima degli esempi: un esempio
              copiato senza saperle si rompe alla prima risposta vuota. */}
          <ul style={{ margin: '0 0 10px', paddingLeft: 18, fontSize: 'var(--font-size-table)', color: 'var(--color-slate)', lineHeight: 1.6 }}>
            <li>{t('pages.catalogForms.library.help.ruleName')}</li>
            <li>{t('pages.catalogForms.library.help.ruleNull')}</li>
            <li>{t('pages.catalogForms.library.help.ruleReturnThrow')}</li>
            <li>{t('pages.catalogForms.library.help.ruleOtherField')}</li>
          </ul>

          <div style={{ fontSize: 'var(--font-size-table)', fontWeight: fontWeight.medium, color: 'var(--color-slate)', marginBottom: 4 }}>
            {t('pages.catalogForms.library.help.fieldsTitle')}
          </div>
          {campi.length === 0 ? (
            <p style={{ margin: 0, fontSize: 'var(--font-size-table)', color: 'var(--color-slate-light)' }}>
              {t('pages.catalogForms.library.help.fieldsEmpty')}
            </p>
          ) : (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 10px', maxHeight: 132, overflowY: 'auto' }}>
              {campi.map((c) => (
                <span key={c.name} style={{ fontSize: 'var(--font-size-table)', color: 'var(--color-slate)' }}>
                  <code style={{ fontFamily: 'var(--font-mono)', color: 'var(--color-slate-dark)' }}>input.{c.name}</code>
                  {c.label !== '' && <span style={{ color: 'var(--color-slate-light)' }}> · {c.label}</span>}
                </span>
              ))}
            </div>
          )}

          {conFormula && gruppo('formula', FORMULE)}
          {gruppo('validation', VALIDAZIONI)}
        </div>
      )}
    </div>
  )
}
