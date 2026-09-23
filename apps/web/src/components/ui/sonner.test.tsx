/**
 * THE TOASTER OF THE APP: where every «saved», «failed» and «deleted» appears.
 *
 * The wrapper is mounted once in `main.tsx`. It gives the toasts the product's
 * icons (so an error reads as an error at a glance), the product's toast class
 * and the colours of the current theme, and it must pass through what the app
 * sets on it (the position). If it regresses, feedback after every action
 * either disappears or looks like somebody else's widget.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { act, render, screen, within } from '@testing-library/react'
import { ThemeProvider } from 'next-themes'
import { toast } from 'sonner'
import { Toaster } from './sonner'

afterEach(() => { act(() => { toast.dismiss() }) })

/** The toast list item that shows `text`. */
const toastWith = async (text: string) => (await screen.findByText(text)).closest('li[data-sonner-toast]') as HTMLElement

describe('Toaster', () => {
  it('a success toast appears with the product check icon and the product toast class', async () => {
    render(<Toaster />)
    act(() => { toast.success('Contract saved') })
    const item = await toastWith('Contract saved')
    expect(item).toHaveClass('cn-toast')
    expect(item).toHaveAttribute('data-type', 'success')
    const icon = item.querySelector('[data-icon] svg')!
    expect(icon).toHaveClass('lucide-circle-check', 'size-4')
  })

  it('each kind of toast carries its own icon: an error is not drawn like a success', async () => {
    render(<Toaster />)
    act(() => {
      toast.error('Save failed')
      toast.warning('Calendar missing')
      toast.info('Report queued')
    })
    expect((await toastWith('Save failed')).querySelector('[data-icon] svg')).toHaveClass('lucide-octagon-x')
    expect((await toastWith('Calendar missing')).querySelector('[data-icon] svg')).toHaveClass('lucide-triangle-alert')
    expect((await toastWith('Report queued')).querySelector('[data-icon] svg')).toHaveClass('lucide-info')
  })

  it('a loading toast spins the product loader', async () => {
    render(<Toaster />)
    act(() => { toast.loading('Exporting…') })
    const icon = (await toastWith('Exporting…')).querySelector('[data-icon] svg')
    expect(icon).toHaveClass('lucide-loader-circle', 'animate-spin')
  })

  it('without a theme provider it follows the system preference (light here), and keeps the position the app asks for', async () => {
    render(<Toaster position="top-right" />)
    act(() => { toast('Hello') })
    const list = (await toastWith('Hello')).closest('ol')!
    expect(list).toHaveAttribute('data-sonner-theme', 'light')
    expect(list).toHaveAttribute('data-y-position', 'top')
    expect(list).toHaveAttribute('data-x-position', 'right')
  })

  it('inside a theme provider the toasts take the chosen theme', async () => {
    // next-themes writes an inline script to set the theme before paint; React notes, on the client, that it does not run it.
    vi.spyOn(console, 'error').mockImplementation(() => {})
    render(<ThemeProvider attribute="class" defaultTheme="dark" enableSystem={false}><Toaster /></ThemeProvider>)
    act(() => { toast('Dark hello') })
    expect((await toastWith('Dark hello')).closest('ol')).toHaveAttribute('data-sonner-theme', 'dark')
  })

  it('the notifications region is announced politely to screen readers', async () => {
    render(<Toaster />)
    act(() => { toast('Announced') })
    const region = screen.getByRole('region', { name: /Notifications/ })
    expect(region).toHaveAttribute('aria-live', 'polite')
    expect(await within(region).findByText('Announced')).toBeInTheDocument()
  })
})
