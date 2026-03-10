import jwt from 'jsonwebtoken'
import { getSession } from '@opengraphity/neo4j'

const JWT_SECRET  = process.env['JWT_SECRET']    ?? 'opengraphity_dev_secret_change_in_production'
const JWT_EXPIRES = process.env['JWT_EXPIRES_IN'] ?? '24h'

export const authResolvers = {
  Mutation: {
    login: async (_: unknown, { email, password }: { email: string; password: string }) => {
      if (!email.includes('@') || password.length < 6) {
        throw new Error('Credenziali non valide')
      }

      const session = getSession()
      try {
        const result = await session.executeRead((tx) =>
          tx.run('MATCH (u:User {email: $email}) RETURN u LIMIT 1', { email }),
        )

        let userId   = 'user-001'
        let tenantId = 'tenant-demo'
        let role     = 'admin'
        let name     = email.split('@')[0]!

        if (result.records.length > 0) {
          const u  = result.records[0]!.get('u').properties as Record<string, string>
          userId   = u['id']!
          tenantId = u['tenant_id']!
          role     = u['role']!
          name     = u['name']!
        }

        const iat = Math.floor(Date.now() / 1000)
        const exp = iat + 24 * 60 * 60 // 24h

        const token = jwt.sign(
          { tenant_id: tenantId, user_id: userId, email, role },
          JWT_SECRET,
          { expiresIn: JWT_EXPIRES as jwt.SignOptions['expiresIn'] },
        )

        return {
          token,
          expiresAt: new Date(exp * 1000).toISOString(),
          user: { id: userId, tenantId, name, email, role },
        }
      } finally {
        await session.close()
      }
    },
  },
}
