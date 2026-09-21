/**
 * Valore con debounce: torna l'ultimo `value` rimasto invariato per
 * `delayMs`. Per le ricerche che partono "quando l'utente smette di
 * scrivere" (LinkCIDialog degli eventi), al posto del timer copiato a mano.
 *
 *   const debounced = useDebounced(search.trim(), 300)
 *   useQuery(GET_X, { variables: { search: debounced }, skip: debounced.length < 2 })
 */
import { useEffect, useState } from 'react'

export function useDebounced<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs)
    return () => clearTimeout(timer)
  }, [value, delayMs])
  return debounced
}
