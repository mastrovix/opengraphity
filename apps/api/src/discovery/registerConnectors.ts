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
      // Only the documented duplicate-registration case (hot reload) may be
      // skipped — any other failure must propagate, not be mislabeled.
      if (err instanceof Error && /already registered/i.test(err.message)) {
        logger.debug({ type: connector.type }, '[connectors] Connector already registered, skipping')
      } else {
        throw err
      }
    }
  }

  logger.info({ count: connectors.length }, '[connectors] All discovery connectors registered')
}
