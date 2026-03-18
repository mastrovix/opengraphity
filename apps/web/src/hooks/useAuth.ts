import { useNavigate } from 'react-router-dom'
import { setToken, removeToken, isAuthenticated } from '@/lib/auth'
import { keycloak } from '../lib/keycloak'

export function useAuth() {
  const navigate = useNavigate()

  const login = (token: string) => {
    setToken(token)
    navigate('/')
  }

  const logout = () => {
    removeToken()
    keycloak.logout({ redirectUri: window.location.origin + '/' })
  }

  return { isAuthenticated: isAuthenticated(), login, logout }
}
