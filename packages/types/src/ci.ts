export type CIType =
  | 'server'
  | 'virtual_machine'
  | 'database_instance'
  | 'database'
  | 'application'
  | 'microservice'
  | 'network_device'
  | 'storage'
  | 'cloud_service'
  | 'ssl_certificate'
  | 'api_endpoint'

export type CIStatus = 'operational' | 'degraded' | 'down' | 'maintenance'
export type CICriticality = 'low' | 'medium' | 'high' | 'critical'
export type CIEnvironment = 'production' | 'staging' | 'development'

export interface ServerMetadata {
  os: string
  cpu_cores: number
  ram_gb: number
  ip_address: string
  location?: string
}

export interface VirtualMachineMetadata {
  os: string
  cpu_cores: number
  ram_gb: number
  hypervisor: 'VMware' | 'Hyper-V' | 'KVM' | 'Proxmox'
}

export interface DatabaseInstanceMetadata {
  engine: 'MySQL' | 'PostgreSQL' | 'Oracle' | 'SQLServer' | 'MongoDB' | 'Redis' | 'Other'
  version: string
  port: number
  host: string
}

export interface DatabaseMetadata {
  name: string
  charset?: string
  size_gb?: number
}

export interface ApplicationMetadata {
  version: string
  language: string
  framework?: string
  url?: string
}

export interface MicroserviceMetadata {
  version: string
  language: string
  port: number
  container_image?: string
}

export interface NetworkDeviceMetadata {
  device_type: 'switch' | 'router' | 'firewall' | 'load_balancer'
  vendor: string
  model: string
  ip_address: string
  location?: string
}

export interface StorageMetadata {
  storage_type: 'NAS' | 'SAN' | 'backup' | 'object'
  capacity_tb: number
  vendor?: string
}

export interface CloudServiceMetadata {
  provider: 'AWS' | 'Azure' | 'GCP' | 'Other'
  region: string
  service_name: string
  resource_id?: string
}

export interface SSLCertificateMetadata {
  domain: string
  issuer: string
  expiry_date: string
  auto_renew: boolean
}

export interface ApiEndpointMetadata {
  url: string
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | '*'
  auth_type: 'none' | 'api_key' | 'oauth2' | 'basic'
  provider?: string
}

export type CIMetadata =
  | ServerMetadata
  | VirtualMachineMetadata
  | DatabaseInstanceMetadata
  | DatabaseMetadata
  | ApplicationMetadata
  | MicroserviceMetadata
  | NetworkDeviceMetadata
  | StorageMetadata
  | CloudServiceMetadata
  | SSLCertificateMetadata
  | ApiEndpointMetadata

export type CIDependencyType =
  | 'depends_on'
  | 'hosted_on'
  | 'connects_to'
  | 'backed_up_by'
  | 'protected_by'

export interface Team {
  id: string
  tenant_id: string
  name: string
}

export interface ConfigurationItem {
  id: string
  tenant_id: string
  name: string
  type: CIType
  status: CIStatus
  environment: CIEnvironment
  criticality: CICriticality
  description?: string
  metadata: CIMetadata
  created_at: string
  updated_at: string
  /** NOT stored on Neo4j — populated at runtime by query */
  owner_group?: Team
  /** NOT stored on Neo4j — populated at runtime by query */
  support_group?: Team
}

export interface CIDependency {
  from_id: string
  to_id: string
  type: CIDependencyType
  criticality: CICriticality
}
