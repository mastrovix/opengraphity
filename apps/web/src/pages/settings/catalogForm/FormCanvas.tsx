/**
 * LA TELA DEL COSTRUTTORE (18 set 2026).
 *
 * Chiesto dal proprietario: «come layout vorrei qualcosa di più simile a un
 * designer». Prima il modulo era un ELENCO di righe, ognuna con le sue
 * spunte: si leggeva la configurazione, non si vedeva il modulo. Adesso la
 * tela disegna i campi COME LI VEDRÀ CHI COMPILA — la casella, la tendina, le
 * due colonne dove sono impostate — e ogni campo si seleziona con un clic; le
 * impostazioni stanno nel modale delle proprietà, non addosso al campo.
 *
 * ## I controlli sono FINTI, e di proposito
 * Sulla tela non si compila: i controlli sono disegni. Usare il renderer vero
 * avrebbe voluto dire caselle che accettano testo che nessuno salverà, e un
 * clic per selezionare che litiga col clic per scrivere. Quello che conta è
 * l'ASPETTO — larghezze, ordine, colonne, cosa è obbligatorio — e l'anteprima
 * compilabile vera resta a un interruttore di distanza.
 *
 * ## I bersagli del trascinamento restano quelli
 * `data-drop` sulla sezione (`sec-i`), sulla sua intestazione (`ord-i`) e su
 * ogni campo (`item-i-j`): il motore del trascinamento li trova nel DOM, e non
 * gli importa come sono disegnati.
 */
import { useTranslation } from 'react-i18next'
import { CalendarDays, ChevronDown, Eye, Paperclip, Search, Table2 } from 'lucide-react'
import { larghezzaEffettiva, localizedText, type CatalogFormDefinition, type CatalogFormItem } from '@opengraphity/types'
import { colors, fontWeight } from '@/lib/tokens'
import type { FormFieldRow } from './FieldLibraryPanel'

/** Cosa è selezionato sulla tela. */
export type Selezione =
  | { tipo: 'section'; iSez: number }
  | { tipo: 'item'; iSez: number; iVoce: number }

export function stessaSelezione(a: Selezione | null, b: Selezione | null): boolean {
  if (!a || !b || a.tipo !== b.tipo) return false
  if (a.tipo === 'section' && b.tipo === 'section') return a.iSez === b.iSez
  if (a.tipo === 'item' && b.tipo === 'item') return a.iSez === b.iSez && a.iVoce === b.iVoce
  return false
}

const scatola: React.CSSProperties = {
  border: `1px solid ${colors.border}`, borderRadius: 6, background: colors.white,
  padding: '7px 9px', fontSize: 'var(--font-size-body)', color: 'var(--color-slate-light)',
  display: 'flex', alignItems: 'center', gap: 6, minHeight: 34,
}

/**
 * IL CONTROLLO FINTO, per tipo. È quello che rende la tela un disegno del
 * modulo invece di un elenco: un campo data si riconosce dal calendario, una
 * tendina dalla freccia, un allegato dal tratteggio.
 */
