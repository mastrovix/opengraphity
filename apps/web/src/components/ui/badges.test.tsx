import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { SeverityBadge, RoleBadge, RiskBadge, PhaseBadge, StatusLabel } from './badges'
import { RiskBandContext, bandForScore, type RiskBandThreshold } from '@/contexts/RiskBandContext'
import { palette } from '@/lib/tokens'
import { DomainVocabularyContext } from '@/contexts/DomainVocabularyContext'
import { NEUTRAL_VALUE_STYLE } from '@/lib/domainStyle'
import { enumLabel } from '@/lib/ciEnums'

const BROKEN_BG = 'var(--color-danger)'
let consoleError: ReturnType<typeof vi.spyOn>
beforeEach(() => { consoleError = vi.spyOn(console, 'error').mockImplementation(() => {}) })

/**
 * Vocabolario del cliente per il test: il provider vero fa una query, qui si
 * inietta il contesto a mano (ondata 7 · D-15).
 */
function withVocabulary(
  values: readonly string[] | null,
  ui: React.ReactElement,
  /** Le etichette del cliente (ondata 1): assenti per default, come su un tenant non ancora migrato. */
  labels: Readonly<Record<string, string>> = {},
  /** I colori del Dizionario (revisione del 14 set 2026 · F9). */
  valueColors: Readonly<Record<string, string>> = {},
) {
  return render(
    <DomainVocabularyContext.Provider value={{
      valuesOf:  () => values,
      labelOf:   (_n, v) => labels[v] ?? null,
      colorOf:   (_n, v) => (valueColors[v] as never) ?? null,
      vocabularyLabelOf: () => null, entriesOf: () => (values ? values.map((v) => ({ value: v, label: labels[v] ?? v, labels: [] })) : null),
      loading: false,
      error: null,
    }}>
      {ui}
    </DomainVocabularyContext.Provider>,
  )
}

const SEVERITIES = ['critical', 'high', 'medium', 'low']
const FACTORY_COLORS = { critical: 'danger', high: 'orange', medium: 'warning', low: 'success' } as const

describe('SeverityBadge', () => {
  /**
   * Revisione del 14 set 2026 · F9: il colore viene dal Dizionario del cliente
   * (`colorOf`), non da `SEVERITY_STYLE` scritto qui. Un valore rinominato o
   * aggiunto dal cliente col suo colore si vede col suo colore.
   */
  it.each(SEVERITIES)('%s → il colore che il Dizionario gli assegna', (sev) => {
    withVocabulary(SEVERITIES, <SeverityBadge value={sev} />, {}, FACTORY_COLORS)
    const pill = screen.getByText(enumLabel(sev))
    const family = palette[FACTORY_COLORS[sev as keyof typeof FACTORY_COLORS]]
    expect(pill).toHaveStyle({ background: family.tint, color: family.text, textTransform: 'uppercase' })
    expect(consoleError).not.toHaveBeenCalled()
  })
  it('un valore del cliente (p1) prende il colore che il cliente gli ha dato', () => {
    withVocabulary(['p1', 'p2'], <SeverityBadge value="p1" />, { p1: 'Urgente' }, { p1: 'danger' })
    expect(screen.getByText('Urgente')).toHaveStyle({ background: palette.danger.tint, color: palette.danger.text })
  })
  it('valore assente → "—"', () => {
    withVocabulary(null, <SeverityBadge value={null} />)
    expect(screen.getByText('—')).toBeInTheDocument()
  })

  it('valore NEL vocabolario del cliente senza colore assegnato → neutro e silenzioso', () => {
    withVocabulary([...SEVERITIES, 'blocker'], <SeverityBadge value="blocker" />, {}, FACTORY_COLORS)
    expect(screen.getByText('Blocker')).toHaveStyle({ background: NEUTRAL_VALUE_STYLE.bg, color: NEUTRAL_VALUE_STYLE.color })
    expect(consoleError).not.toHaveBeenCalled()
  })
  it('valore FUORI dal vocabolario del cliente → stile rotto (rosso) e console.error', () => {
    withVocabulary(SEVERITIES, <SeverityBadge value="blocker" />, {}, FACTORY_COLORS)
    expect(screen.getByText('Blocker')).toHaveStyle({ background: BROKEN_BG, color: 'var(--color-white)' })
    expect(consoleError).toHaveBeenCalledWith('[severity] "blocker" is not in the vocabulary of this tenant (critical, high, medium, low)')
  })
  it('vocabolario non disponibile → neutro e console.warn (non si accusa di essere rotto ciò che non si è potuto verificare)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    withVocabulary(null, <SeverityBadge value="blocker" />)
    expect(screen.getByText('Blocker')).toHaveStyle({ background: NEUTRAL_VALUE_STYLE.bg })
    expect(consoleError).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith('[severity] "blocker" has no color and the vocabulary of this tenant is unavailable: neutral style')
  })
})

