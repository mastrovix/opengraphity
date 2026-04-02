import type {
  Connector,
  CredentialFieldDefinition,
  ConfigFieldDefinition,
  DiscoveredCI,
  DiscoveredRelation,
  SyncSourceConfig,
} from '@opengraphity/discovery'
import { logger } from '../../lib/logger.js'

// ── AWS Connector ─────────────────────────────────────────────────────────────
// Discovers EC2, RDS, ELB/ALB, ACM certificates, Lambda functions, ECS services.
// Credentials: access_key_id, secret_access_key, (optional) session_token.
// Config: regions (comma-separated), include_stopped (bool), resource_types (comma-sep).

type AwsConfig = {
  regions?:         string | string[]
  include_stopped?: boolean | string
  resource_types?:  string
}

const ALL_RESOURCE_TYPES = ['ec2', 'rds', 'elb', 'acm', 'lambda', 'ecs'] as const

function getRegions(config: AwsConfig): string[] {
  const r = config.regions
  if (!r) return ['us-east-1']
  if (Array.isArray(r)) return r
  return r.split(',').map(s => s.trim()).filter(Boolean)
}

function getResourceTypes(config: AwsConfig): Set<string> {
  const raw = config.resource_types
  if (!raw) return new Set(ALL_RESOURCE_TYPES)
  return new Set(raw.split(',').map(s => s.trim()).filter(Boolean))
}

function awsCreds(creds: Record<string, string>) {
  return {
    accessKeyId:     creds['access_key_id']!,
    secretAccessKey: creds['secret_access_key']!,
    ...(creds['session_token'] ? { sessionToken: creds['session_token'] } : {}),
  }
}

