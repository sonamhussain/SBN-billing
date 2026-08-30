import { useState, type FormEvent } from 'react'
import { authClient } from '../../shared/auth-client.ts'

export default function AuthSetup() {
  const [name, setName] = useState('Synthetic Billing User')
  const [email, setEmail] = useState('synthetic.user@example.test')
  const [password, setPassword] = useState('')
  const [message, setMessage] = useState('')
  const { data: session, refetch } = authClient.useSession()

  async function createSyntheticUser(e: FormEvent) {
    e.preventDefault()
    const { error } = await authClient.signUp.email({ name, email, password })
    setMessage(error ? error.message ?? 'Sign-up failed' : 'Synthetic user created. Sign in next.')
  }

  async function signIn(e: FormEvent) {
    e.preventDefault()
    const { error } = await authClient.signIn.email({ email, password })
    setMessage(error ? error.message ?? 'Sign-in failed' : 'Signed in')
    await refetch()
  }

  async function signOut() {
    await authClient.signOut()
    setMessage('Signed out')
    await refetch()
  }

  return (
    <section className="mt-6 border-t border-slate-200 pt-6">
      <h2 className="text-lg font-semibold text-slate-900">Authentication Check</h2>
      <p className="mt-1 text-sm text-slate-600">Synthetic development data only.</p>

      <form className="mt-4 grid gap-2">
        <input
          className="rounded-md border border-slate-300 px-3 py-2"
          value={name}
          onChange={(event) => setName(event.target.value)}
          aria-label="Name"
          placeholder="Name"
        />
        <input
          className="rounded-md border border-slate-300 px-3 py-2"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          aria-label="Email"
          placeholder="Email"
        />
        <input
          className="rounded-md border border-slate-300 px-3 py-2"
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          aria-label="Password"
          placeholder="Password"
        />
        <div className="flex gap-2">
          <button
            className="rounded-md bg-slate-900 px-4 py-2 text-white disabled:opacity-50"
            onClick={createSyntheticUser}
            type="submit"
          >
            Create Synthetic User
          </button>
          <button
            className="rounded-md bg-slate-700 px-4 py-2 text-white disabled:opacity-50"
            onClick={signIn}
            type="button"
          >
            Sign In
          </button>
          <button
            className="rounded-md bg-slate-200 px-4 py-2 text-slate-900"
            onClick={signOut}
            type="button"
          >
            Sign Out
          </button>
        </div>
      </form>

      {message && <p className="mt-3 text-sm text-slate-700">{message}</p>}

      {session ? (
        <div className="mt-4 rounded-md bg-slate-100 p-3 text-sm">
          <p>AUTHENTICATED</p>
          <p><strong>User ID:</strong> {session.user.id}</p>
          <p><strong>Email:</strong> {session.user.email}</p>
        </div>
      ) : (
        <p className="mt-4 text-sm text-slate-700">NOT SIGNED IN</p>
      )}
    </section>
  )
}
