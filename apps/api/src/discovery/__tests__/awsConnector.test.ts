/**
 * awsConnector — SDK mockati (client con `send`), nessuna rete.
 * Pinna: paginazione a token, mapping tag→CI, resource_types sconosciuti,
 * testConnection ok/ko, include_stopped, credenziali mancanti, errori
 * arricchiti (mai inghiottiti) e gli skip legittimi (ResourceNotFound).
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

/** Risposte per tipo di comando; una funzione riceve l'input del comando. */
type Responder = Record<string, Record<string, unknown> | ((input: Input) => unknown)>
function respond(map: Responder) {
  h.send.mockImplementation(async (c) => {
    const r = map[c.kind]
    if (r === undefined) throw new Error(`nessuna risposta mock per ${c.kind}`)
    return typeof r === 'function' ? r(c.input) : r
  })
}

const sentCommands = (kind: string): Cmd[] =>
  h.send.mock.calls.map(([c]) => c as Cmd).filter(c => c.kind === kind)

const EMPTY: Responder = {
  DescribeInstances:     { Reservations: [] },
  DescribeDBInstances:   { DBInstances: [] },
  DescribeLoadBalancers: { LoadBalancers: [] },
  ListCertificates:      { CertificateSummaryList: [] },
  ListFunctions:         { Functions: [] },
  ListClusters:          { clusterArns: [] },
}

beforeEach(() => {
  h.send.mockReset()
  h.clientOpts.length = 0
})

// ── Config / credenziali ──────────────────────────────────────────────────────

describe('awsConnector.scan — config e credenziali', () => {
  it('rifiuta resource_types sconosciuti con errore esplicito (nessuna scansione vuota)', async () => {
    respond(EMPTY)
    await expect(collect(awsConnector.scan(source({ resource_types: 'ec2, ec3' }), CREDS)))
      .rejects.toThrow('[aws] config failed: resource_types sconosciuti: ec3 (ammessi: ec2, rds, elb, acm, lambda, ecs)')
    expect(h.send).not.toHaveBeenCalled()
  })

  it('rifiuta credenziali mancanti prima di istanziare qualunque client', async () => {
    respond(EMPTY)
    await expect(collect(awsConnector.scan(source({}), { access_key_id: 'AKIA' })))
      .rejects.toThrow('[aws] credentials failed: credenziali mancanti: secret_access_key')
    await expect(collect(awsConnector.scan(source({}), { access_key_id: ' ', secret_access_key: '' })))
      .rejects.toThrow('credenziali mancanti: access_key_id, secret_access_key')
    expect(h.clientOpts).toHaveLength(0)
  })

  it('passa le credenziali (con session_token opzionale) e la regione al client', async () => {
    respond(EMPTY)
    await collect(awsConnector.scan(source({ regions: 'eu-west-1', resource_types: 'ec2' }), { ...CREDS, session_token: 'tok' }))
    expect(h.clientOpts).toEqual([{
      client: 'EC2Client',
      opts:   { region: 'eu-west-1', credentials: { accessKeyId: 'AKIA-TEST', secretAccessKey: 'shh', sessionToken: 'tok' } },
    }])
  })

  it('senza regioni usa us-east-1; con più regioni scansiona ciascuna', async () => {
    respond(EMPTY)
    await collect(awsConnector.scan(source({ resource_types: 'rds' }), CREDS))
    expect(h.clientOpts.map(c => (c.opts as { region: string }).region)).toEqual(['us-east-1'])

    h.clientOpts.length = 0
    await collect(awsConnector.scan(source({ resource_types: 'rds', regions: 'eu-west-1, eu-south-1' }), CREDS))
    expect(h.clientOpts.map(c => (c.opts as { region: string }).region)).toEqual(['eu-west-1', 'eu-south-1'])
  })
})

// ── EC2: paginazione, mapping, include_stopped ────────────────────────────────

