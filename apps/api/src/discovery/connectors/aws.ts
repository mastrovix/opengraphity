import type {
  Connector,
  CredentialFieldDefinition,
  ConfigFieldDefinition,
  DiscoveredCI,
  DiscoveredRelation,
  SyncSourceConfig,
} from '@opengraphity/discovery'
import { logger } from '../../lib/logger.js'
import {
  connectorError, errorNamed, guardScan, paginate, probeConnection,
  requireCreds, resourceTypeSet, resourceTypesField, tagsToRecord,
} from './base.js'
import { splitList, toBool } from './normalize.js'

// ── AWS Connector ─────────────────────────────────────────────────────────────
// Discovers EC2, RDS, ELB/ALB, ACM certificates, Lambda functions, ECS services.
// Credentials: access_key_id, secret_access_key, (optional) session_token.
// Config: regions (comma-separated), include_stopped (bool), resource_types (comma-sep).

const TYPE = 'aws'

type AwsConfig = {
  regions?:         string | string[]
  include_stopped?: boolean | string
  resource_types?:  string
}

const ALL_RESOURCE_TYPES = ['ec2', 'rds', 'elb', 'acm', 'lambda', 'ecs'] as const
const DEFAULT_REGION     = 'us-east-1'

function getRegions(config: AwsConfig): string[] {
  const regions = splitList(config.regions)
  return regions.length ? regions : [DEFAULT_REGION]
}

function awsCreds(creds: Record<string, string>) {
  requireCreds(TYPE, creds, ['access_key_id', 'secret_access_key'])
  return {
    accessKeyId:     creds['access_key_id']!,
    secretAccessKey: creds['secret_access_key']!,
    ...(creds['session_token'] ? { sessionToken: creds['session_token'] } : {}),
  }
}

type AwsCredentials = ReturnType<typeof awsCreds>

function base(externalId: string, ciType: string, name: string, properties: Record<string, unknown>): DiscoveredCI {
  return { external_id: externalId, source: TYPE, ci_type: ciType, name, properties, tags: {}, relationships: [] }
}

// ── Per-resource scanners ─────────────────────────────────────────────────────

async function* scanEc2(region: string, credentials: AwsCredentials, inclStopped: boolean): AsyncIterable<DiscoveredCI> {
  const { EC2Client, DescribeInstancesCommand } = await import('@aws-sdk/client-ec2')
  const ec2 = new EC2Client({ region, credentials })

  for await (const resp of paginate(
    token => ec2.send(new DescribeInstancesCommand({
      Filters:    inclStopped ? [] : [{ Name: 'instance-state-name', Values: ['running', 'pending'] }],
      NextToken:  token,
      MaxResults: 100,
    })),
    r => r.NextToken,
  )) {
    for (const reservation of resp.Reservations ?? []) {
      for (const inst of reservation.Instances ?? []) {
        if (!inst.InstanceId) continue
        const tags = tagsToRecord(inst.Tags)
        yield {
          ...base(inst.InstanceId, 'server', tags['Name'] ?? inst.InstanceId, {
            instance_type:     inst.InstanceType,
            private_ip:        inst.PrivateIpAddress,
            public_ip:         inst.PublicIpAddress,
            platform:          inst.Platform ?? 'linux',
            state:             inst.State?.Name,
            availability_zone: inst.Placement?.AvailabilityZone,
            vpc_id:            inst.VpcId,
            subnet_id:         inst.SubnetId,
            region,
            account_id:        reservation.OwnerId,
          }),
          tags,
        }
      }
    }
  }
}

async function* scanRds(region: string, credentials: AwsCredentials): AsyncIterable<DiscoveredCI> {
  const { RDSClient, DescribeDBInstancesCommand } = await import('@aws-sdk/client-rds')
  const rds = new RDSClient({ region, credentials })

  for await (const resp of paginate(
    marker => rds.send(new DescribeDBInstancesCommand({ Marker: marker, MaxRecords: 100 })),
    r => r.Marker,
  )) {
    for (const db of resp.DBInstances ?? []) {
      if (!db.DBInstanceIdentifier) continue
      yield base(db.DbiResourceId ?? db.DBInstanceIdentifier, 'database_instance', db.DBInstanceIdentifier, {
        engine:            db.Engine,
        engine_version:    db.EngineVersion,
        instance_class:    db.DBInstanceClass,
        status:            db.DBInstanceStatus,
        endpoint:          db.Endpoint?.Address,
        port:              db.Endpoint?.Port,
        multi_az:          db.MultiAZ,
        storage_type:      db.StorageType,
        allocated_storage: db.AllocatedStorage,
        region,
      })
    }
  }
}

