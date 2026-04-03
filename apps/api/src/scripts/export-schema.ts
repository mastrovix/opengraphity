/**
 * Exports the static GraphQL SDL to docs/graphql-schema.graphql
 * Usage: pnpm tsx apps/api/src/scripts/export-schema.ts
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import pino from 'pino'
import { buildBaseSDL } from '../graphql/schema-base.js'

const log = pino({ level: 'info' })

const __filename = fileURLToPath(import.meta.url)
const __dirname  = dirname(__filename)

// Resolve to repo root → docs/
const repoRoot   = resolve(__dirname, '..', '..', '..', '..', '..')
const outputPath = resolve(repoRoot, 'docs', 'graphql-schema.graphql')

async function main(): Promise<void> {
  log.info({ outputPath }, 'Exporting GraphQL schema')

  const sdl = buildBaseSDL()

  mkdirSync(dirname(outputPath), { recursive: true })
  writeFileSync(outputPath, sdl, 'utf8')

  log.info({ outputPath, bytes: Buffer.byteLength(sdl, 'utf8') }, 'Schema exported successfully')
}

main().catch((err: unknown) => {
  log.fatal({ err }, 'Export failed')
  process.exit(1)
})
