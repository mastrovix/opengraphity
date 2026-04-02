import type { Connector } from './connector.js'

// ── Connector registry ────────────────────────────────────────────────────────

const connectors = new Map<string, Connector>()

export function registerConnector(connector: Connector): void {
  if (connectors.has(connector.type)) {
    throw new Error(`Connector type "${connector.type}" is already registered`)
  }
  connectors.set(connector.type, connector)
}

export function getConnector(type: string): Connector | undefined {
  return connectors.get(type)
}

export function getAllConnectors(): Connector[] {
  return Array.from(connectors.values())
}