async function* scanElb(region: string, credentials: AwsCredentials): AsyncIterable<DiscoveredCI> {
  const {
    ElasticLoadBalancingV2Client,
    DescribeLoadBalancersCommand,
    DescribeTargetGroupsCommand,
    DescribeTargetHealthCommand,
  } = await import('@aws-sdk/client-elastic-load-balancing-v2')
  const elb = new ElasticLoadBalancingV2Client({ region, credentials })

  for await (const lbResp of paginate(
    marker => elb.send(new DescribeLoadBalancersCommand({ Marker: marker, PageSize: 100 })),
    r => r.NextMarker,
  )) {
    for (const lb of lbResp.LoadBalancers ?? []) {
      if (!lb.LoadBalancerArn || !lb.LoadBalancerName) continue

      const tgResp = await elb.send(new DescribeTargetGroupsCommand({ LoadBalancerArn: lb.LoadBalancerArn }))
      const relationships: DiscoveredRelation[] = []

      for (const tg of tgResp.TargetGroups ?? []) {
        if (!tg.TargetGroupArn) continue
        try {
          const healthResp = await elb.send(new DescribeTargetHealthCommand({ TargetGroupArn: tg.TargetGroupArn }))
          for (const hd of healthResp.TargetHealthDescriptions ?? []) {
            const instanceId = hd.Target?.Id
            if (instanceId?.startsWith('i-')) {
              relationships.push({ target_external_id: instanceId, relation_type: 'DEPENDS_ON', direction: 'outgoing' })
            }
          }
        } catch (err) {
          // Legit skip: target group deleted between DescribeTargetGroups and DescribeTargetHealth — anything else must fail the run.
          if (!errorNamed(err, 'TargetGroupNotFoundException')) {
            throw connectorError(TYPE, `ELB target health lookup (region ${region}, target group ${tg.TargetGroupArn})`, err)
          }
          logger.debug({ err, arn: tg.TargetGroupArn }, '[aws] ELB target group vanished mid-scan, skipping')
        }
      }

      yield {
        ...base(lb.LoadBalancerArn, 'load_balancer', lb.LoadBalancerName, {
          dns_name: lb.DNSName,
          scheme:   lb.Scheme,
          type:     lb.Type,
          vpc_id:   lb.VpcId,
          state:    lb.State?.Code,
          region,
        }),
        relationships,
      }
    }
  }
}

async function* scanAcm(region: string, credentials: AwsCredentials): AsyncIterable<DiscoveredCI> {
  const { ACMClient, ListCertificatesCommand, DescribeCertificateCommand } = await import('@aws-sdk/client-acm')
  const acm = new ACMClient({ region, credentials })

  for await (const listResp of paginate(
    token => acm.send(new ListCertificatesCommand({ NextToken: token, MaxItems: 100 })),
    r => r.NextToken,
  )) {
    for (const cert of listResp.CertificateSummaryList ?? []) {
      if (!cert.CertificateArn) continue
      let c
      try {
        c = (await acm.send(new DescribeCertificateCommand({ CertificateArn: cert.CertificateArn }))).Certificate
      } catch (err) {
        // Legit skip: certificate deleted between ListCertificates and DescribeCertificate — anything else must fail the run.
        if (!errorNamed(err, 'ResourceNotFoundException')) {
          throw connectorError(TYPE, `ACM certificate describe (region ${region}, arn ${cert.CertificateArn})`, err)
        }
        logger.debug({ err, arn: cert.CertificateArn }, '[aws] ACM certificate vanished mid-scan, skipping')
        continue
      }
      if (!c) continue

      yield base(cert.CertificateArn, 'certificate', c.DomainName ?? cert.CertificateArn, {
        domain:      c.DomainName,
        status:      c.Status,
        expiry_date: c.NotAfter?.toISOString(),
        issuer:      c.Issuer,
        san:         c.SubjectAlternativeNames?.join(', '),
        region,
      })
    }
  }
}

async function* scanLambda(region: string, credentials: AwsCredentials): AsyncIterable<DiscoveredCI> {
  const { LambdaClient, ListFunctionsCommand } = await import('@aws-sdk/client-lambda')
  const lambda = new LambdaClient({ region, credentials })

  for await (const resp of paginate(
    marker => lambda.send(new ListFunctionsCommand({ Marker: marker, MaxItems: 100 })),
    r => r.NextMarker,
  )) {
    for (const fn of resp.Functions ?? []) {
      if (!fn.FunctionName || !fn.FunctionArn) continue
      const relationships: DiscoveredRelation[] = (fn.VpcConfig?.SubnetIds ?? []).map(subnetId => ({
        target_external_id: subnetId, relation_type: 'HOSTED_ON', direction: 'outgoing',
      }))
      yield {
        ...base(fn.FunctionArn, 'application', fn.FunctionName, {
          runtime:       fn.Runtime,
          memory_mb:     fn.MemorySize,
          timeout_s:     fn.Timeout,
          handler:       fn.Handler,
          last_modified: fn.LastModified,
          role:          fn.Role,
          region,
        }),
        relationships,
      }
    }
  }
}

