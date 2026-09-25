import { QueryClient } from '@tanstack/react-query'

// FE-01 — server state lives in memory only; it is never persisted to the browser.
// Private query data is cleared on sign-out (see AppShell).
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 15_000,
      gcTime: 5 * 60_000,
      retry: 1,
      refetchOnWindowFocus: false,
    },
    mutations: {
      retry: 0,
    },
  },
})
