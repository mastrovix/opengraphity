import { createRequire } from 'node:module'
import { defineConfig } from 'vitest/config'

/*
 * ONE `graphql`, THE ONE NODE LOADS. graphql 17 ships a development build
 * (`__dev__/`) behind the `development` condition, which vite resolves in a
 * test; the packages' compiled code (the schema generator) is loaded by Node,
 * which takes `index.js`. Two copies, and executing a tenant schema built by
 * one with the other fails: «Cannot use GraphQLNonNull "ID!" from another
 * module or realm». The server runs on Node alone and never meets it.
 */
const graphqlForNode = createRequire(import.meta.url).resolve('graphql')

/*
 * THE INTEGRATION SUITE (wave 7 · C2): against a real, throwaway Neo4j, never
 * with `vitest run` — the tenants it reads are written by
 * src/__integration__/prepare.ts. Run both with scripts/integration-neo4j.sh.
 */
export default defineConfig({
  resolve: {
    alias: [{ find: /^graphql$/, replacement: graphqlForNode }],
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['src/__integration__/**/*.test.ts'],
    fileParallelism: false,
    testTimeout: 900_000,
    hookTimeout: 300_000,
    disableConsoleIntercept: true,
  },
})
