/**
 * awsConnector — the defensive edges the main suite does not reach.
 *
 * AWS returns partial objects all the time (a DB still being created has no
 * identifier, a load balancer being torn down loses its name, a certificate
 * describe can come back empty). Each of these must be SKIPPED, not turned into
 * a CI with an undefined external id — that would make reconciliation merge
 * unrelated resources under the same key. And an unexpected ECS error must stop
 * the run with context, never degrade silently into "no image".
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SyncSourceConfig } from '@opengraphity/discovery'

// ── Mock SDK AWS ──────────────────────────────────────────────────────────────

type Input = Record<string, unknown>
type Cmd = { readonly kind: string; readonly input: Input }

const h = vi.hoisted(() => {
  const send = vi.fn<(cmd: { kind: string; input: Record<string, unknown> }) => Promise<unknown>>()
  const clientOpts: Array<{ client: string; opts: unknown }> = []
  const cmd = (kind: string) => class {
    readonly kind = kind
    constructor(readonly input: Record<string, unknown> = {}) {}
  }
  const client = (name: string) => class {
    constructor(opts: unknown) { clientOpts.push({ client: name, opts }) }
    send = send
  }
  return { send, clientOpts, cmd, client }
})

vi.mock('@aws-sdk/client-ec2', () => ({
  EC2Client:                h.client('EC2Client'),
  DescribeInstancesCommand: h.cmd('DescribeInstances'),
  DescribeRegionsCommand:   h.cmd('DescribeRegions'),
}))
vi.mock('@aws-sdk/client-rds', () => ({
  RDSClient:                  h.client('RDSClient'),
  DescribeDBInstancesCommand: h.cmd('DescribeDBInstances'),
}))
vi.mock('@aws-sdk/client-elastic-load-balancing-v2', () => ({
  ElasticLoadBalancingV2Client: h.client('ElasticLoadBalancingV2Client'),
  DescribeLoadBalancersCommand: h.cmd('DescribeLoadBalancers'),
  DescribeTargetGroupsCommand:  h.cmd('DescribeTargetGroups'),
  DescribeTargetHealthCommand:  h.cmd('DescribeTargetHealth'),
}))
vi.mock('@aws-sdk/client-acm', () => ({
  ACMClient:                  h.client('ACMClient'),
  ListCertificatesCommand:    h.cmd('ListCertificates'),
  DescribeCertificateCommand: h.cmd('DescribeCertificate'),
}))
vi.mock('@aws-sdk/client-lambda', () => ({
  LambdaClient:         h.client('LambdaClient'),
  ListFunctionsCommand: h.cmd('ListFunctions'),
}))
vi.mock('@aws-sdk/client-ecs', () => ({
  ECSClient:                     h.client('ECSClient'),
  ListClustersCommand:           h.cmd('ListClusters'),
  ListServicesCommand:           h.cmd('ListServices'),
  DescribeServicesCommand:       h.cmd('DescribeServices'),
  DescribeTaskDefinitionCommand: h.cmd('DescribeTaskDefinition'),
}))
vi.mock('../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

const { awsConnector } = await import('../connectors/aws.js')

// ── Helpers ───────────────────────────────────────────────────────────────────

const CREDS = { access_key_id: 'AKIA-TEST', secret_access_key: 'shh' }

function source(config: Record<string, unknown>): SyncSourceConfig {
  return {
    id: 'src-aws', tenant_id: 't1', name: 'aws', connector_type: 'aws',
    encrypted_credentials: '', config, mapping_rules: [], schedule_cron: null, enabled: true,
    last_sync_at: null, last_sync_status: null, last_sync_duration_ms: null,
    created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z',
  }
}

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = []
  for await (const x of it) out.push(x)
  return out
}

/** Responses per command kind; a function receives the command input. */
type Responder = Record<string, Record<string, unknown> | ((input: Input) => unknown)>
function respond(map: Responder) {
  h.send.mockImplementation(async (c) => {
    const r = map[c.kind]
    if (r === undefined) throw new Error(`no mock response for ${c.kind}`)
    return typeof r === 'function' ? r(c.input) : r
  })
}

const sentCommands = (kind: string): Cmd[] =>
  h.send.mock.calls.map(([c]) => c as Cmd).filter(c => c.kind === kind)

beforeEach(() => {
  h.send.mockReset()
  h.clientOpts.length = 0
})