describe('awsConnector.scan — EC2', () => {
  const instance = (id: string, extra: Input = {}) => ({
    InstanceId: id, InstanceType: 't3.micro', PrivateIpAddress: '10.0.0.1', PublicIpAddress: '3.3.3.3',
    State: { Name: 'running' }, Placement: { AvailabilityZone: 'eu-west-1a' }, VpcId: 'vpc-1', SubnetId: 'sub-1',
    Tags: [{ Key: 'Name', Value: `srv-${id}` }, { Key: 'Cost Center', Value: 'CC-9' }, { Key: 'NoValue' }],
    ...extra,
  })

  it('segue NextToken su due pagine e raccoglie tutte le istanze', async () => {
    respond({
      ...EMPTY,
      DescribeInstances: (input) => input['NextToken'] === undefined
        ? { Reservations: [{ OwnerId: '123', Instances: [instance('i-1')] }], NextToken: 'page-2' }
        : { Reservations: [{ OwnerId: '123', Instances: [instance('i-2'), instance('i-3')] }] },
    })
    const cis = await collect(awsConnector.scan(source({ regions: 'eu-west-1', resource_types: 'ec2' }), CREDS))
    expect(cis.map(c => c.external_id)).toEqual(['i-1', 'i-2', 'i-3'])

    const calls = sentCommands('DescribeInstances')
    expect(calls).toHaveLength(2)
    expect(calls[0]!.input['NextToken']).toBeUndefined()
    expect(calls[1]!.input['NextToken']).toBe('page-2')
    expect(calls[1]!.input['MaxResults']).toBe(100)
  })

  it('mappa istanza + tag nel CI normalizzato (tag Name → name, chiavi tag grezze)', async () => {
    respond({ ...EMPTY, DescribeInstances: { Reservations: [{ OwnerId: '123456789012', Instances: [instance('i-abc', { Platform: 'windows' })] }] } })
    const [ci] = await collect(awsConnector.scan(source({ regions: 'eu-west-1', resource_types: 'ec2' }), CREDS))
    expect(ci).toEqual({
      external_id: 'i-abc',
      source:      'aws',
      ci_type:     'server',
      name:        'srv-i-abc',
      properties: {
        instance_type:     't3.micro',
        private_ip:        '10.0.0.1',
        public_ip:         '3.3.3.3',
        platform:          'windows',
        state:             'running',
        availability_zone: 'eu-west-1a',
        vpc_id:            'vpc-1',
        subnet_id:         'sub-1',
        region:            'eu-west-1',
        account_id:        '123456789012',
      },
      tags:          { Name: 'srv-i-abc', 'Cost Center': 'CC-9' },
      relationships: [],
    })
  })

  it('senza tag Name usa InstanceId come nome, platform default linux, salta istanze senza id', async () => {
    respond({ ...EMPTY, DescribeInstances: { Reservations: [{ Instances: [
      { InstanceId: 'i-noname', State: { Name: 'running' } },
      { InstanceType: 'orphan' },
    ] }] } })
    const cis = await collect(awsConnector.scan(source({ resource_types: 'ec2' }), CREDS))
    expect(cis).toHaveLength(1)
    expect(cis[0]).toMatchObject({ name: 'i-noname', properties: { platform: 'linux', state: 'running' }, tags: {} })
  })

  it('include_stopped: di default filtra running/pending lato API; con il flag nessun filtro', async () => {
    respond(EMPTY)
    await collect(awsConnector.scan(source({ resource_types: 'ec2' }), CREDS))
    expect(sentCommands('DescribeInstances')[0]!.input['Filters'])
      .toEqual([{ Name: 'instance-state-name', Values: ['running', 'pending'] }])

    h.send.mockClear()
    await collect(awsConnector.scan(source({ resource_types: 'ec2', include_stopped: 'true' }), CREDS))
    expect(sentCommands('DescribeInstances')[0]!.input['Filters']).toEqual([])

    h.send.mockClear()
    await collect(awsConnector.scan(source({ resource_types: 'ec2', include_stopped: true }), CREDS))
    expect(sentCommands('DescribeInstances')[0]!.input['Filters']).toEqual([])
  })

  it('include_stopped non booleano → errore esplicito (niente "yes" accettato in silenzio)', async () => {
    respond(EMPTY)
    await expect(collect(awsConnector.scan(source({ resource_types: 'ec2', include_stopped: 'yes' }), CREDS)))
      .rejects.toThrow(/toBool: valore non booleano "yes"/)
  })

  it('un errore dell\'SDK viene rilanciato arricchito con connettore, operazione e regione', async () => {
    respond({ ...EMPTY, DescribeInstances: () => { throw new Error('AccessDenied') } })
    await expect(collect(awsConnector.scan(source({ regions: 'eu-west-1', resource_types: 'ec2' }), CREDS)))
      .rejects.toThrow('[aws] EC2 scan (region eu-west-1) failed: AccessDenied')
  })
})

