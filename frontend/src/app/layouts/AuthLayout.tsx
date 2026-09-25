import { Outlet } from 'react-router-dom'

// The signed-out frame: a centered column on the quiet background. Product UI offers sign-in only.
export function AuthLayout() {
  return (
    <main className="grid min-h-screen place-items-center bg-[var(--sbn-bg)] px-6">
      <Outlet />
    </main>
  )
}