async function* scanEcs(region: string, credentials: AwsCredentials): AsyncIterable<DiscoveredCI> {
  const {
    ECSClient, ListClustersCommand, ListServicesCommand, DescribeServicesCommand, DescribeTaskDefinitionCommand,
  } = await import('@aws-sdk/client-ecs')
  const ecs = new ECSClient({ region, credentials })

  for await (const clusterResp of paginate(
    token => ecs.send(new ListClustersCommand({ nextToken: token, maxResults: 100 })),
    r => r.nextToken,
  )) {
    for (const clusterArn of clusterResp.clusterArns ?? []) {
      const clusterName = clusterArn.split('/').pop() ?? clusterArn

      for await (const svcListResp of paginate(
        token => ecs.send(new ListServicesCommand({ cluster: clusterArn, nextToken: token, maxResults: 100 })),
        r => r.nextToken,
      )) {
        const arns = svcListResp.serviceArns ?? []
        if (arns.length === 0) break

        const descResp = await ecs.send(new DescribeServicesCommand({ cluster: clusterArn, services: arns }))
        for (const svc of descResp.services ?? []) {
          if (!svc.serviceArn || !svc.serviceName) continue

          let image: string | undefined
          if (svc.taskDefinition) {
            try {
              const tdResp = await ecs.send(new DescribeTaskDefinitionCommand({ taskDefinition: svc.taskDefinition }))
              image = tdResp.taskDefinition?.containerDefinitions?.[0]?.image
            } catch (err) {
              // Legit fallback: services can reference deregistered/deleted task definitions (ClientException) — anything else must fail the run.
              if (!errorNamed(err, 'ClientException')) {
                throw connectorError(TYPE, `ECS task definition describe (region ${region}, ${svc.taskDefinition})`, err)
              }
              image = svc.taskDefinition
            }
          }

          yield base(svc.serviceArn, 'application', svc.serviceName, {
            cluster:       clusterName,
            desired_count: svc.desiredCount,
            running_count: svc.runningCount,
            launch_type:   svc.launchType,
            image,
            status:        svc.status,
            region,
          })
        }
      }
    }
  }
}

const SCANNERS: Record<typeof ALL_RESOURCE_TYPES[number], {
  label: string
  run:   (region: string, credentials: AwsCredentials, inclStopped: boolean) => AsyncIterable<DiscoveredCI>
}> = {
  ec2:    { label: 'EC2 scan',    run: scanEc2 },
  rds:    { label: 'RDS scan',    run: scanRds },
  elb:    { label: 'ELB scan',    run: scanElb },
  acm:    { label: 'ACM scan',    run: scanAcm },
  lambda: { label: 'Lambda scan', run: scanLambda },
  ecs:    { label: 'ECS scan',    run: scanEcs },
}

// ── Connector ─────────────────────────────────────────────────────────────────

export const awsConnector: Connector = {
  type:             TYPE,
  displayName:      'AWS',
  supportedCITypes: ['server', 'database_instance', 'load_balancer', 'certificate', 'application'],

  async *scan(config: SyncSourceConfig, creds: Record<string, string>): AsyncIterable<DiscoveredCI> {
    const cfg         = config.config as AwsConfig
    const regions     = getRegions(cfg)
    const inclStopped = toBool(cfg.include_stopped) ?? false
    const types       = resourceTypeSet(TYPE, cfg.resource_types, ALL_RESOURCE_TYPES)
    const credentials = awsCreds(creds)

    for (const region of regions) {
      for (const type of ALL_RESOURCE_TYPES) {
        if (!types.has(type)) continue
        const { label, run } = SCANNERS[type]
        yield* guardScan(TYPE, `${label} (region ${region})`, () => run(region, credentials, inclStopped))
      }
    }
  },

  testConnection(config: SyncSourceConfig, creds: Record<string, string>) {
    return probeConnection('AWS', async () => {
      const regions = getRegions(config.config as AwsConfig)
      const { EC2Client, DescribeRegionsCommand } = await import('@aws-sdk/client-ec2')
      const ec2 = new EC2Client({ region: regions[0]!, credentials: awsCreds(creds) })
      await ec2.send(new DescribeRegionsCommand({ RegionNames: regions }))
      return `Connected to AWS (${regions.join(', ')})`
    })
  },

  getRequiredCredentialFields(): CredentialFieldDefinition[] {
    return [
      { name: 'access_key_id',     label: 'Access Key ID',     type: 'text',     required: true,  placeholder: 'AKIA...' },
      { name: 'secret_access_key', label: 'Secret Access Key', type: 'password', required: true },
      { name: 'session_token',     label: 'Session Token',     type: 'password', required: false,
        help_text: 'Only required for temporary credentials (STS/role assumption)' },
    ]
  },

  getConfigFields(): ConfigFieldDefinition[] {
    return [
      {
        name:          'regions',
        label:         'Regions',
        type:          'text',
        required:      false,
        default_value: DEFAULT_REGION,
        help_text:     'Comma-separated list of AWS regions to scan',
      },
      resourceTypesField(ALL_RESOURCE_TYPES),
      {
        name:          'include_stopped',
        label:         'Include Stopped EC2 Instances',
        type:          'boolean',
        required:      false,
        default_value: false,
      },
    ]
  },
}
