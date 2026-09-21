/**
 * LE COLONNE DI UNA TABELLA, nel disegnatore della libreria (ondata 7).
 *
 * Una tabella ripetibile è l'unico campo che ha una struttura dentro: le sue
 * colonne. Si disegnano qui, con le stesse scelte di un campo normale ridotte
 * all'osso — nome, etichetta, tipo, vocabolario, obbligatoria — perché una
 * colonna non è un campo: non ha un aiuto suo, non ha condizioni, non ha una
 * formula. Offrirle sarebbe promettere quello che il renderer di una riga non
 * sa fare.
 *
 * Il documento viaggia come JSON (`{version, columns}`): la forma la decide il
 * contratto in @opengraphity/types, e l'API rifiuta quello che non sta in
 * piedi (zero colonne, nomi doppi, una scelta senza vocabolario).
 */
import { useTranslation } from 'react-i18next'
import { Plus, Trash2 } from 'lucide-react'
import { FORM_TABLE_COLUMN_TYPES, FORM_TABLE_VERSION, type FormTableColumn, type FormTableDefinition } from '@opengraphity/types'
import { Input, Select } from '@/components/ui/FormControls'
import { colors } from '@/lib/tokens'

const cella: React.CSSProperties = { padding: '4px 6px', verticalAlign: 'top' }
const intestazione: React.CSSProperties = {
  textAlign: 'left', padding: '4px 6px', fontSize: 'var(--font-size-table)',
  color: 'var(--color-slate-light)', fontWeight: 600,
}

/** Un vocabolario del Dizionario come lo elenca la pagina. */
interface VoceDizionario { name: string; label: string }

/**
 * Le proprietà in un'interfaccia con dei tipi che hanno un NOME: il guardiano
 * i18n legge un `ReadonlyArray<{ … }>` come se fosse un tag JSX, e da lì in poi
 * prende per testo a schermo quello che trova (segnalava il `void` della riga
 * sopra). Dare un nome al tipo costa una riga e toglie l'inciampo.
 */
interface TableColumnsEditorProps {
  definizione: FormTableDefinition
  onChange: (d: FormTableDefinition) => void
  vocabolari: readonly VoceDizionario[]
}

