import type { ReactNode, CSSProperties } from 'react'

interface PageContainerProps {
  children: ReactNode
  style?: CSSProperties
}

export function PageContainer({ children, style }: PageContainerProps) {
  return (
    <div style={{ padding: '2.5rem', ...style }}>
      {children}
    </div>
  )
}
