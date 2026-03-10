import { useNavigate } from 'react-router-dom'
import { setToken, removeToken, isAuthenticated } from '@/lib/auth'

export function useAuth() {
  const navigate = useNavigate()

  const login = (token: string) => {
    setToken(token)
    navigate('/')
  }

  const logout = () => {
    removeToken()
    navigate('/login')
  }

  return { isAuthenticated: isAuthenticated(), login, logout }
}