describe('RoleBadge', () => {
  it.each([['admin', 'Admin'], ['operator', 'Operator'], ['viewer', 'Viewer'], ['end_user', 'End user']])('%s → "%s"', (role, label) => {
    render(<RoleBadge role={role} />)
    expect(screen.getByText(label)).toBeInTheDocument()
    expect(consoleError).not.toHaveBeenCalled()
  })
  it('ruolo assente → "—"; un ruolo creato dall\'organizzazione (ondata 7) mostra il suo nome, senza errori', () => {
    const { rerender } = render(<RoleBadge role={undefined} />)
    expect(screen.getByText('—')).toBeInTheDocument()
    rerender(<RoleBadge role="service_desk" name="Service Desk" />)
    expect(screen.getByText('Service Desk')).toBeInTheDocument()
    rerender(<RoleBadge role="viewer" name="Sola lettura" />)
    expect(screen.getByText('Sola lettura')).toBeInTheDocument()
    expect(consoleError).not.toHaveBeenCalled()
  })
})

describe('RiskBadge — fasce del cliente (verifica «Cosa resta cablato», ondata 1)', () => {
  const FACTORY: RiskBandThreshold[] = [{ band: 'low', upTo: 30 }, { band: 'medium', upTo: 60 }, { band: 'high', upTo: 100 }]
  const RISK_COLORS = { low: 'success', medium: 'warning', high: 'danger', critical: 'purple' } as const

  function withBands(thresholds: RiskBandThreshold[] | null, ui: React.ReactElement, labels: Record<string, string> = {}) {
    const values = thresholds ? thresholds.map((t) => t.band) : null
    return withVocabulary(values, (
      <RiskBandContext.Provider value={{ bandOf: (score) => (thresholds ? bandForScore(thresholds, score) : null), loading: false, error: null }}>
        {ui}
      </RiskBandContext.Provider>
    ), labels, RISK_COLORS)
  }

  it.each([[0, 'low'], [30, 'low'], [31, 'medium'], [60, 'medium'], [61, 'high'], [100, 'high']])('soglie di fabbrica: score %d → %s', (score, band) => {
    expect(bandForScore(FACTORY, score)).toBe(band)
  })

  it('mostra "FASCIA · score" con il colore del Dizionario, in compact solo il numero', () => {
    const { rerender } = withBands(FACTORY, <RiskBadge score={45} />)
    const el = screen.getByText('MEDIUM · 45')
    expect(el).toHaveAttribute('title', 'MEDIUM · score 45')
    expect(el.parentElement).toHaveStyle({ color: palette.warning.text })
    rerender(
      <DomainVocabularyContext.Provider value={{ valuesOf: () => ['low', 'medium', 'high'], labelOf: () => null, colorOf: (_n, v) => ((RISK_COLORS as Record<string, string>)[v] as never) ?? null, vocabularyLabelOf: () => null, entriesOf: () => null, loading: false, error: null }}>
        <RiskBandContext.Provider value={{ bandOf: (score) => bandForScore(FACTORY, score), loading: false, error: null }}>
          <RiskBadge score={72} compact />
        </RiskBandContext.Provider>
      </DomainVocabularyContext.Provider>,
    )
    expect(screen.getByText('72')).toHaveAttribute('title', 'HIGH · score 72')
  })

  it('segue le soglie e le fasce del cliente: 20/50/80/100 con quattro fasce ed etichette sue', () => {
    const custom: RiskBandThreshold[] = [{ band: 'low', upTo: 20 }, { band: 'medium', upTo: 50 }, { band: 'high', upTo: 80 }, { band: 'critical', upTo: 100 }]
    withBands(custom, <RiskBadge score={45} />, { medium: 'Media' })
    expect(screen.getByText('MEDIA · 45')).toBeInTheDocument()
    withBands(custom, <RiskBadge score={90} />, { critical: 'Critica' })
    expect(screen.getByText('CRITICA · 90').parentElement).toHaveStyle({ color: palette.purple.text })
  })

  it('soglie non note (caricamento o errore): solo il punteggio, neutro, nessuna fascia indovinata', () => {
    withBands(null, <RiskBadge score={45} />)
    expect(screen.getByText('45')).toHaveAttribute('title', 'score 45')
    expect(screen.queryByText(/MEDIUM/)).not.toBeInTheDocument()
  })

  it('score assente → "—"', () => {
    render(<RiskBadge score={null} />)
    expect(screen.getByText('—')).toBeInTheDocument()
  })
})

