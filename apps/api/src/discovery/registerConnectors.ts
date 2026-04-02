import { registerConnector } from '@opengraphity/discovery'
import { awsConnector }        from './connectors/aws.js'
import { azureConnector }      from './connectors/azure.js'
import { gcpConnector }        from './connectors/gcp.js'
import { kubernetesConnector } from './connectors/kubernetes.js'
import { csvConnector }        from './connectors/csv.js'
import { jsonConnector }       from './connectors/json.js'
import { logger }              from '../lib/logger.js'

export function registerAllConnectors(): void {
  const connectors = [
    awsConnector,
    azureConnector,
    gcpConnector,
    kubernetesConnector,
    csvConnector,
    jsonConnector,
  ]

  for (const connector of connectors) {
    try {
      registerConnector(connector)
      logger.debug({ type: connector.type }, '[connectors] Registered connector')
    } catch (err) {
      // Already registered (e.g. hot reload) — safe to ignore
      logger.debug({ type: connector.type }, '[connectors] Connector already registered, skipping')
    }
  }

  logger.info({ count: connectors.length }, '[connectors] All discovery connectors registered')
}
