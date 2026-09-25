import { Component, type ErrorInfo, type ReactNode } from 'react'

export class AppErrorBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  componentDidCatch(_error: Error, _info: ErrorInfo) {
    // Do not console.log payloads or patient/member data here.
  }

  render() {
    if (this.state.failed) {
      return (
        <main className="grid min-h-screen place-items-center bg-slate-50 px-6">
          <div className="max-w-md text-center">
            <h1 className="text-xl font-semibold">Something went wrong</h1>
            <p className="mt-2 text-sm text-slate-600">The application could not display this page. Reload and try again.</p>
          </div>
        </main>
      )
    }
    return this.props.children
  }
}
