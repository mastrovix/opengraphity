import { Component, type ErrorInfo, type ReactNode } from 'react'
import { clientLogger } from '../lib/clientLogger'

interface Props {
  children:  ReactNode
  fallback?: ReactNode
}

interface State {
  hasError: boolean
  error?:   Error
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    clientLogger.error(`React error: ${error.message}`, {
      stack:          error.stack?.slice(0, 500),
      componentStack: info.componentStack?.slice(0, 500),
    })
  }

  render(): ReactNode {
    if (this.state.hasError) {
      return this.props.fallback ?? (
        <div style={{ padding: 40, textAlign: 'center', color: 'var(--color-trigger-sla-breach)' }}>
          <h2>Qualcosa è andato storto</h2>
          <p style={{ color: 'var(--color-slate-light)', fontSize: 14 }}>
            {this.state.error?.message}
          </p>
          <button
            onClick={() => this.setState({ hasError: false })}
            style={{
              marginTop:    16,
              padding:      '8px 16px',
              background:   'var(--color-brand)',
              color:        '#fff',
              border:       'none',
              borderRadius: 6,
              cursor:       'pointer',
            }}
          >
            Riprova
          </button>
        </div>
      )
    }
    return this.props.children
  }
}