// ── RDS / Lambda / ACM / ELB / ECS ────────────────────────────────────────────

describe('awsConnector.scan — altri scanner', () => {
  it('RDS: pagina con Marker e mappa DbiResourceId come external_id', async () => {
    respond({
      ...EMPTY,
      DescribeDBInstances: (input) => input['Marker'] === undefined
        ? { DBInstances: [{ DBInstanceIdentifier: 'db-a', DbiResourceId: 'db-RES-A', Engine: 'postgres', EngineVersion: '16.1',
            DBInstanceClass: 'db.t3.medium', DBInstanceStatus: 'available', Endpoint: { Address: 'a.rds', Port: 5432 },
            MultiAZ: true, StorageType: 'gp3', AllocatedStorage: 20 }], Marker: 'm2' }
        : { DBInstances: [{ DBInstanceIdentifier: 'db-b' }] },
    })
    const cis = await collect(awsConnector.scan(source({ regions: 'eu-west-1', resource_types: 'rds' }), CREDS))
    expect(cis.map(c => c.external_id)).toEqual(['db-RES-A', 'db-b'])
    expect(cis[0]).toMatchObject({
      ci_type: 'database_instance', name: 'db-a',
      properties: { engine: 'postgres', engine_version: '16.1', instance_class: 'db.t3.medium', status: 'available',
        endpoint: 'a.rds', port: 5432, multi_az: true, storage_type: 'gp3', allocated_storage: 20, region: 'eu-west-1' },
    })
    expect(sentCommands('DescribeDBInstances')[1]!.input['Marker']).toBe('m2')
  })

  it('Lambda: pagina con NextMarker e crea relazioni HOSTED_ON verso le subnet VPC', async () => {
    respond({
      ...EMPTY,
      ListFunctions: (input) => input['Marker'] === undefined
        ? { Functions: [{ FunctionName: 'fn-a', FunctionArn: 'arn:fn-a', Runtime: 'nodejs20.x', MemorySize: 256, Timeout: 30,
            Handler: 'index.handler', LastModified: '2026-01-01', Role: 'arn:role', VpcConfig: { SubnetIds: ['subnet-1', 'subnet-2'] } }],
            NextMarker: 'nm' }
        : { Functions: [{ FunctionName: 'fn-b', FunctionArn: 'arn:fn-b' }, { FunctionName: 'no-arn' }] },
    })
    const cis = await collect(awsConnector.scan(source({ resource_types: 'lambda' }), CREDS))
    expect(cis.map(c => c.external_id)).toEqual(['arn:fn-a', 'arn:fn-b'])
    expect(cis[0]).toMatchObject({
      ci_type: 'application', name: 'fn-a',
      properties: { runtime: 'nodejs20.x', memory_mb: 256, timeout_s: 30, handler: 'index.handler', role: 'arn:role', region: 'us-east-1' },
      relationships: [
        { target_external_id: 'subnet-1', relation_type: 'HOSTED_ON', direction: 'outgoing' },
        { target_external_id: 'subnet-2', relation_type: 'HOSTED_ON', direction: 'outgoing' },
      ],
    })
    expect(sentCommands('ListFunctions')[1]!.input['Marker']).toBe('nm')
  })

  it('ACM: mappa il certificato; ResourceNotFoundException sul describe è uno skip, altri errori fermano la scansione', async () => {
    const notFound = new Error('gone'); notFound.name = 'ResourceNotFoundException'
    respond({
      ...EMPTY,
      ListCertificates: { CertificateSummaryList: [{ CertificateArn: 'arn:c1' }, { CertificateArn: 'arn:c2' }] },
      DescribeCertificate: (input) => {
        if (input['CertificateArn'] === 'arn:c2') throw notFound
        return { Certificate: { DomainName: 'api.example.com', Status: 'ISSUED', NotAfter: new Date('2027-01-01T00:00:00Z'),
          Issuer: 'Amazon', SubjectAlternativeNames: ['api.example.com', 'www.example.com'] } }
      },
    })
    const cis = await collect(awsConnector.scan(source({ resource_types: 'acm' }), CREDS))
    expect(cis).toHaveLength(1)
    expect(cis[0]).toMatchObject({
      external_id: 'arn:c1', ci_type: 'certificate', name: 'api.example.com',
      properties: { domain: 'api.example.com', status: 'ISSUED', expiry_date: '2027-01-01T00:00:00.000Z', issuer: 'Amazon',
        san: 'api.example.com, www.example.com', region: 'us-east-1' },
    })

    respond({
      ...EMPTY,
      ListCertificates:    { CertificateSummaryList: [{ CertificateArn: 'arn:c1' }] },
      DescribeCertificate: () => { throw new Error('Throttling') },
    })
    await expect(collect(awsConnector.scan(source({ resource_types: 'acm' }), CREDS)))
      .rejects.toThrow('[aws] ACM certificate describe (region us-east-1, arn arn:c1) failed: Throttling')
  })

  it('ELB: relazioni DEPENDS_ON verso le istanze EC2 dei target group; TargetGroupNotFound è skip, altro errore ferma', async () => {
    const tgGone = new Error('tg gone'); tgGone.name = 'TargetGroupNotFoundException'
    respond({
      ...EMPTY,
      DescribeLoadBalancers: { LoadBalancers: [{ LoadBalancerArn: 'arn:lb', LoadBalancerName: 'alb-1', DNSName: 'alb.aws', Scheme: 'internet-facing',
        Type: 'application', VpcId: 'vpc-1', State: { Code: 'active' } }] },
      DescribeTargetGroups:  { TargetGroups: [{ TargetGroupArn: 'arn:tg1' }, { TargetGroupArn: 'arn:tg2' }] },
      DescribeTargetHealth:  (input) => {
        if (input['TargetGroupArn'] === 'arn:tg2') throw tgGone
        return { TargetHealthDescriptions: [{ Target: { Id: 'i-1' } }, { Target: { Id: '10.0.0.5' } }] }
      },
    })
    const [lb] = await collect(awsConnector.scan(source({ resource_types: 'elb' }), CREDS))
    expect(lb).toMatchObject({
      external_id: 'arn:lb', ci_type: 'load_balancer', name: 'alb-1',
      properties: { dns_name: 'alb.aws', scheme: 'internet-facing', type: 'application', vpc_id: 'vpc-1', state: 'active', region: 'us-east-1' },
      relationships: [{ target_external_id: 'i-1', relation_type: 'DEPENDS_ON', direction: 'outgoing' }],
    })

    respond({
      ...EMPTY,
      DescribeLoadBalancers: { LoadBalancers: [{ LoadBalancerArn: 'arn:lb', LoadBalancerName: 'alb-1' }] },
      DescribeTargetGroups:  { TargetGroups: [{ TargetGroupArn: 'arn:tg1' }] },
      DescribeTargetHealth:  () => { throw new Error('AccessDenied') },
    })
    await expect(collect(awsConnector.scan(source({ resource_types: 'elb' }), CREDS)))
      .rejects.toThrow('[aws] ELB target health lookup (region us-east-1, target group arn:tg1) failed: AccessDenied')
  })

  it('ECS: cluster → servizi (paginati) → immagine dalla task definition; ClientException → fallback all\'arn', async () => {
    const clientEx = new Error('deregistered'); clientEx.name = 'ClientException'
    respond({
      ...EMPTY,
      ListClusters:  { clusterArns: ['arn:aws:ecs:eu:1:cluster/prod'] },
      ListServices:  (input) => input['nextToken'] === undefined
        ? { serviceArns: ['arn:svc-a'], nextToken: 'n2' }
        : { serviceArns: ['arn:svc-b'] },
      DescribeServices: (input) => ({ services: (input['services'] as string[]).map(arn => ({
        serviceArn: arn, serviceName: arn.replace('arn:', ''), desiredCount: 2, runningCount: 2, launchType: 'FARGATE',
        status: 'ACTIVE', taskDefinition: arn === 'arn:svc-a' ? 'td-a:1' : 'td-b:7',
      })) }),
      DescribeTaskDefinition: (input) => {
        if (input['taskDefinition'] === 'td-b:7') throw clientEx
        return { taskDefinition: { containerDefinitions: [{ image: 'repo/svc-a:1.0' }] } }
      },
    })
    const cis = await collect(awsConnector.scan(source({ resource_types: 'ecs' }), CREDS))
    expect(cis.map(c => [c.name, c.properties['image'], c.properties['cluster']])).toEqual([
      ['svc-a', 'repo/svc-a:1.0', 'prod'],
      ['svc-b', 'td-b:7',         'prod'],
    ])
    expect(cis[0]).toMatchObject({ ci_type: 'application', properties: { desired_count: 2, running_count: 2, launch_type: 'FARGATE', status: 'ACTIVE' } })
    expect(sentCommands('ListServices').map(c => c.input['nextToken'])).toEqual([undefined, 'n2'])
  })

  it('rispetta l\'ordine e il sottoinsieme di resource_types richiesto', async () => {
    respond(EMPTY)
    await collect(awsConnector.scan(source({ resource_types: 'lambda, ec2' }), CREDS))
    expect(h.clientOpts.map(c => c.client)).toEqual(['EC2Client', 'LambdaClient'])
  })
})

