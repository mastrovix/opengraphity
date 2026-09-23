import { Component, type ErrorInfo, type ReactNode } from 'react'
import i18n from '@/i18n/i18n'
import { clientLogger } from '../lib/clientLogger'
import { errorMessage } from '@/lib/showError'
import { colors } from '@/lib/tokens'

interface Props {
  children:  ReactNode
  fallback?: ReactNode
}

interface State {
  hasError: boolean
  /** The text of what was thrown. */
  message?: string
}

/*
 * Anything can be thrown, not only an Error: a library that throws a string
 * lost its text on both sides, because both read `.message` — the log said
 * «React error: undefined» and the screen gave no reason (found by the tests,
 * tour of 23 Sep 2026). `errorMessage` reads any thrown value.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false }

  static getDerivedStateFromError(error: unknown): State {
    return { hasError: true, message: errorMessage(error) }
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    clientLogger.error(`React error: ${errorMessage(error)}`, {
      stack:          error instanceof Error ? error.stack?.slice(0, 500) : undefined,
      componentStack: info.componentStack?.slice(0, 500),
    })
  }

  render(): ReactNode {
    if (this.state.hasError) {
      // Class component: niente hook, si usa i18n.t direttamente.
      return this.props.fallback ?? (
        <div role="alert" style={{ padding: 40, textAlign: 'center', color: 'var(--color-trigger-sla-breach)' }}>
          <h2>{i18n.t('errorBoundary.title')}</h2>
          <p style={{ color: 'var(--color-slate-light)', fontSize: 'var(--font-size-body)' }}>
            {this.state.message}
          </p>
          <button
            type="button"
            onClick={() => this.setState({ hasError: false })}
            style={{
              marginTop:    16,
              padding:      '8px 16px',
              background:   'var(--color-brand)',
              color:        colors.white,
              border:       'none',
              borderRadius: 6,
              cursor:       'pointer',
            }}
          >
            {i18n.t('errorBoundary.retry')}
          </button>
        </div>
      )
    }
    return this.props.children
  }
}
