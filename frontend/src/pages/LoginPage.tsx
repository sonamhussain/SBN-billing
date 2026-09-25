import { useState, type FormEvent } from 'react'
import { Navigate, useLocation, useNavigate } from 'react-router-dom'
import { authClient } from '../shared/auth-client.ts'
import { Button } from '../shared/ui/Button.tsx'
import { Input } from '../shared/ui/Input.tsx'
import { Alert } from '../shared/ui/Alert.tsx'

// Product UI offers sign-in only. The centered frame comes from AuthLayout.
export default function LoginPage() {
  const { data: session, isPending } = authClient.useSession()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const navigate = useNavigate()
  const location = useLocation()
  const from = (location.state as { from?: string } | null)?.from ?? '/app/home'

  if (!isPending && session) return <Navigate to={from} replace />

  async function submit(event: FormEvent) {
    event.preventDefault()
    setSubmitting(true)
    setError('')
    const result = await authClient.signIn.email({ email, password })
    setSubmitting(false)

    if (result.error) {
      setError(result.error.message ?? 'Sign in failed')
      return
    }
    navigate(from, { replace: true })
  }

  return (
    <form className="w-full max-w-sm space-y-5 rounded-lg border bg-white p-7" onSubmit={submit}>
      <div>
        <p className="text-sm font-medium text-[var(--sbn-accent)]">SBN Billing</p>
        <h1 className="mt-1 text-2xl font-semibold text-slate-950">Sign in</h1>
      </div>
      {error && <Alert tone="danger">{error}</Alert>}
      <Input aria-label="Email" autoComplete="email" placeholder="Email" type="email"
        value={email} onChange={(e) => setEmail(e.target.value)} />
      <Input aria-label="Password" autoComplete="current-password" placeholder="Password" type="password"
        value={password} onChange={(e) => setPassword(e.target.value)} />
      <Button className="w-full" disabled={submitting} type="submit">
        {submitting ? 'Signing in...' : 'Sign in'}
      </Button>
    </form>
  )
}
