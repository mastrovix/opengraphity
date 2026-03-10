const TOKEN = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ0ZW5hbnRfaWQiOiJ0ZW5hbnQtZGVtbyIsInVzZXJfaWQiOiJ1c2VyLTAwMSIsImVtYWlsIjoiYWRtaW5AZGVtby5vcGVuZ3JhcGhpdHkuaW8iLCJyb2xlIjoiYWRtaW4iLCJpYXQiOjE3NzI5ODEwNDcsImV4cCI6MTc3MzA2NzQ0N30._OnPQBIK9qwzevxliTkrWfRj3nT82ebAhUIWoAb_OVs'
const URL   = 'http://localhost:4000/graphql'

const CIS = [
  { name: 'web-prod-01',        type: 'server',            status: 'active',         environment: 'production'  },
  { name: 'web-prod-02',        type: 'server',            status: 'active',         environment: 'production'  },
  { name: 'db-primary',         type: 'database',          status: 'active',         environment: 'production'  },
  { name: 'db-replica',         type: 'database',          status: 'active',         environment: 'production'  },
  { name: 'api-gateway',        type: 'api_endpoint',      status: 'active',         environment: 'production'  },
  { name: 'auth-service',       type: 'microservice',      status: 'active',         environment: 'production'  },
  { name: 'payment-service',    type: 'microservice',      status: 'active',         environment: 'production'  },
  { name: 'notification-svc',   type: 'microservice',      status: 'maintenance',    environment: 'production'  },
  { name: 'k8s-node-01',        type: 'virtual_machine',   status: 'active',         environment: 'production'  },
  { name: 'k8s-node-02',        type: 'virtual_machine',   status: 'active',         environment: 'production'  },
  { name: 'k8s-node-03',        type: 'virtual_machine',   status: 'inactive',       environment: 'production'  },
  { name: 'nas-storage-01',     type: 'storage',           status: 'active',         environment: 'production'  },
  { name: 'cdn-cloudfront',     type: 'cloud_service',     status: 'active',         environment: 'production'  },
  { name: 'redis-cache',        type: 'cloud_service',     status: 'active',         environment: 'production'  },
  { name: 'ssl-wildcard-demo',  type: 'ssl_certificate',   status: 'active',         environment: 'production'  },
  { name: 'load-balancer',      type: 'network_device',    status: 'active',         environment: 'production'  },
  { name: 'firewall-edge',      type: 'network_device',    status: 'active',         environment: 'production'  },
  { name: 'erp-app',            type: 'application',       status: 'active',         environment: 'production'  },
  { name: 'web-staging-01',     type: 'server',            status: 'active',         environment: 'staging'     },
  { name: 'db-staging',         type: 'database_instance', status: 'active',         environment: 'staging'     },
  { name: 'crm-app',            type: 'application',       status: 'active',         environment: 'staging'     },
  { name: 'dev-postgres',       type: 'database',          status: 'active',         environment: 'development' },
  { name: 'dev-api',            type: 'api_endpoint',      status: 'active',         environment: 'development' },
  { name: 'dr-web-01',          type: 'server',            status: 'inactive',       environment: 'dr'          },
  { name: 'dr-db-01',           type: 'database',          status: 'inactive',       environment: 'dr'          },
  { name: 'legacy-ftp',         type: 'server',            status: 'decommissioned', environment: 'production'  },
]

const MUTATION = `
  mutation CreateCI($input: CreateCIInput!) {
    createConfigurationItem(input: $input) { id name }
  }
`

async function seed() {
  let ok = 0
  for (const ci of CIS) {
    const res = await fetch(URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
      body:    JSON.stringify({ query: MUTATION, variables: { input: ci } }),
    })
    const json = await res.json() as { data?: { createConfigurationItem?: { id: string; name: string } }; errors?: unknown[] }
    if (json.errors) {
      console.error(`✗ ${ci.name}:`, JSON.stringify(json.errors))
    } else {
      console.log(`✓ ${json.data?.createConfigurationItem?.id}  ${ci.name}`)
      ok++
    }
  }
  console.log(`\nSeeded ${ok}/${CIS.length} CIs`)
}

seed().catch(console.error)