function ControlloFinto({ tipo, segnaposto }: { tipo: string; segnaposto: string }) {
  const { t } = useTranslation()
  if (tipo === 'note') {
    return (
      <p style={{ margin: 0, fontSize: 'var(--font-size-body)', color: 'var(--color-slate)', fontStyle: 'italic' }}>
        {segnaposto}
      </p>
    )
  }
  if (tipo === 'boolean') {
    return (
      <span style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 'var(--font-size-body)', color: 'var(--color-slate-light)' }}>
        <span style={{ width: 15, height: 15, border: `1px solid ${colors.border}`, borderRadius: 3, background: colors.white }} />
        {t('common.yes')} / {t('common.no')}
      </span>
    )
  }
  if (tipo === 'textarea') return <span style={{ ...scatola, minHeight: 58, alignItems: 'flex-start' }} />
  if (tipo === 'attachment') {
    return (
      <span style={{ ...scatola, border: `1px dashed ${colors.border}`, justifyContent: 'center' }}>
        <Paperclip size={13} /> {t(`pages.catalogForms.fieldType.${tipo}`)}
      </span>
    )
  }
  if (tipo === 'table') {
    return (
      <span style={{ ...scatola, flexDirection: 'column', alignItems: 'stretch', gap: 3, padding: 7 }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 5, color: 'var(--color-slate-light)', fontSize: 'var(--font-size-table)' }}>
          <Table2 size={12} /> {t(`pages.catalogForms.fieldType.${tipo}`)}
        </span>
        {[0, 1].map((r) => (
          <span key={r} style={{ display: 'flex', gap: 3 }}>
            {[0, 1, 2].map((c) => (
              <span key={c} style={{ flex: 1, height: 10, borderRadius: 2, background: 'var(--color-surface-alt)' }} />
            ))}
          </span>
        ))}
      </span>
    )
  }
  if (tipo === 'enum' || tipo === 'multi_enum') {
    return <span style={scatola}><span style={{ flex: 1 }} /><ChevronDown size={14} /></span>
  }
  if (tipo === 'ref_ci' || tipo === 'ref_user' || tipo === 'ref_team') {
    return <span style={scatola}><Search size={13} /><span style={{ flex: 1 }} /></span>
  }
  if (tipo === 'date' || tipo === 'datetime') {
    return <span style={scatola}><span style={{ flex: 1 }} /><CalendarDays size={14} /></span>
  }
  return <span style={scatola} />
}

