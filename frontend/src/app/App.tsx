import { AppErrorBoundary } from './AppErrorBoundary.tsx'
import { AppProviders } from './providers.tsx'
import { AppRouter } from './router.tsx'

// FE-01 — providers + router only. The former Development Check composition now lives in
// developer/checkRegistry.tsx behind the isolated /developer route.
export default function App() {
  return (
    <AppErrorBoundary>
      <AppProviders>
        <AppRouter />
      </AppProviders>
    </AppErrorBoundary>
  )
}
