/**
 * `useMutation` with the two things every CRUD page repeats by hand:
 *   - onError   → `toast.error(error.message)` (the real server message, never
 *                 a generic "Errore aggiornamento");
 *   - onCompleted → optional `toast.success(...)` + `refetch()` of the active
 *                 list query (with its live variables — NOT `refetchQueries`
 *                 without variables, which repopulates another cache entry).
 *
 * Usage:
 *   const { refetch } = useQuery(GET_X, { variables })
 *   const [createX, { loading }] = useMutationWithToast(CREATE_X, {
 *     successMessage: 'Creato', refetch, onSuccess: () => setModalOpen(false),
 *   })
 *   void createX({ variables: { input } })
 *
 * Apollo Client 4: the promise returned by the mutate function still REJECTS
 * on error even with `onError` set. Use `void mutate(...)` (the rejection is
 * marked handled) or `try { await mutate(...) } catch { … }` when the result is
 * needed inline — never rely on `.then` alone.
 */
import { useMutation } from '@apollo/client/react'
import type { DocumentNode } from 'graphql'
import type { TypedDocumentNode, OperationVariables, ErrorLike } from '@apollo/client'
import { toast } from 'sonner'

/** Message of any thrown value (Error, Apollo ErrorLike, string). */
export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message
  if (typeof e === 'object' && e !== null && 'message' in e) return String((e as { message: unknown }).message)
  return String(e)
}

export interface MutationWithToastOptions<TData, TVariables extends OperationVariables>
  extends Omit<useMutation.Options<TData, TVariables>, 'onCompleted' | 'onError'> {
  /** Toast shown on success (string or derived from the payload). */
  successMessage?: string | ((data: TData) => string)
  /** Runs after the success toast, before `refetch`. */
  onSuccess?: (data: TData) => void
  /** Active query's `refetch` (keeps its variables). */
  refetch?: () => unknown
  /** Extra handling AFTER the error toast (e.g. reset a flag). */
  onError?: (error: ErrorLike) => void
}

export function useMutationWithToast<TData = unknown, TVariables extends OperationVariables = OperationVariables>(
  mutation: DocumentNode | TypedDocumentNode<TData, TVariables>,
  options:  MutationWithToastOptions<TData, TVariables> = {},
): useMutation.ResultTuple<TData, TVariables> {
  const { successMessage, onSuccess, refetch, onError, ...rest } = options
  return useMutation<TData, TVariables>(mutation, {
    ...rest,
    onCompleted: (data) => {
      if (successMessage) {
        toast.success(typeof successMessage === 'function' ? successMessage(data as TData) : successMessage)
      }
      onSuccess?.(data as TData)
      if (refetch) void refetch()
    },
    onError: (error) => {
      toast.error(error.message)
      onError?.(error)
    },
  })
}
