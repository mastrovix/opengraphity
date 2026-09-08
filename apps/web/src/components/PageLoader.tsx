/** Fallback shown while a lazy route chunk downloads or a route guard resolves. */
export function PageLoader() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '60vh', color: 'var(--color-slate-light)', fontSize: 'var(--font-size-body)' }}>
      Caricamento…
    </div>
  )
}
