import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { SeverityBadge, RoleBadge, RiskBadge, riskLevel, SEVERITY_STYLE, PhaseBadge, StatusLabel } from './badges'

const BROKEN_BG = 'var(--color-danger)'
let consoleError: ReturnType<typeof vi.spyOn>
beforeEach(() => { consoleError = vi.spyOn(console, 'error').mockImplementation(() => {}) })

describe('SeverityBadge', () => {
  it.each(Object.keys(SEVERITY_STYLE))('%s → pill con la palette dedicata', (sev) => {
    render(<SeverityBadge value={sev} />)
    const pill = screen.getByText(sev)
    expect(pill).toHaveStyle({ background: SEVERITY_STYLE[sev]!.bg, color: SEVERITY_STYLE[sev]!.color, textTransform: 'uppercase' })
    expect(consoleError).not.toHaveBeenCalled()
  })
  it('critical e low hanno colori diversi (prima erano testo grigio identico)', () => {
    expect(SEVERITY_STYLE['critical']).not.toEqual(SEVERITY_STYLE['low'])
  })
  it('valore assente → "—"', () => {
    render(<SeverityBadge value={null} />)
    expect(screen.getByText('—')).toBeInTheDocument()
  })
  it('valore ignoto → stile "rotto" rosso e console.error, il testo resta visibile', () => {
    render(<SeverityBadge value="blocker" />)
    expect(screen.getByText('blocker')).toHaveStyle({ background: BROKEN_BG, color: 'var(--color-white)' })
    expect(consoleError).toHaveBeenCalledWith('[SEVERITY_STYLE] valore sconosciuto: "blocker"')
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
