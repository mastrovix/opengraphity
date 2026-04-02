export type {
  DiscoveredCI,
  DiscoveredRelation,
  MappingRule,
  SyncSourceConfig,
  SyncRunResult,
  SyncConflictData,
  CIDiscoveryMetadata,
} from './types.js'

export type {
  Connector,
  CredentialFieldDefinition,
  ConfigFieldDefinition,
} from './connector.js'

export {
  registerConnector,
  getConnector,
  getAllConnectors,
} from './registry.js'

export {
  encryptCredentials,
  decryptCredentials,
  validateEncryptionKey,
  generateEncryptionKey,
} from './encryption.js'

export {
  applyMappingRules,
  inferCIType,
  normalizeProperties,
} from './mapping.js'
