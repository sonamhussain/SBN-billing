import { Navigate, Outlet, useLocation } from 'react-router-dom'
import { authClient } from '../shared/auth-client.ts'
import { AppStatus } from '../shared/layout/AppStatus.tsx'

export function AuthBoundary() {
  const { data: session, isPending } = authClient.useSession()
  const location = useLocation()

  if (isPending) return <AppStatus label="Checking session..." />
  if (!session) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />
  }

  return <Outlet />
}