export const awsConnector: Connector = {
  type:             'aws',
  displayName:      'AWS',
  supportedCITypes: ['server', 'database_instance', 'load_balancer', 'certificate', 'application'],

  async *scan(config: SyncSourceConfig, creds: Record<string, string>): AsyncIterable<DiscoveredCI> {
    const cfg          = config.config as AwsConfig
    const regions      = getRegions(cfg)
    const inclStopped  = String(cfg.include_stopped) === 'true'
    const types        = getResourceTypes(cfg)
    const credentials  = awsCreds(creds)

    for (const region of regions) {
      // ── EC2 Instances ────────────────────────────────────────────────────
      if (types.has('ec2')) {
        try {
          const { EC2Client, DescribeInstancesCommand } = await import('@aws-sdk/client-ec2')
          const ec2 = new EC2Client({ region, credentials })
          let nextToken: string | undefined

          do {
            const resp = await ec2.send(new DescribeInstancesCommand({
              Filters:    inclStopped ? [] : [{ Name: 'instance-state-name', Values: ['running', 'pending'] }],
              NextToken:  nextToken,
              MaxResults: 100,
            }))

            for (const reservation of resp.Reservations ?? []) {
              for (const inst of reservation.Instances ?? []) {
                if (!inst.InstanceId) continue

                const nameTag = inst.Tags?.find(t => t.Key === 'Name')?.Value ?? inst.InstanceId
                const tags: Record<string, string> = {}
                for (const t of inst.Tags ?? []) {
                  if (t.Key && t.Value) tags[t.Key] = t.Value
                }

                yield {
                  external_id: inst.InstanceId,
                  source:      'aws',
                  ci_type:     'server',
                  name:        nameTag,
                  properties:  {
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
                  },
                  tags,
                  relationships: [],
                }
              }
            }
            nextToken = resp.NextToken
          } while (nextToken)
        } catch (err) {
          logger.warn({ err, region }, '[aws] EC2 scan error')
        }
      }

      // ── RDS Instances ────────────────────────────────────────────────────
      if (types.has('rds')) {
        try {
          const { RDSClient, DescribeDBInstancesCommand } = await import('@aws-sdk/client-rds')
          const rds = new RDSClient({ region, credentials })
          let marker: string | undefined

          do {
            const resp = await rds.send(new DescribeDBInstancesCommand({ Marker: marker, MaxRecords: 100 }))

            for (const db of resp.DBInstances ?? []) {
              if (!db.DBInstanceIdentifier) continue
              yield {
                external_id: db.DbiResourceId ?? db.DBInstanceIdentifier,
                source:      'aws',
                ci_type:     'database_instance',
                name:        db.DBInstanceIdentifier,
                properties:  {
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
                },
                tags:          {},
                relationships: [],
              }
            }
            marker = resp.Marker
          } while (marker)
        } catch (err) {
          logger.warn({ err, region }, '[aws] RDS scan error')
        }
      }

      // ── ELB / ALB ────────────────────────────────────────────────────────
      if (types.has('elb')) {
        try {
          const {
            ElasticLoadBalancingV2Client,
            DescribeLoadBalancersCommand,
            DescribeTargetGroupsCommand,
            DescribeTargetHealthCommand,
          } = await import('@aws-sdk/client-elastic-load-balancing-v2')

          const elb = new ElasticLoadBalancingV2Client({ region, credentials })

          let lbMarker: string | undefined
          do {
            const lbResp = await elb.send(new DescribeLoadBalancersCommand({ Marker: lbMarker, PageSize: 100 }))

            for (const lb of lbResp.LoadBalancers ?? []) {
              if (!lb.LoadBalancerArn || !lb.LoadBalancerName) continue

              // Fetch target groups for this LB
              const tgResp = await elb.send(new DescribeTargetGroupsCommand({
                LoadBalancerArn: lb.LoadBalancerArn,
              }))

              const relationships: DiscoveredRelation[] = []

              for (const tg of tgResp.TargetGroups ?? []) {
                if (!tg.TargetGroupArn) continue
                try {
                  const healthResp = await elb.send(new DescribeTargetHealthCommand({
                    TargetGroupArn: tg.TargetGroupArn,
                  }))
                  for (const hd of healthResp.TargetHealthDescriptions ?? []) {
                    const instanceId = hd.Target?.Id
                    if (instanceId?.startsWith('i-')) {
                      relationships.push({
                        target_external_id: instanceId,
                        relation_type:      'DEPENDS_ON',
                        direction:          'outgoing',
                      })
                    }
                  }
                } catch (err) {
                  logger.debug({ err, arn: tg.TargetGroupArn }, '[aws] ELB target health skip')
                }
              }

              yield {
                external_id: lb.LoadBalancerArn,
                source:      'aws',
                ci_type:     'load_balancer',
                name:        lb.LoadBalancerName,
                properties:  {
                  dns_name: lb.DNSName,
                  scheme:   lb.Scheme,
                  type:     lb.Type,
                  vpc_id:   lb.VpcId,
                  state:    lb.State?.Code,
                  region,
                },
                tags:          {},
                relationships,
              }
            }
            lbMarker = lbResp.NextMarker
          } while (lbMarker)
        } catch (err) {
          logger.warn({ err, region }, '[aws] ELB scan error')
        }
      }

      // ── ACM Certificates ─────────────────────────────────────────────────
      if (types.has('acm')) {
        try {
          const {
            ACMClient,
            ListCertificatesCommand,
            DescribeCertificateCommand,
          } = await import('@aws-sdk/client-acm')

          const acm = new ACMClient({ region, credentials })
          let nextToken: string | undefined

          do {
            const listResp = await acm.send(new ListCertificatesCommand({
              NextToken: nextToken,
              MaxItems:  100,
            }))

            for (const cert of listResp.CertificateSummaryList ?? []) {
              if (!cert.CertificateArn) continue
              try {
                const detail = await acm.send(new DescribeCertificateCommand({
                  CertificateArn: cert.CertificateArn,
                }))
                const c = detail.Certificate
                if (!c) continue

                yield {
                  external_id: cert.CertificateArn,
                  source:      'aws',
                  ci_type:     'certificate',
                  name:        c.DomainName ?? cert.CertificateArn,
                  properties:  {
                    domain:       c.DomainName,
                    status:       c.Status,
                    expiry_date:  c.NotAfter?.toISOString(),
                    issuer:       c.Issuer,
                    san:          c.SubjectAlternativeNames?.join(', '),
                    region,
                  },
                  tags:          {},
                  relationships: [],
                }
              } catch (err) {
                logger.debug({ err, arn: cert.CertificateArn }, '[aws] ACM describe skip')
              }
            }
            nextToken = listResp.NextToken
          } while (nextToken)
        } catch (err) {
          logger.warn({ err, region }, '[aws] ACM scan error')
        }
      }

      // ── Lambda Functions ─────────────────────────────────────────────────
      if (types.has('lambda')) {
        try {
          const { LambdaClient, ListFunctionsCommand } = await import('@aws-sdk/client-lambda')
          const lambda = new LambdaClient({ region, credentials })
          let marker: string | undefined

          do {
            const resp = await lambda.send(new ListFunctionsCommand({ Marker: marker, MaxItems: 100 }))

            for (const fn of resp.Functions ?? []) {
              if (!fn.FunctionName || !fn.FunctionArn) continue

              const relationships: DiscoveredRelation[] = []
              const subnetIds = fn.VpcConfig?.SubnetIds ?? []
              for (const subnetId of subnetIds) {
                relationships.push({
                  target_external_id: subnetId,
                  relation_type:      'HOSTED_ON',
                  direction:          'outgoing',
                })
              }

              yield {
                external_id: fn.FunctionArn,
                source:      'aws',
                ci_type:     'application',
                name:        fn.FunctionName,
                properties:  {
                  runtime:       fn.Runtime,
                  memory_mb:     fn.MemorySize,
                  timeout_s:     fn.Timeout,
                  handler:       fn.Handler,
                  last_modified: fn.LastModified,
                  role:          fn.Role,
                  region,
                },
                tags:          {},
                relationships,
              }
            }
            marker = resp.NextMarker
          } while (marker)
        } catch (err) {
          logger.warn({ err, region }, '[aws] Lambda scan error')
        }
      }

      // ── ECS Clusters & Services ─────────────────────────────────────────
      if (types.has('ecs')) {
        try {
          const {
            ECSClient,
            ListClustersCommand,
            ListServicesCommand,
            DescribeServicesCommand,
            DescribeTaskDefinitionCommand,
          } = await import('@aws-sdk/client-ecs')

          const ecs = new ECSClient({ region, credentials })

          let clusterToken: string | undefined
          do {
            const clusterResp = await ecs.send(new ListClustersCommand({ nextToken: clusterToken, maxResults: 100 }))

            for (const clusterArn of clusterResp.clusterArns ?? []) {
              const clusterName = clusterArn.split('/').pop() ?? clusterArn

              let svcToken: string | undefined
              do {
                const svcListResp = await ecs.send(new ListServicesCommand({
                  cluster:   clusterArn,
                  nextToken: svcToken,
                  maxResults: 100,
                }))

                const arns = svcListResp.serviceArns ?? []
                if (arns.length === 0) break

                const descResp = await ecs.send(new DescribeServicesCommand({
                  cluster:  clusterArn,
                  services: arns,
                }))

                for (const svc of descResp.services ?? []) {
                  if (!svc.serviceArn || !svc.serviceName) continue

                  // Try to get image from task definition
                  let image: string | undefined
                  if (svc.taskDefinition) {
                    try {
                      const tdResp = await ecs.send(new DescribeTaskDefinitionCommand({
                        taskDefinition: svc.taskDefinition,
                      }))
                      image = tdResp.taskDefinition?.containerDefinitions?.[0]?.image
                    } catch {
                      image = svc.taskDefinition
                    }
                  }

                  yield {
                    external_id: svc.serviceArn,
                    source:      'aws',
                    ci_type:     'application',
                    name:        svc.serviceName,
                    properties:  {
                      cluster:       clusterName,
                      desired_count: svc.desiredCount,
                      running_count: svc.runningCount,
                      launch_type:   svc.launchType,
                      image,
                      status:        svc.status,
                      region,
                    },
                    tags:          {},
                    relationships: [],
                  }
                }
                svcToken = svcListResp.nextToken
              } while (svcToken)
            }
            clusterToken = clusterResp.nextToken
          } while (clusterToken)
        } catch (err) {
          logger.warn({ err, region }, '[aws] ECS scan error')
        }
      }
    }
  },

  async testConnection(config: SyncSourceConfig, creds: Record<string, string>) {
    try {
      const cfg     = config.config as AwsConfig
      const regions = getRegions(cfg)
      const { EC2Client, DescribeRegionsCommand } = await import('@aws-sdk/client-ec2')

      const ec2 = new EC2Client({ region: regions[0]!, credentials: awsCreds(creds) })
      await ec2.send(new DescribeRegionsCommand({ RegionNames: regions }))
      return { ok: true, message: `Connected to AWS (${regions.join(', ')})` }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { ok: false, message: `AWS connection failed: ${msg}` }
    }
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
        default_value: 'us-east-1',
        help_text:     'Comma-separated list of AWS regions to scan',
      },
      {
        name:          'resource_types',
        label:         'Resource Types',
        type:          'text',
        required:      false,
        default_value: ALL_RESOURCE_TYPES.join(', '),
        help_text:     'Comma-separated: ec2, rds, elb, acm, lambda, ecs (leave empty for all)',
      },
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
