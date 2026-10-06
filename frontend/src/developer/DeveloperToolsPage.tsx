import { Link } from 'react-router-dom'
import { developerChecks } from './checkRegistry.tsx'

// Engineering only: reached at /developer (signed in, and enabled by dev mode or the flag); never
// linked from product navigation.
export default function DeveloperToolsPage() {
  return (
    <main className="min-h-screen bg-slate-50 px-6 py-8">
      <div className="mx-auto max-w-3xl">
        <div className="mb-6 flex items-center justify-between">
          <div>
            <p className="text-sm font-medium text-slate-500">Engineering only</p>
            <h1 className="text-2xl font-semibold">Developer Tools</h1>
          </div>
          <Link className="text-sm font-medium text-blue-700" to="/app/home">Back to product</Link>
        </div>
        <div className="rounded-lg border bg-white p-6">
          {developerChecks.map(({ key, Component }) => <Component key={key} />)}
        </div>
      </div>
    </main>
  )
}
