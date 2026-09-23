/**
 * THE PIECES SHARED BY THE MONITORING PAGES (sources, wizard, edit page, event).
 *
 * The badge of a monitoring tool, the active/inactive pill, and the «copy»
 * buttons for the endpoint address, the token and the ready-made snippets.
 * What must hold: a tool the client does not know is shown as broken and
 * reported, not dressed as another tool; a copy the browser refuses is SAID,
 * and the caller is told it did not happen — the wizard relies on that to
 * know whether the token was really put somewhere safe (D·1.9) before it is
 * shown for the last time.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { BellRing, Webhook } from 'lucide-react'
import { TOOL_META, toolMeta, ToolBadge, EnabledPill, copyToClipboard, CopyButton, SecretBox, SnippetBox } from './monitoringShared'

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
vi.mock('sonner', () => ({ toast }))

let writeText: ReturnType<typeof vi.fn>

beforeEach(() => {
  toast.success.mockReset()
  toast.error.mockReset()
  writeText = vi.fn(async () => {})
  Object.defineProperty(window.navigator, 'clipboard', { value: { writeText }, configurable: true })
})

describe('toolMeta and ToolBadge', () => {
  it('a known tool has its icon and colour, and its name in the reader\'s language', () => {
    expect(toolMeta('alertmanager')).toBe(TOOL_META.alertmanager)
    expect(toolMeta('alertmanager').icon).toBe(BellRing)
    render(<ToolBadge kind="grafana" />)
    expect(screen.getByText('Grafana')).toBeInTheDocument()
  })

  it('a tool the client does not know is shown as broken, in red, and reported', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const meta = toolMeta('nagios')
    expect(meta.icon).toBe(Webhook)
    expect(meta.color).toBe('var(--color-danger)')
    expect(consoleError).toHaveBeenCalledWith('[TOOL_META] unknown value: "nagios"')
  })

  it('a source without a tool shows a dash, and is reported as well', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    render(<ToolBadge kind={null} />)
    expect(screen.getByText('—')).toBeInTheDocument()
    expect(consoleError).toHaveBeenCalledWith('[TOOL_META] unknown value: ""')
  })
})

describe('EnabledPill', () => {
  it('says whether the source is active', () => {
    const { rerender } = render(<EnabledPill enabled />)
    expect(screen.getByText('Active')).toBeInTheDocument()
    rerender(<EnabledPill enabled={false} />)
    expect(screen.getByText('Inactive')).toBeInTheDocument()
  })
})

describe('copying', () => {
  it('a copy that works is confirmed, and reported as done', async () => {
    await expect(copyToClipboard('https://hooks.acme/abc', 'Copied!')).resolves.toBe(true)
    expect(writeText).toHaveBeenCalledWith('https://hooks.acme/abc')
    expect(toast.success).toHaveBeenCalledWith('Copied!')
  })

  it('a copy the browser refuses is said with its reason, and reported as not done', async () => {
    writeText.mockRejectedValue(new Error('Write permission denied'))
    await expect(copyToClipboard('secret', 'Copied!')).resolves.toBe(false)
    expect(toast.error).toHaveBeenCalledWith('Write permission denied')
    expect(toast.success).not.toHaveBeenCalled()
  })

  it('the copy button tells its caller only when the copy happened', async () => {
    const onCopied = vi.fn()
    render(<CopyButton text="tok_123" label="Copy the token" onCopied={onCopied} />)
    screen.getByRole('button', { name: 'Copy the token' }).click()
    await waitFor(() => expect(onCopied).toHaveBeenCalledTimes(1))
    expect(toast.success).toHaveBeenCalledWith('Copied!')

    writeText.mockRejectedValue(new Error('denied'))
    screen.getByRole('button', { name: 'Copy the token' }).click()
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('denied'))
    expect(onCopied).toHaveBeenCalledTimes(1)
  })

  it('a copy button with no caller to tell still copies', async () => {
    render(<CopyButton text="plain" label="Copy" />)
    screen.getByRole('button', { name: 'Copy' }).click()
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('plain'))
  })

  it('the secret box shows the value under its label, with its warning, and copies it', async () => {
    const onCopied = vi.fn()
    render(<SecretBox label="Token" value="tok_123" copyLabel="Copy the token" hint="Shown only once" onCopied={onCopied} />)
    expect(screen.getByRole('status', { name: 'Token' })).toHaveTextContent('tok_123')
    expect(screen.getByText('Shown only once')).toBeInTheDocument()
    screen.getByRole('button', { name: 'Copy the token' }).click()
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('tok_123'))
    expect(onCopied).toHaveBeenCalledTimes(1)
  })

  it('the snippet box shows the ready-made configuration and copies it whole', async () => {
    const yaml = 'receivers:\n  - name: opengrafo'
    render(<SnippetBox title="Alertmanager" text={yaml} copyLabel="Copy the snippet" />)
    expect(screen.getByText('Alertmanager')).toBeInTheDocument()
    screen.getByRole('button', { name: 'Copy the snippet' }).click()
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(yaml))
  })
})
