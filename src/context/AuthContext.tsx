import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { api, AUTH_EXPIRED_EVENT } from '../api'
import type { User } from '../types'

interface AuthContextValue {
  user: User | null
  loading: boolean
  setupRequired: boolean
  login: (username: string, password: string) => Promise<void>
  setup: (username: string, password: string) => Promise<void>
  updateUsername: (username: string) => Promise<User>
  logout: () => Promise<void>
  refresh: () => Promise<void>
}

const AuthContext = createContext<AuthContextValue | null>(null)

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [loading, setLoading] = useState(true)
  const [setupRequired, setSetupRequired] = useState(false)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const status = await api.auth.status()
      setSetupRequired(status.setupRequired)
      setUser(status.authenticated ? status.user : null)
      if (status.authenticated && !status.user) {
        const result = await api.auth.me()
        setUser(result.user)
      }
    } catch {
      setUser(null)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    const handleExpiredSession = () => {
      setUser(null)
      setSetupRequired(false)
    }
    window.addEventListener(AUTH_EXPIRED_EVENT, handleExpiredSession)
    return () => window.removeEventListener(AUTH_EXPIRED_EVENT, handleExpiredSession)
  }, [])

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      loading,
      setupRequired,
      async login(username, password) {
        const result = await api.auth.login(username, password)
        setUser(result.user)
        setSetupRequired(false)
      },
      async setup(username, password) {
        const result = await api.auth.setup(username, password)
        setUser(result.user)
        setSetupRequired(false)
      },
      async updateUsername(username) {
        const result = await api.auth.updateProfile(username)
        setUser(result.user)
        return result.user
      },
      async logout() {
        try {
          await api.auth.logout()
        } finally {
          setUser(null)
        }
      },
      refresh,
    }),
    [loading, refresh, setupRequired, user],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth() {
  const context = useContext(AuthContext)
  if (!context) throw new Error('useAuth must be used inside AuthProvider')
  return context
}