function CampoSullaTela({
  item, campo, colonne, zona, selezionato, bersaglio, onSeleziona, maniglia,
}: {
  item: CatalogFormItem
  campo: FormFieldRow | undefined
  /** Le colonne della sezione: decidono se «mezza larghezza» vuol dire qualcosa. */
  colonne: 1 | 2
  /** La chiave `data-drop` di questa voce: la compone chi conosce gli indici. */
  zona: string
  selezionato: boolean
  bersaglio: boolean
  onSeleziona: () => void
  maniglia: React.ReactNode
}) {
  const { t } = useTranslation()
  const tipo = campo?.fieldType ?? 'text'
  const etichetta = campo?.label ?? item.field
  const piena = larghezzaEffettiva({ columns: colonne }, item) === 'full'

  return (
    <div
      /* Un bottone no: dentro ci sta la maniglia, che è già un bottone, e un
         bottone dentro un bottone non è HTML valido. Un `div` col ruolo, il
         fuoco e Invio/Spazio fa la stessa cosa e resta annidabile. */
      role="button"
      tabIndex={0}
      aria-pressed={selezionato}
      aria-label={etichetta}
      data-drop={zona}
      onClick={onSeleziona}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSeleziona() } }}
      style={{
        gridColumn: piena ? '1 / -1' : 'auto',
        textAlign: 'left', cursor: 'pointer', background: 'none',
        border: `1px solid ${selezionato ? 'var(--color-brand)' : 'transparent'}`,
        boxShadow: bersaglio ? '0 -2px 0 0 var(--color-brand)' : 'none',
        borderRadius: 8, padding: 8,
      }}
    >
      {/*
        UNA GRIGLIA SOLA: presa, etichetta, controllo (18 set 2026).

        Prima erano due contenitori annidati — la presa e l'etichetta in un
        flex, il controllo accanto — e i tre pezzi si allineavano solo per
        coincidenza: cambiando un padding o mandando l'etichetta a capo, la
        presa restava indietro. Il proprietario l'ha visto subito, e aveva
        ragione: «disallineamento».

        Adesso sono tre colonne della STESSA riga, allineate in alto, e la
        presa e l'etichetta portano lo stesso `paddingTop` della prima riga di
        testo del controllo (7px, come `.og-form-cell` nel modulo vero). Niente
        più annidamento: non c'è nulla che possa scivolare.
      */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'var(--og-grip-col, 20px) clamp(90px, 24%, 170px) minmax(0, 1fr)',
        columnGap: 8, alignItems: 'start',
      }}>
        {/*
          LA PRESA SI CENTRA SULLA RIGA DI TESTO DELL'ETICHETTA — per
          costruzione, non con un numero.

          Tre tentativi sbagliati, tutti con lo stesso errore: un padding
          calcolato. Prima confrontavo il centro dello SPAN dell'etichetta
          invece del suo testo (lo span comprende il proprio padding: due
          numeri uguali e sei pixel di disallineamento). Poi il numero giusto
          per il mouse era sbagliato col dito, perché su un dispositivo a
          tocco il bottone della presa diventa 44px e la sua icona si
          centrava undici pixel più in basso: da iPad la maniglia sembrava
          appesa sotto il campo.

          Qui il contenitore della presa È la riga di testo — stesso
          `padding-top` dell'etichetta, altezza di una riga — e il bottone ci
          si centra dentro. Che sia 22px o 44 non cambia niente: il centro
          dell'icona cade sul centro della riga in tutti e due i casi.
        */}
        <span style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          paddingTop: 7, height: 17, boxSizing: 'content-box',
        }}>
          {maniglia}
        </span>
        <span style={{
          paddingTop: 7, fontSize: 'var(--font-size-table)', color: 'var(--color-slate)',
          fontWeight: fontWeight.medium, display: 'flex', gap: 5, flexWrap: 'wrap',
          /* `lineHeight` DICHIARATA, e la stessa che usa il contenitore della
             presa: due scatole con la stessa geometria si allineano da sole,
             e non serve nessun numero di correzione. Lasciata al valore
             ereditato, la prima riga dell'etichetta cadeva dieci pixel sotto
             l'icona — su un telefono, dove l'etichetta va a capo, di più. */
          lineHeight: '17px', alignItems: 'flex-start',
          // A destra, accostata al controllo: come nel modulo vero.
          justifyContent: 'flex-end', textAlign: 'right',
        }}>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {etichetta}
            {(item.required ?? campo?.required) === true && <span style={{ color: 'var(--color-danger)' }}> *</span>}
          </span>
          {/* I due segni che cambiano il comportamento e non si vedrebbero:
              una condizione e la sola lettura di un campo calcolato. */}
          {item.visibleWhen && (
            <span title={t('pages.catalogForms.builder.hasCondition')} style={{ display: 'flex', color: 'var(--color-slate-light)' }}>
              <Eye size={12} />
            </span>
          )}
          {campo?.formula != null && campo.formula !== '' && (
            <span style={{ color: 'var(--color-slate-light)', fontFamily: 'var(--font-mono)' }}>ƒ</span>
          )}
        </span>
        {/* Il disegno non si clicca: il clic è del campo, che seleziona. */}
        <span style={{ pointerEvents: 'none', display: 'block' }}>
          <ControlloFinto tipo={tipo} segnaposto={campo?.help ?? etichetta} />
        </span>
      </div>
    </div>
  )
}

