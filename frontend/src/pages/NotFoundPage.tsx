import { Link } from 'react-router-dom'

export default function NotFoundPage() {
  return (
    <main className="grid min-h-screen place-items-center bg-slate-50 px-6">
      <div className="text-center">
        <h1 className="text-2xl font-semibold">Page not found</h1>
        <Link className="mt-4 inline-block text-sm font-medium text-blue-700" to="/app/home">
          Return home
        </Link>
      </div>
    </main>
  )
}
