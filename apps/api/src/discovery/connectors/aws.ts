import type {
  Connector,
  CredentialFieldDefinition,
  ConfigFieldDefinition,
  DiscoveredCI,
  SyncSourceConfig,
} from '@opengraphity/discovery'
import { logger } from '../../lib/logger.js'

// ── AWS Connector ─────────────────────────────────────────────────────────────
// Discovers EC2 instances, RDS instances and S3 buckets.
// Credentials: access_key_id, secret_access_key, (optional) session_token.
// Config: regions (comma-separated or array), include_stopped (boolean).

type AwsConfig = {
  regions?:         string | string[]
  include_stopped?: boolean | string
}

function getRegions(config: AwsConfig): string[] {
  const r = config.regions
  if (!r) return ['us-east-1']
  if (Array.isArray(r)) return r
  return r.split(',').map(s => s.trim()).filter(Boolean)
}

export const awsConnector: Connector = {
  type:             'aws',
  displayName:      'AWS',
  supportedCITypes: ['server', 'database', 'database_instance', 'storage'],

  async *scan(config: SyncSourceConfig, creds: Record<string, string>): AsyncIterable<DiscoveredCI> {
    const cfg     = config.config as AwsConfig
    const regions = getRegions(cfg)
    const inclStopped = String(cfg.include_stopped) === 'true'

    // Dynamic import to avoid load cost when connector not used
    const { EC2Client, DescribeInstancesCommand } = await import('@aws-sdk/client-ec2')
    const { RDSClient, DescribeDBInstancesCommand } = await import('@aws-sdk/client-rds')
    const { S3Client, ListBucketsCommand, GetBucketLocationCommand } = await import('@aws-sdk/client-s3')

    const awsCreds = {
      accessKeyId:     creds['access_key_id']!,
      secretAccessKey: creds['secret_access_key']!,
      ...(creds['session_token'] ? { sessionToken: creds['session_token'] } : {}),
    }

    for (const region of regions) {
      // ── EC2 Instances ────────────────────────────────────────────────────
      try {
        const ec2 = new EC2Client({ region, credentials: awsCreds })
        let nextToken: string | undefined

        do {
          const resp = await ec2.send(new DescribeInstancesCommand({
            Filters: inclStopped ? [] : [{ Name: 'instance-state-name', Values: ['running', 'pending'] }],
            NextToken: nextToken,
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

      // ── RDS Instances ────────────────────────────────────────────────────
      try {
        const rds = new RDSClient({ region, credentials: awsCreds })
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
                engine:              db.Engine,
                engine_version:      db.EngineVersion,
                instance_class:      db.DBInstanceClass,
                status:              db.DBInstanceStatus,
                endpoint:            db.Endpoint?.Address,
                port:                db.Endpoint?.Port,
                multi_az:            db.MultiAZ,
                storage_type:        db.StorageType,
                allocated_storage:   db.AllocatedStorage,
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

    // ── S3 Buckets (global, but we attribute to first region) ────────────
    try {
      const s3   = new S3Client({ region: regions[0]!, credentials: awsCreds })
      const resp = await s3.send(new ListBucketsCommand({}))

      for (const bucket of resp.Buckets ?? []) {
        if (!bucket.Name) continue
        let bucketRegion: string | undefined
        try {
          const locResp = await s3.send(new GetBucketLocationCommand({ Bucket: bucket.Name }))
          bucketRegion  = locResp.LocationConstraint ?? 'us-east-1'
        } catch {
          bucketRegion = 'unknown'
        }

        yield {
          external_id: `s3::${bucket.Name}`,
          source:      'aws',
          ci_type:     'storage',
          name:        bucket.Name,
          properties:  {
            bucket_name: bucket.Name,
            region:      bucketRegion,
            created_at:  bucket.CreationDate?.toISOString(),
          },
          tags:          {},
          relationships: [],
        }
      }
    } catch (err) {
      logger.warn({ err }, '[aws] S3 scan error')
    }
  },

  async testConnection(config: SyncSourceConfig, creds: Record<string, string>) {
    try {
      const cfg     = config.config as AwsConfig
      const regions = getRegions(cfg)
      const { EC2Client, DescribeRegionsCommand } = await import('@aws-sdk/client-ec2')

      const awsCreds = {
        accessKeyId:     creds['access_key_id']!,
        secretAccessKey: creds['secret_access_key']!,
        ...(creds['session_token'] ? { sessionToken: creds['session_token'] } : {}),
      }

      const ec2 = new EC2Client({ region: regions[0]!, credentials: awsCreds })
      await ec2.send(new DescribeRegionsCommand({ RegionNames: regions }))
      return { ok: true, message: `Connected to AWS (${regions.join(', ')})` }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { ok: false, message: `AWS connection failed: ${msg}` }
    }
  },

  getRequiredCredentialFields(): CredentialFieldDefinition[] {
    return [
      { name: 'access_key_id',     label: 'Access Key ID',     type: 'text',     required: true, placeholder: 'AKIA...' },
      { name: 'secret_access_key', label: 'Secret Access Key', type: 'password', required: true },
      { name: 'session_token',     label: 'Session Token',     type: 'password', required: false, help_text: 'Only required for temporary credentials (STS/role assumption)' },
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
        name:          'include_stopped',
        label:         'Include Stopped Instances',
        type:          'boolean',
        required:      false,
        default_value: false,
      },
    ]
  },
}