// ── testConnection ────────────────────────────────────────────────────────────

describe('awsConnector.testConnection', () => {
  it('ok: DescribeRegions con le regioni configurate', async () => {
    respond({ DescribeRegions: { Regions: [] } })
    await expect(awsConnector.testConnection(source({ regions: 'eu-west-1, eu-south-1' }), CREDS))
      .resolves.toEqual({ ok: true, message: 'Connected to AWS (eu-west-1, eu-south-1)' })
    expect(sentCommands('DescribeRegions')[0]!.input).toEqual({ RegionNames: ['eu-west-1', 'eu-south-1'] })
    expect(h.clientOpts[0]).toMatchObject({ client: 'EC2Client', opts: { region: 'eu-west-1' } })
  })

  it('ko: l\'errore del client diventa { ok:false } con prefisso uniforme, non un throw', async () => {
    respond({ DescribeRegions: () => { throw new Error('UnrecognizedClientException') } })
    await expect(awsConnector.testConnection(source({}), CREDS))
      .resolves.toEqual({ ok: false, message: 'AWS connection failed: UnrecognizedClientException' })
  })

  it('ko: credenziali mancanti → { ok:false } senza chiamare l\'SDK', async () => {
    respond({ DescribeRegions: {} })
    await expect(awsConnector.testConnection(source({}), {}))
      .resolves.toEqual({ ok: false, message: 'AWS connection failed: [aws] credentials failed: credenziali mancanti: access_key_id, secret_access_key' })
    expect(h.send).not.toHaveBeenCalled()
  })
})

describe('awsConnector metadata', () => {
  it('dichiara credenziali, regioni, resource_types e include_stopped', () => {
    expect(awsConnector.getRequiredCredentialFields().map(f => [f.name, f.required]))
      .toEqual([['access_key_id', true], ['secret_access_key', true], ['session_token', false]])
    expect(awsConnector.getConfigFields()).toMatchObject([
      { name: 'regions', default_value: 'us-east-1' },
      { name: 'resource_types', default_value: 'ec2, rds, elb, acm, lambda, ecs' },
      { name: 'include_stopped', type: 'boolean', default_value: false },
    ])
    expect(awsConnector.supportedCITypes).toEqual(['server', 'database_instance', 'load_balancer', 'certificate', 'application'])
  })
})
