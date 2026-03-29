import { createContext, useContext, type ReactNode } from 'react'
import { useNotifications, type InAppNotification } from '@/hooks/useNotifications'

interface NotificationContextType {
  notifications: InAppNotification[]
  unreadCount:   number
  markAsRead:    (id: string) => void
  markAllAsRead: () => void
  clearAll:      () => void
}

const NotificationContext = createContext<NotificationContextType>({
  notifications: [],
  unreadCount:   0,
  markAsRead:    () => {},
  markAllAsRead: () => {},
  clearAll:      () => {},
})

export function NotificationProvider({ children }: { children: ReactNode }) {
  const value = useNotifications()
  return (
    <NotificationContext.Provider value={value}>
      {children}
    </NotificationContext.Provider>
  )
}

export function useNotificationContext(): NotificationContextType {
  return useContext(NotificationContext)
}