describe('PhaseBadge / StatusLabel', () => {
  it('PhaseBadge usa la label se presente, altrimenti la fase; categoria ignota → log', () => {
    const { rerender } = render(<PhaseBadge phase="in_progress" label="In corso" category="active" />)
    expect(screen.getByText('In corso')).toBeInTheDocument()
    expect(consoleError).not.toHaveBeenCalled()
    rerender(<PhaseBadge phase="weird" category="galactic" />)
    expect(screen.getByText('weird')).toBeInTheDocument()
    expect(consoleError).toHaveBeenCalledWith('[workflowStepStyle] unknown category: "galactic"')
  })
  it('StatusLabel: pending → "TO BE COMPLETED", altri stati con underscore → spazio', () => {
    const { rerender } = render(<StatusLabel status="pending" />)
    expect(screen.getByText('TO BE COMPLETED')).toHaveAttribute('title', 'pending')
    rerender(<StatusLabel status="in-progress" />)
    expect(screen.getByText('in-progress')).toHaveStyle({ color: 'var(--color-warning)' })
    rerender(<StatusLabel status={null} />)
    expect(screen.getByText('—')).toBeInTheDocument()
  })
})

/**
 * LE ETICHETTE DEL CLIENTE (ondata 1).
 *
 * Il valore resta quello che è — lo scrivono i record, i filtri, le condizioni
 * delle regole — e a schermo si legge l'etichetta che l'admin ha scritto nel
 * Dizionario. Prima la pastiglia mostrava il valore con le iniziali maiuscole,
 * e per i vocabolari SPEDITI quella è una parola inglese in un'interfaccia
 * italiana: «CRITICAL» invece di «CRITICA».
 */
describe('SeverityBadge — etichette per valore', () => {
  it('mostra l\'etichetta del cliente, non il valore', () => {
    withVocabulary(['low', 'medium', 'high', 'critical'], <SeverityBadge value="critical" />, { critical: 'Critica' })
    expect(screen.getByText('Critica')).toBeInTheDocument()
    expect(screen.queryByText('Critical')).not.toBeInTheDocument()
  })

  it('il `title` porta SEMPRE il valore: è quello che si cerca nei filtri e si trova nei log', () => {
    withVocabulary(['critical'], <SeverityBadge value="critical" />, { critical: 'Critica' })
    expect(screen.getByText('Critica')).toHaveAttribute('title', 'critical')
  })

  it('senza etichetta resta il valore con le iniziali maiuscole, come prima', () => {
    withVocabulary(['high'], <SeverityBadge value="high" />)
    expect(screen.getByText('High')).toBeInTheDocument()
  })

  it('l\'etichetta si cerca nel vocabolario GIUSTO: la stessa parola vale diversamente', () => {
    // `low` è «Basso» per l'impatto e «Bassa» per l'urgenza: la pastiglia deve
    // chiedere al vocabolario che le è stato dato, non a uno qualsiasi.
    withVocabulary(['low'], <SeverityBadge value="low" vocabulary="impact" />, { low: 'Basso' })
    expect(screen.getByText('Basso')).toBeInTheDocument()
  })
})
