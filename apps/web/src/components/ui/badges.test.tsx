import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { SeverityBadge, RoleBadge, RiskBadge, riskLevel, SEVERITY_STYLE, PhaseBadge, StatusLabel } from './badges'
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
) {
  return render(
    <DomainVocabularyContext.Provider value={{
      valuesOf:  () => values,
      labelOf:   (_n, v) => labels[v] ?? null,
      entriesOf: () => (values ? values.map((v) => ({ value: v, label: labels[v] ?? v })) : null),
      loading: false,
      error: null,
    }}>
      {ui}
    </DomainVocabularyContext.Provider>,
  )
}

describe('SeverityBadge', () => {
  it.each(Object.keys(SEVERITY_STYLE))('%s → pill con la palette dedicata', (sev) => {
    withVocabulary(Object.keys(SEVERITY_STYLE), <SeverityBadge value={sev} />)
    const pill = screen.getByText(enumLabel(sev))
    expect(pill).toHaveStyle({ background: SEVERITY_STYLE[sev]!.bg, color: SEVERITY_STYLE[sev]!.color, textTransform: 'uppercase' })
    expect(consoleError).not.toHaveBeenCalled()
  })
  it('critical e low hanno colori diversi (prima erano testo grigio identico)', () => {
    expect(SEVERITY_STYLE['critical']).not.toEqual(SEVERITY_STYLE['low'])
  })
  it('valore assente → "—"', () => {
    withVocabulary(null, <SeverityBadge value={null} />)
    expect(screen.getByText('—')).toBeInTheDocument()
  })

  /**
   * CONTRATTO RINEGOZIATO (ondata 7 · D-15). Prima questo test pretendeva che
   * `<SeverityBadge value="blocker" />` rendesse una pastiglia **rossa piena**
   * con `console.error`: la regola «niente fallback silenziosi» applicata a un
   * valore che il cliente ha tutto il diritto di avere nel suo vocabolario. In
   * una lista di incident diventavano cinquanta pastiglie rosse e cinquanta
   * righe di errore in console, e la personalizzazione sembrava rotta.
   *
   * Adesso i due casi sono distinti, e sono tre righe di test invece di una.
   */
  it('valore NEL vocabolario del cliente senza stile assegnato → neutro e silenzioso', () => {
    withVocabulary([...Object.keys(SEVERITY_STYLE), 'blocker'], <SeverityBadge value="blocker" />)
    expect(screen.getByText('Blocker')).toHaveStyle({ background: NEUTRAL_VALUE_STYLE.bg, color: NEUTRAL_VALUE_STYLE.color })
    expect(consoleError).not.toHaveBeenCalled()
  })
  it('valore FUORI dal vocabolario del cliente → stile rotto (rosso) e console.error', () => {
    withVocabulary(Object.keys(SEVERITY_STYLE), <SeverityBadge value="blocker" />)
    expect(screen.getByText('Blocker')).toHaveStyle({ background: BROKEN_BG, color: 'var(--color-white)' })
    expect(consoleError).toHaveBeenCalledWith('[SEVERITY_STYLE/severity] "blocker" non è nel vocabolario di questo cliente (critical, high, medium, low)')
  })
  it('vocabolario non disponibile → neutro e console.warn (non si accusa di essere rotto ciò che non si è potuto verificare)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    withVocabulary(null, <SeverityBadge value="blocker" />)
    expect(screen.getByText('Blocker')).toHaveStyle({ background: NEUTRAL_VALUE_STYLE.bg })
    expect(consoleError).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith('[SEVERITY_STYLE/severity] "blocker" senza stile e vocabolario del cliente non disponibile: stile neutro')
  })
})

describe('RoleBadge', () => {
  it.each([['admin', 'Admin'], ['operator', 'Operator'], ['viewer', 'Viewer'], ['end_user', 'End user']])('%s → "%s"', (role, label) => {
    render(<RoleBadge role={role} />)
    expect(screen.getByText(label)).toBeInTheDocument()
    expect(consoleError).not.toHaveBeenCalled()
  })
  it('ruolo assente → "—"; ruolo ignoto → etichetta grezza in rosso + log', () => {
    const { rerender } = render(<RoleBadge role={undefined} />)
    expect(screen.getByText('—')).toBeInTheDocument()
    rerender(<RoleBadge role="superuser" />)
    expect(screen.getByText('superuser')).toHaveStyle({ background: BROKEN_BG })
    expect(consoleError).toHaveBeenCalledWith('[ROLE_STYLE] valore sconosciuto: "superuser"')
  })
})

describe('RiskBadge / riskLevel', () => {
  it.each([[0, 'low'], [30, 'low'], [31, 'medium'], [60, 'medium'], [61, 'high'], [100, 'high']])('score %d → %s', (score, level) => {
    expect(riskLevel(score)).toBe(level)
  })
  it('mostra "LIVELLO · score", in compact solo il numero, con tooltip', () => {
    const { rerender } = render(<RiskBadge score={45} />)
    expect(screen.getByText('MEDIUM · 45')).toHaveAttribute('title', 'MEDIUM · score 45')
    rerender(<RiskBadge score={72} compact />)
    expect(screen.getByText('72')).toHaveAttribute('title', 'HIGH · score 72')
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
    expect(consoleError).toHaveBeenCalledWith('[workflowStepStyle] categoria sconosciuta: "galactic"')
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