export function TableColumnsEditor({ definizione, onChange, vocabolari }: TableColumnsEditorProps) {
  const { t } = useTranslation()
  const colonne = definizione.columns

  /**
   * I tre callback hanno un nome INGLESE di proposito: il guardiano i18n legge
   * un `=> nome(` dentro un attributo JSX come se fosse testo a schermo, e con
   * un nome italiano (`cambia`, `togli`) lo segnala come italiano cablato. È la
   * stessa inciampata di `ScriptingSection`, qui risolta col nome invece del
   * corpo a blocco perché le chiamate sono cinque.
   */
  const setColumn = (i: number, patch: Partial<FormTableColumn>) => {
    onChange({
      version: FORM_TABLE_VERSION,
      columns: colonne.map((c, k) => (k === i ? { ...c, ...patch } : c)),
    })
  }
  const addColumn = () => {
    onChange({
      version: FORM_TABLE_VERSION,
      columns: [...colonne, { name: '', labels: {}, fieldType: 'text', vocabulary: null, required: false }],
    })
  }
  const removeColumn = (i: number) => {
    onChange({ version: FORM_TABLE_VERSION, columns: colonne.filter((_, k) => k !== i) })
  }

  return (
    <div style={{ marginTop: 14 }}>
      <span style={{ display: 'block', fontSize: 'var(--font-size-table)', color: 'var(--color-slate-light)', marginBottom: 3 }}>
        {t('pages.catalogForms.library.tableColumns')}
      </span>
      <p style={{ margin: '0 0 8px', fontSize: 'var(--font-size-table)', color: 'var(--color-slate-light)', maxWidth: '70ch' }}>
        {t('pages.catalogForms.library.tableColumnsHelp')}
      </p>

      <div className="og-scroll-x">
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th style={intestazione}>{t('pages.catalogForms.library.columnName')}</th>
              <th style={intestazione}>{t('pages.catalogForms.library.columnLabelIt')}</th>
              <th style={intestazione}>{t('pages.catalogForms.library.columnLabelEn')}</th>
              <th style={intestazione}>{t('pages.catalogForms.library.type')}</th>
              <th style={intestazione}>{t('pages.catalogForms.library.vocabulary')}</th>
              <th style={intestazione}>{t('pages.catalogForms.library.columnRequired')}</th>
              <th style={intestazione} aria-label={t('common.actions')} />
            </tr>
          </thead>
          <tbody>
            {colonne.map((c, i) => (
              <tr key={i}>
                <td style={{ ...cella, minWidth: 140 }}>
                  <Input value={c.name} onChange={(e) => setColumn(i, { name: e.target.value })}
                    placeholder={t('pages.catalogForms.library.columnNamePlaceholder')} />
                </td>
                <td style={{ ...cella, minWidth: 130 }}>
                  <Input value={c.labels['it'] ?? ''} onChange={(e) => setColumn(i, { labels: { ...c.labels, it: e.target.value } })} />
                </td>
                <td style={{ ...cella, minWidth: 130 }}>
                  <Input value={c.labels['en'] ?? ''} onChange={(e) => setColumn(i, { labels: { ...c.labels, en: e.target.value } })} />
                </td>
                <td style={{ ...cella, minWidth: 120 }}>
                  <Select value={c.fieldType} onChange={(e) => {
                    const tipo = e.target.value as FormTableColumn['fieldType']
                    // Cambiando tipo il vocabolario di una scelta non resta
                    // appiccicato a un numero: l'API lo rifiuterebbe.
                    setColumn(i, { fieldType: tipo, vocabulary: tipo === 'enum' ? c.vocabulary : null })
                  }}>
                    {FORM_TABLE_COLUMN_TYPES.map((tipo) => (
                      <option key={tipo} value={tipo}>{t(`pages.catalogForms.fieldType.${tipo}`)}</option>
                    ))}
                  </Select>
                </td>
                <td style={{ ...cella, minWidth: 140 }}>
                  {c.fieldType === 'enum' ? (
                    <Select value={c.vocabulary ?? ''} onChange={(e) => setColumn(i, { vocabulary: e.target.value || null })}>
                      <option value="">{t('common.select')}</option>
                      {vocabolari.map((v) => <option key={v.name} value={v.name}>{v.label || v.name}</option>)}
                    </Select>
                  ) : (
                    <span style={{ fontSize: 'var(--font-size-table)', color: 'var(--color-slate-light)' }}>—</span>
                  )}
                </td>
                <td style={{ ...cella, textAlign: 'center' }}>
                  <input type="checkbox" checked={c.required === true} onChange={(e) => setColumn(i, { required: e.target.checked })}
                    aria-label={t('pages.catalogForms.library.columnRequired')} />
                </td>
                <td style={{ ...cella, textAlign: 'right' }}>
                  <button type="button" onClick={() => removeColumn(i)} aria-label={t('common.delete')}
                    style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-danger)', padding: 4 }}>
                    <Trash2 size={14} />
                  </button>
                </td>
              </tr>
            ))}
            {colonne.length === 0 && (
              <tr>
                <td colSpan={7} style={{ ...cella, color: 'var(--color-slate-light)', fontSize: 'var(--font-size-table)' }}>
                  {t('pages.catalogForms.library.tableNoColumns')}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <button type="button" onClick={addColumn}
        style={{
          marginTop: 8, display: 'flex', alignItems: 'center', gap: 6, padding: '5px 12px', borderRadius: 8,
          border: `1px solid ${colors.border}`, background: colors.white,
          fontSize: 'var(--font-size-body)', color: 'var(--color-slate-dark)', cursor: 'pointer',
        }}>
        <Plus size={14} /> {t('pages.catalogForms.library.addColumn')}
      </button>
    </div>
  )
}
