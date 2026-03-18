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
        <div style={{ padding: 40, textAlign: 'center', color: '#dc2626' }}>
          <h2>Qualcosa è andato storto</h2>
          <p style={{ color: '#8892a4', fontSize: 14 }}>
            {this.state.error?.message}
          </p>
          <button
            onClick={() => this.setState({ hasError: false })}
            style={{
              marginTop:    16,
              padding:      '8px 16px',
              background:   '#4f46e5',
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