export function FormCanvas({
  bozza, perNome, lingua, lingue, selezione, bersaglio, onSeleziona, maniglia, manigliaSezione,
}: {
  bozza: CatalogFormDefinition
  perNome: Map<string, FormFieldRow>
  lingua: string
  /** Le lingue del prodotto: la pubblicazione pretende un titolo in tutte. */
  lingue: readonly string[]
  selezione: Selezione | null
  /** La zona `data-drop` evidenziata dal trascinamento in corso. */
  bersaglio: string | null
  onSeleziona: (s: Selezione | null) => void
  /** Le maniglie le disegna il pannello: sono legate al motore del trascinamento. */
  maniglia: (iSez: number, iVoce: number) => React.ReactNode
  manigliaSezione: (iSez: number) => React.ReactNode
}) {
  const { t } = useTranslation()

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {bozza.sections.map((sezione, iSez) => {
        const titolo = localizedText(sezione.title, lingua, '') || sezione.id
        const sezSelezionata = stessaSelezione(selezione, { tipo: 'section', iSez })
        /* Le lingue in cui il titolo manca: la pubblicazione le pretende tutte. */
        const mancanti = lingue.filter((l) => ((sezione.title as Record<string, string | undefined>)[l] ?? '').trim() === '')
          .map((l) => l.toUpperCase())
        return (
          <section
            key={sezione.id}
            data-drop={`sec-${String(iSez)}`}
            style={{
              border: `1px solid ${bersaglio === `sec-${String(iSez)}` ? 'var(--color-brand)' : colors.border}`,
              boxShadow: sezSelezionata ? '0 0 0 2px var(--color-brand-light)' : 'none',
              borderRadius: 10, background: colors.white, padding: 14,
            }}
          >
            <div
              data-drop={`ord-${String(iSez)}`}
              style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}
            >
              {manigliaSezione(iSez)}
              <button
                type="button"
                onClick={() => { onSeleziona({ tipo: 'section', iSez }) }}
                style={{
                  flex: 1, textAlign: 'left', background: 'none', border: 'none', cursor: 'pointer', padding: 0,
                  fontSize: 'var(--font-size-card-title)', fontWeight: fontWeight.medium,
                  color: titolo === sezione.id ? 'var(--color-danger)' : 'var(--color-slate-dark)',
                }}
              >
                {titolo === sezione.id ? t('pages.catalogForms.builder.sectionUntitled') : titolo}
              </button>
              {/*
                IL TITOLO CHE MANCA IN UN'ALTRA LINGUA, DETTO SUBITO.

                La pubblicazione lo rifiuta — «la sezione "main" non ha un
                titolo in en» — ma lo diceva solo al momento di pubblicare,
                cioè dopo aver disegnato tutto il modulo. E sulla tela non si
                vedeva niente di strano: il titolo nella lingua corrente c'è.
                Il proprietario l'ha incontrato esattamente così.
              */}
              {mancanti.length > 0 && (
                <span style={{ fontSize: 'var(--font-size-table)', color: 'var(--color-danger)' }}>
                  {t('pages.catalogForms.builder.sectionTitleMissingIn', { languages: mancanti.join(', ') })}
                </span>
              )}
              <span style={{ fontSize: 'var(--font-size-table)', color: 'var(--color-slate-light)' }}>
                {t((sezione.columns ?? 1) === 2 ? 'pages.catalogForms.builder.columnsTwo' : 'pages.catalogForms.builder.columnsOne')}
              </span>
            </div>

            {sezione.items.length === 0 ? (
              <p style={{ margin: 0, padding: '14px 0', textAlign: 'center', fontSize: 'var(--font-size-table)', color: 'var(--color-slate-light)', border: `1px dashed ${colors.border}`, borderRadius: 8 }}>
                {t('pages.catalogForms.builder.dropHere')}
              </p>
            ) : (
              <div style={{
                display: 'grid',
                gridTemplateColumns: (sezione.columns ?? 1) === 2 ? '1fr 1fr' : '1fr',
                gap: 8,
              }}>
                {sezione.items.map((item, iVoce) => (
                  <CampoSullaTela
                    key={item.field}
                    item={item}
                    campo={perNome.get(item.field)}
                    colonne={sezione.columns ?? 1}
                    zona={`item-${String(iSez)}-${String(iVoce)}`}
                    selezionato={stessaSelezione(selezione, { tipo: 'item', iSez, iVoce })}
                    bersaglio={bersaglio === `item-${String(iSez)}-${String(iVoce)}`}
                    onSeleziona={() => { onSeleziona({ tipo: 'item', iSez, iVoce }) }}
                    maniglia={maniglia(iSez, iVoce)}
                  />
                ))}
              </div>
            )}
          </section>
        )
      })}
    </div>
  )
}
