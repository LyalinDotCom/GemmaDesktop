import type { ReactNode } from 'react'

interface RightDockFrameProps {
  children: ReactNode
  className?: string
}

export function RightDockFrame({
  children,
  className = '',
}: RightDockFrameProps) {
  return (
    <div
      className={`surface-right-dock relative flex min-h-0 flex-1 flex-col overflow-hidden ${className}`}
    >
      {children}
    </div>
  )
}
