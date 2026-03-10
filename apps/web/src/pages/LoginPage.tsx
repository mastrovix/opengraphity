import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useMutation } from '@apollo/client/react'
import { setToken, isAuthenticated } from '@/lib/auth'
import { LOGIN } from '@/graphql/mutations'

/* Geometric dot-grid SVG pattern */
const DotPattern = () => (
  <svg
    style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', opacity: 0.15 }}
    xmlns="http://www.w3.org/2000/svg"
  >
    <defs>
      <pattern id="dots" x="0" y="0" width="24" height="24" patternUnits="userSpaceOnUse">
        <circle cx="2" cy="2" r="1.5" fill="white" />
      </pattern>
    </defs>
    <rect width="100%" height="100%" fill="url(#dots)" />
  </svg>
)

export function LoginPage() {
  const navigate = useNavigate()
  const [email, setEmail]       = useState('')
  const [password, setPassword] = useState('')
  const [error, setError]       = useState('')

  const [loginMutation, { loading }] = useMutation<{
    login: { token: string; expiresAt: string; user: { id: string; name: string; email: string; role: string } }
  }>(LOGIN, {
    onCompleted: (data) => {
      setToken(data.login.token)
      navigate('/dashboard')
    },
    onError: (err) => setError(err.message),
  })

  if (isAuthenticated()) {
    navigate('/dashboard')
    return null
  }

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    if (!email.includes('@')) { setError('Inserisci un indirizzo email valido'); return }
    if (password.length < 6)  { setError('La password deve essere di almeno 6 caratteri'); return }
    void loginMutation({ variables: { email, password } })
  }

  return (
    <div style={{ display: 'flex', minHeight: '100vh', backgroundColor: 'var(--surface)' }}>
      {/* Left panel — accent with pattern */}
      <div
        className="hidden lg:flex flex-col justify-between p-10"
        style={{
          flex:             '0 0 480px',
          backgroundColor:  'var(--accent)',
          position:         'relative',
          overflow:         'hidden',
        }}
      >
        <DotPattern />

        {/* Logo */}
        <div className="relative flex items-center gap-2.5">
          <div
            style={{ backgroundColor: 'rgba(255,255,255,0.2)', borderRadius: 8 }}
            className="w-9 h-9 flex items-center justify-center"
          >
            <span style={{ color: '#fff', fontSize: 13, fontWeight: 800, letterSpacing: '-0.03em' }}>OG</span>
          </div>
          <span style={{ color: '#fff', fontSize: 16, fontWeight: 700, letterSpacing: '-0.02em' }}>
            OpenGraphity
          </span>
        </div>

        {/* Tagline */}
        <div className="relative">
          <h2 style={{ color: '#fff', fontSize: 28, fontWeight: 700, lineHeight: 1.25, letterSpacing: '-0.02em', marginBottom: 12 }}>
            Gestisci i tuoi servizi IT con chiarezza.
          </h2>
          <p style={{ color: 'rgba(255,255,255,0.7)', fontSize: 14, lineHeight: 1.6 }}>
            Incident, Problem, Change e Request — tutto in un unico posto per team IT moderni.
          </p>
        </div>

        {/* Bottom meta */}
        <div className="relative">
          <p style={{ color: 'rgba(255,255,255,0.5)', fontSize: 12 }}>
            © 2026 OpenGraphity · ITSM Platform
          </p>
        </div>
      </div>

      {/* Right panel — form */}
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '0 24px', position: 'relative', zIndex: 1 }}>
        <div style={{ width: '100%', maxWidth: 380 }}>
          {/* Mobile logo */}
          <div className="flex md:hidden items-center gap-2 mb-8">
            <div
              style={{ backgroundColor: 'var(--accent)', borderRadius: 8 }}
              className="w-8 h-8 flex items-center justify-center"
            >
              <span style={{ color: '#fff', fontSize: 11, fontWeight: 800 }}>OG</span>
            </div>
            <span style={{ fontWeight: 700, fontSize: 15, color: 'var(--text-primary)' }}>OpenGraphity</span>
          </div>

          <h1 style={{ fontSize: 22, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 4, letterSpacing: '-0.02em' }}>
            Accedi al tuo account
          </h1>
          <p style={{ color: 'var(--text-muted)', fontSize: 13, marginBottom: 28 }}>
            Benvenuto! Inserisci le tue credenziali per continuare.
          </p>

          <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {/* Email */}
            <div>
              <label style={{ display: 'block', fontSize: 13, fontWeight: 500, color: 'var(--text-secondary)', marginBottom: 6 }}>
                Email
              </label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="admin@demo.opengraphity.io"
                required
                style={{
                  width:           '100%',
                  height:          38,
                  padding:         '0 12px',
                  border:          '1px solid var(--border)',
                  borderRadius:    6,
                  backgroundColor: 'var(--surface)',
                  color:           'var(--text-primary)',
                  outline:         'none',
                  transition:      'border-color 150ms',
                  boxSizing:       'border-box',
                }}
                onFocus={(e) => (e.target.style.borderColor = 'var(--accent)')}
                onBlur={(e)  => (e.target.style.borderColor = 'var(--border)')}
              />
            </div>

            {/* Password */}
            <div>
              <label style={{ display: 'block', fontSize: 13, fontWeight: 500, color: 'var(--text-secondary)', marginBottom: 6 }}>
                Password
              </label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                required
                style={{
                  width:           '100%',
                  height:          38,
                  padding:         '0 12px',
                  border:          '1px solid var(--border)',
                  borderRadius:    6,
                  backgroundColor: 'var(--surface)',
                  color:           'var(--text-primary)',
                  outline:         'none',
                  transition:      'border-color 150ms',
                  boxSizing:       'border-box',
                }}
                onFocus={(e) => (e.target.style.borderColor = 'var(--accent)')}
                onBlur={(e)  => (e.target.style.borderColor = 'var(--border)')}
              />
            </div>

            {error && (
              <p style={{ fontSize: 12, color: 'var(--danger)', margin: 0 }}>{error}</p>
            )}

            <button
              type="submit"
              disabled={loading}
              style={{
                height:          40,
                backgroundColor: loading ? 'var(--accent-hover)' : 'var(--accent)',
                color:           '#fff',
                border:          'none',
                borderRadius:    6,
                fontSize:        14,
                fontWeight:      600,
                cursor:          loading ? 'not-allowed' : 'pointer',
                transition:      'background-color 150ms',
                fontFamily:      'inherit',
              }}
              onMouseEnter={(e) => !loading && (e.currentTarget.style.backgroundColor = 'var(--accent-hover)')}
              onMouseLeave={(e) => !loading && (e.currentTarget.style.backgroundColor = 'var(--accent)')}
            >
              {loading ? 'Accesso in corso…' : 'Accedi'}
            </button>
          </form>

          <p style={{ marginTop: 20, fontSize: 12, color: 'var(--text-muted)', textAlign: 'center' }}>
            Modalità demo — qualsiasi email + password ≥ 6 caratteri
          </p>
        </div>
      </div>
    </div>
  )
}
