/**
 * IL TIPO DI CHANGE SI SCEGLIE PRIMA, NON DENTRO LA FORM (20 set 2026,
 * richiesta del proprietario: «quando clicco su nuova change deve prima
 * apparirmi un modale con i tipi di change, non voglio selezionare il tipo
 * direttamente dalla form»).
 *
 * Non è solo un campo spostato: il tipo DECIDE cos'è la change — se salta la
 * catena di approvazioni (pre-approvata) e con quale urgenza si tratta.
 * Sceglierlo prima è l'ordine giusto, ed è quello che fa chi apre una change
 * davvero: prima decide che tipo di intervento è, poi lo descrive.
 *
 * I tipi sono quelli del VOCABOLARIO `change_type` DEL CLIENTE, non tre
 * cablati: chi ne aggiunge uno nel Dizionario se lo trova qui. La
 * spiegazione sotto l'etichetta c'è solo per i valori che il prodotto
 * spedisce (`pages.createChange.typeHelp.*`); per un tipo del cliente non
 * inventiamo una descrizione che non conosciamo.
 */
import { Loading } from '@/components/ui/Loading'
import { Pill } from '@/components/ui/Pill'
import { useTranslation } from 'react-i18next'
import { ShieldCheck } from 'lucide-react'
import { Modal } from '@/components/Modal'
import { Button } from '@/components/Button'
import { colors, palette } from '@/lib/tokens'

export interface ChangeTypeEntry { value: string; label: string }

interface Props {
  open: boolean
  /** I tipi del vocabolario del cliente; `null` = non si sa ancora (query in corso). */
  types: readonly ChangeTypeEntry[] | null
  /** I tipi pre-approvati; `null` = non si sa ancora. */
  preApproved: readonly string[] | null
  onPick: (value: string) => void
  /** Chiudere senza scegliere: si torna da dove si è arrivati. */
  onCancel: () => void
}

export function ChangeTypeModal({ open, types, preApproved, onPick, onCancel }: Props) {
  const { t, i18n } = useTranslation()

  return (
    <Modal
      open={open}
      onClose={onCancel}
      title={t('pages.createChange.pickType')}
      width={560}
      /*
       * Niente chiusura cliccando fuori: da qui non si passa per sbaglio.
       * Senza un tipo la form non ha senso, e un clic distratto rimanderebbe
       * alla lista chi stava aprendo una change.
       */
      closeOnOverlay={false}
      footer={<Button variant="secondary" onClick={onCancel}>{t('common.cancel')}</Button>}
    >
      <p style={{ margin: '0 0 16px', fontSize: 'var(--font-size-body)', color: 'var(--color-slate)' }}>
        {t('pages.createChange.pickTypeHelp')}
      </p>

      {types === null && (
        <Loading />
      )}

      {/*
        Nessun tipo definito: si dice la stessa cosa che diceva la form, e si
        lascia la via d'uscita. Un modale senza scelte e senza uscita sarebbe
        una trappola.
      */}
      {types?.length === 0 && (
        <p style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-trigger-sla-breach)' }}>
          {t('pages.createChange.noChangeTypes')}
        </p>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {types?.map(({ value, label }) => {
          const chiaveAiuto = `pages.createChange.typeHelp.${value}`
          const aiuto = i18n.exists(chiaveAiuto) ? t(chiaveAiuto) : null
          const preApprovato = preApproved?.includes(value) ?? false
          return (
            <button
              key={value}
              type="button"
              onClick={() => onPick(value)}
              style={{
                display: 'block', width: '100%', textAlign: 'left', cursor: 'pointer',
                padding: '12px 14px', borderRadius: 8,
                border: `1.5px solid ${colors.border}`, background: colors.white,
              }}
              onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--color-brand)'; e.currentTarget.style.background = palette.info.light }}
              onMouseLeave={e => { e.currentTarget.style.borderColor = colors.border; e.currentTarget.style.background = colors.white }}
            >
              <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 'var(--font-size-card-title)', fontWeight: 600, color: 'var(--color-slate-dark)' }}>{label}</span>
                {preApprovato && (
                  <Pill bg={palette.success.tint} color={palette.success.dark} radius={999} style={{ gap: 4, fontSize: 'var(--font-size-label)', fontWeight: 600 }}>
                    <ShieldCheck size={12} aria-hidden="true" />
                    {t('pages.createChange.preApprovedBadge')}
                  </Pill>
                )}
              </span>
              {aiuto && (
                <span style={{ display: 'block', marginTop: 4, fontSize: 'var(--font-size-body)', color: 'var(--color-slate)' }}>
                  {aiuto}
                </span>
              )}
            </button>
          )
        })}
      </div>
    </Modal>
  )
}
