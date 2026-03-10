const TOKEN_KEY = 'og_token'

export const getToken    = () => localStorage.getItem(TOKEN_KEY)
export const setToken    = (token: string) => localStorage.setItem(TOKEN_KEY, token)
export const removeToken = () => localStorage.removeItem(TOKEN_KEY)

export function isTokenExpired(): boolean {
  const token = getToken()
  if (!token) return true
  try {
    const payload = JSON.parse(atob(token.split('.')[1]!)) as { exp: number }
    return payload.exp < Math.floor(Date.now() / 1000)
  } catch {
    return true
  }
}

export function isAuthenticated(): boolean {
  return !!getToken() && !isTokenExpired()
}