describe('awsConnector.scan — partial AWS objects are skipped, not half-mapped', () => {
  it('RDS: an instance without identifier is skipped; without DbiResourceId the identifier is the external id', async () => {
    respond({
      DescribeDBInstances: { DBInstances: [{ Engine: 'postgres' }, { DBInstanceIdentifier: 'orders-db', Engine: 'mysql' }] },
    })
    const cis = await collect(awsConnector.scan(source({ resource_types: 'rds' }), CREDS))
    expect(cis.map(c => [c.external_id, c.name, c.ci_type])).toEqual([['orders-db', 'orders-db', 'database_instance']])
  })

  it('ELB: load balancers without arn or name and target groups without arn are skipped; non-EC2 targets are not relations', async () => {
    respond({
      DescribeLoadBalancers: { LoadBalancers: [
        { LoadBalancerName: 'no-arn' },
        { LoadBalancerArn: 'arn:lb-noname' },
        { LoadBalancerArn: 'arn:lb-1', LoadBalancerName: 'web-lb', State: { Code: 'active' } },
      ] },
      DescribeTargetGroups: { TargetGroups: [{}, { TargetGroupArn: 'arn:tg-1' }] },
      DescribeTargetHealth: { TargetHealthDescriptions: [
        { Target: { Id: '10.0.0.5' } }, { Target: {} }, { Target: { Id: 'i-abc' } },
      ] },
    })
    const cis = await collect(awsConnector.scan(source({ resource_types: 'elb' }), CREDS))
    expect(cis).toHaveLength(1)
    expect(cis[0]).toMatchObject({ external_id: 'arn:lb-1', name: 'web-lb', properties: { state: 'active' } })
    // Only the instance id (i-…) becomes a relation: an IP target has no CI to point at.
    expect(cis[0]!.relationships).toEqual([{ target_external_id: 'i-abc', relation_type: 'DEPENDS_ON', direction: 'outgoing' }])
    // The skipped target group (no arn) never reached DescribeTargetHealth.
    expect(sentCommands('DescribeTargetHealth').map(c => c.input['TargetGroupArn'])).toEqual(['arn:tg-1'])
  })

  it('ACM: summaries without arn and empty describes are skipped; without a domain the arn names the CI', async () => {
    respond({
      ListCertificates: { CertificateSummaryList: [{}, { CertificateArn: 'arn:empty' }, { CertificateArn: 'arn:nodomain' }] },
      DescribeCertificate: (input) => (input['CertificateArn'] === 'arn:empty' ? {} : { Certificate: { Status: 'ISSUED' } }),
    })
    const cis = await collect(awsConnector.scan(source({ resource_types: 'acm' }), CREDS))
    expect(cis.map(c => [c.external_id, c.name])).toEqual([['arn:nodomain', 'arn:nodomain']])
    expect(cis[0]!.properties).toMatchObject({ status: 'ISSUED', expiry_date: undefined, san: undefined })
  })

  it('Lambda: a function without name or arn is skipped; without VPC it has no relations', async () => {
    respond({
      ListFunctions: { Functions: [{ FunctionName: 'orphan' }, { FunctionName: 'fn', FunctionArn: 'arn:fn' }] },
    })
    const cis = await collect(awsConnector.scan(source({ resource_types: 'lambda' }), CREDS))
    expect(cis.map(c => [c.external_id, c.relationships])).toEqual([['arn:fn', []]])
  })

  it('ECS: an empty service page ends the cluster; services without arn/name are skipped; no task definition = no image', async () => {
    respond({
      ListClusters: { clusterArns: ['arn:aws:ecs:eu:1:cluster/prod', 'arn:aws:ecs:eu:1:cluster/empty'] },
      ListServices: (input) => (input['cluster'] === 'arn:aws:ecs:eu:1:cluster/empty' ? { serviceArns: [] } : { serviceArns: ['arn:s1', 'arn:s2'] }),
      DescribeServices: { services: [{ serviceName: 'no-arn' }, { serviceArn: 'arn:s2', serviceName: 'api', status: 'ACTIVE' }] },
    })
    const cis = await collect(awsConnector.scan(source({ resource_types: 'ecs' }), CREDS))
    expect(cis).toHaveLength(1)
    expect(cis[0]).toMatchObject({ external_id: 'arn:s2', name: 'api', properties: { cluster: 'prod', image: undefined } })
    // The empty cluster never asked for a DescribeServices with an empty list (AWS rejects it).
    expect(sentCommands('DescribeServices').map(c => c.input['cluster'])).toEqual(['arn:aws:ecs:eu:1:cluster/prod'])
    expect(sentCommands('DescribeTaskDefinition')).toHaveLength(0)
  })

  it('ECS: a task-definition error that is not ClientException stops the run with context', async () => {
    const throttled = new Error('Rate exceeded'); throttled.name = 'ThrottlingException'
    respond({
      ListClusters: { clusterArns: ['arn:c/prod'] },
      ListServices: { serviceArns: ['arn:s1'] },
      DescribeServices: { services: [{ serviceArn: 'arn:s1', serviceName: 'api', taskDefinition: 'td:3' }] },
      DescribeTaskDefinition: () => { throw throttled },
    })
    await expect(collect(awsConnector.scan(source({ resource_types: 'ecs', regions: 'eu-south-1' }), CREDS)))
      .rejects.toThrow(/ECS task definition describe \(region eu-south-1, td:3\).*Rate exceeded/)
  })
})
