import { Loading } from '@/components/ui/Loading'

/** Fallback shown while a lazy route chunk downloads or a route guard resolves. */
export function PageLoader() {
  // The words and the grey are Loading's (26 Sep 2026); here only the place, the middle of the page.
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '60vh' }}>
      <Loading />
    </div>
  )
}
