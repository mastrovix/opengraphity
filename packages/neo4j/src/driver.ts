import neo4j, { Driver, Session, SessionMode } from 'neo4j-driver'

const NEO4J_URI      = process.env['NEO4J_URI']      ?? 'neo4j://localhost:7687'
const NEO4J_USER     = process.env['NEO4J_USER']     ?? 'neo4j'
const NEO4J_PASSWORD = process.env['NEO4J_PASSWORD'] ?? 'opengraphity_local'

let _driver: Driver | null = null

function createDriver(): Driver {
  const d = neo4j.driver(
    NEO4J_URI,
    neo4j.auth.basic(NEO4J_USER, NEO4J_PASSWORD),
  )

  d.verifyConnectivity()
    .then(() => console.log(`[neo4j] Connected to ${NEO4J_URI}`))
    .catch((err: unknown) => console.error('[neo4j] Connection failed:', err))

  return d
}

export function getDriver(): Driver {
  if (!_driver) {
    _driver = createDriver()
  }
  return _driver
}

export const driver: Driver = getDriver()

export function getSession(
  database?: string,
  accessMode: SessionMode = neo4j.session.READ,
): Session {
  return getDriver().session({
    database,
    defaultAccessMode: accessMode,
  })
}

export async function closeDriver(): Promise<void> {
  if (_driver) {
    await _driver.close()
    _driver = null
    console.log('[neo4j] Driver closed')
  }
}
