import jwt from 'jsonwebtoken'
import { getSession } from '@opengraphity/neo4j'

const JWT_SECRET = process.env['JWT_SECRET']
if (!JWT_SECRET) throw new Error('JWT_SECRET environment variable is required')
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

        if (result.records.length === 0) {
          throw new Error('Credenziali non valide')
        }

        const u        = result.records[0]!.get('u').properties as Record<string, string>
        const userId   = u['id']!
        const tenantId = u['tenant_id']!
        const role     = u['role']!
        const name     = u['name']!

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
