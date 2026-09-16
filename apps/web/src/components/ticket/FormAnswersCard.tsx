/**
 * LE RISPOSTE AL MODULO di una richiesta (moduli del catalogo, ondata 1).
 *
 * Sola lettura, e per un motivo: le risposte sono state date compilando una
 * REVISIONE precisa del modulo, e il riquadro le mostra nell'ordine di quella
 * revisione — le domande come sono state fatte. Modificarle a posteriori è un
 * altro lavoro (servirebbe rivalutare le condizioni sul modulo di allora) e
 * l'ondata 1 non lo fa: meglio non offrirlo che offrirlo a metà.
 *
 * I campi personalizzati del tipo `service_request` restano nel loro riquadro,
 * modificabili come prima: sono due cose diverse — quelli valgono per tutte le
 * richieste, questi sono le risposte a UNA voce di catalogo.
 */
import { useTranslation } from 'react-i18next'
import { SectionCard } from '@/components/ui/SectionCard'
import { colors } from '@/lib/tokens'

export interface FormAnswer {
  name: string
  label: string
  fieldType: string
  value: string | null
  values: string[]
}

export function FormAnswersCard({ answers, revision }: { answers: readonly FormAnswer[]; revision: number | null }) {
  const { t } = useTranslation()
  // Nessuna risposta = la richiesta non nasce da un modulo: niente riquadro
  // vuoto, che sembrerebbe un modulo rotto.
  if (answers.length === 0) return null

  return (
    <SectionCard
      collapsible={false}
      defaultOpen
      title={revision ? t('detail.sections.formAnswers', { revision }) : t('detail.sections.formAnswersNoRevision')}
    >
      <dl style={{ display: 'grid', gridTemplateColumns: 'minmax(120px, 30%) 1fr', gap: '8px 16px', margin: 0 }}>
        {answers.map((a) => (
          <div key={a.name} style={{ display: 'contents' }}>
            <dt style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate-light)' }}>{a.label}</dt>
            <dd style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate-dark)', margin: 0, wordBreak: 'break-word' }}>
              {a.values.length > 0
                ? a.values.join(', ')
                : a.value != null && a.value !== ''
                  ? (a.fieldType === 'boolean' ? (a.value === 'true' ? t('common.yes') : t('common.no')) : a.value)
                  : <span style={{ color: colors.slateLight }}>{t('detail.formAnswerEmpty')}</span>}
            </dd>
          </div>
        ))}
      </dl>
    </SectionCard>
  )
}

// Un sì/no si legge «Sì»/«No», non «true»/«false»: la traduzione è sopra,
// dentro il componente, perché è l'unico posto che ha `t`.
