/**
 * Promise-based confirmation (E-10), replacing every `window.confirm`:
 *
 *   const confirm = useConfirm()
 *   if (await confirm({ title: labels.title, body: labels.body, danger: true })) { … }
 *
 * `ConfirmProvider` (mounted once in `AppLayout`) renders the single
 * `ConfirmModal`; `useConfirm` outside a provider THROWS with a clear message
 * instead of returning a no-op that would silently skip the confirmation.
 *
 * Only one confirmation can be open at a time: a second request while one is
 * pending resolves the first as "cancelled" and replaces it.
 */
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react'
import { ConfirmModal } from '@/components/ui/ConfirmModal'

export interface ConfirmOptions {
  title:         string
  body?:         ReactNode
  confirmLabel?: string
  cancelLabel?:  string
  danger?:       boolean
}

export type ConfirmFn = (options: ConfirmOptions) => Promise<boolean>

const ConfirmContext = createContext<ConfirmFn | null>(null)

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<ConfirmOptions | null>(null)
  const resolveRef = useRef<((ok: boolean) => void) | null>(null)

  const settle = useCallback((ok: boolean) => {
    const resolve = resolveRef.current
    resolveRef.current = null
    setPending(null)
    resolve?.(ok)
  }, [])

  const confirm = useCallback<ConfirmFn>((options) => {
    // A pending confirmation that gets replaced is a "no".
    resolveRef.current?.(false)
    return new Promise<boolean>((resolve) => {
      resolveRef.current = resolve
      setPending(options)
    })
  }, [])

  const value = useMemo(() => confirm, [confirm])

  return (
    <ConfirmContext.Provider value={value}>
      {children}
      {pending && (
        <ConfirmModal
          open
          title={pending.title}
          body={pending.body}
          confirmLabel={pending.confirmLabel}
          cancelLabel={pending.cancelLabel}
          danger={pending.danger}
          onConfirm={() => settle(true)}
          onCancel={() => settle(false)}
        />
      )}
    </ConfirmContext.Provider>
  )
}

export function useConfirm(): ConfirmFn {
  const fn = useContext(ConfirmContext)
  if (!fn) {
    throw new Error('useConfirm() richiede un <ConfirmProvider> a monte (montato in AppLayout).')
  }
  return fn
}
