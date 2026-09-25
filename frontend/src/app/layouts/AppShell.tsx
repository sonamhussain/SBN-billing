import { Home, Users, Stethoscope, Settings, LogOut } from 'lucide-react'
import { NavLink, Outlet, useNavigate } from 'react-router-dom'
import { authClient } from '../../shared/auth-client.ts'
import { queryClient } from '../../shared/api/query-client.ts'
import { cn } from '../../shared/cn.ts'

// Labeled product navigation only (FE-01 hard lock): no dashboard and no Developer Tools entry.
const nav = [
  { to: '/app/home', label: 'Home', icon: Home },
  { to: '/app/patients', label: 'Patients', icon: Users },
  { to: '/app/encounters', label: 'Encounters', icon: Stethoscope },
  { to: '/app/admin', label: 'Administration', icon: Settings },
]

export function AppShell() {
  const navigate = useNavigate()

  async function signOut() {
    await authClient.signOut()
    queryClient.clear()
    navigate('/login', { replace: true })
  }

  return (
    <div className="min-h-screen bg-[var(--sbn-bg)] text-slate-950">
      <aside className="fixed inset-y-0 left-0 w-52 border-r border-slate-200 bg-white">
        <div className="px-5 py-5 text-sm font-semibold text-[var(--sbn-accent)]">SBN Billing</div>
        <nav className="px-2" aria-label="Primary">
          {nav.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) =>
                cn(
                  'mb-1 flex items-center gap-3 rounded-md px-3 py-2 text-sm',
                  isActive ? 'bg-slate-100 font-medium text-slate-950' : 'text-slate-600 hover:bg-slate-50',
                )
              }
            >
              <Icon aria-hidden="true" size={17} />
              {label}
            </NavLink>
          ))}
        </nav>
      </aside>

      <div className="pl-52">
        <header className="sticky top-0 z-20 flex h-14 items-center justify-between border-b border-slate-200 bg-white/95 px-7">
          <div className="text-sm text-slate-500">Current organization context</div>
          <button className="flex items-center gap-2 text-sm text-slate-600 hover:text-slate-950" onClick={signOut} type="button">
            <LogOut aria-hidden="true" size={16} /> Sign out
          </button>
        </header>
        <main className="mx-auto max-w-6xl px-7 py-7">
          <Outlet />
        </main>
      </div>
    </div>
  )
}
