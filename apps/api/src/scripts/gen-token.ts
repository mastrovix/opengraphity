import jwt from 'jsonwebtoken'

const JWT_SECRET = process.env['JWT_SECRET'] ?? 'opengraphity_dev_secret_change_in_production'

const payload = {
  tenant_id: 'c-one',
  user_id: 'user-001',
  email: 'admin@demo.opengraphity.io',
  role: 'admin'
}

const token = jwt.sign(payload, JWT_SECRET, { expiresIn: '24h' })

console.log('\n=== Dev JWT Token ===')
console.log(token)
console.log('\n=== Authorization Header ===')
console.log(`Authorization: Bearer ${token}`)
console.log('\n=== Apollo Sandbox Header (JSON) ===')
console.log(JSON.stringify({ Authorization: `Bearer ${token}` }, null, 2))
