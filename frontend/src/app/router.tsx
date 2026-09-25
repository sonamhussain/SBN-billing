import { createBrowserRouter, Navigate, RouterProvider } from 'react-router-dom'
import { AuthBoundary } from './AuthBoundary.tsx'
import { AppShell } from './layouts/AppShell.tsx'
import { AuthLayout } from './layouts/AuthLayout.tsx'
import LoginPage from '../pages/LoginPage.tsx'
import HomePage from '../pages/HomePage.tsx'
import PatientsPlaceholderPage from '../pages/PatientsPlaceholderPage.tsx'
import EncountersPlaceholderPage from '../pages/EncountersPlaceholderPage.tsx'
import AdministrationPlaceholderPage from '../pages/AdministrationPlaceholderPage.tsx'
import NotFoundPage from '../pages/NotFoundPage.tsx'
import DeveloperToolsPage from '../developer/DeveloperToolsPage.tsx'

// An explicit flag always wins, so VITE_ENABLE_DEVELOPER_TOOLS=false hides the tools for a client
// demo even on the Vite dev server; with the flag absent, only local development enables them.
const developerToolsFlag = import.meta.env.VITE_ENABLE_DEVELOPER_TOOLS
const developerToolsEnabled =
  developerToolsFlag === 'true' || (developerToolsFlag === undefined && import.meta.env.DEV)

const router = createBrowserRouter([
  {
    element: <AuthLayout />,
    children: [{ path: '/login', element: <LoginPage /> }],
  },
  {
    element: <AuthBoundary />,
    children: [
      {
        path: '/app',
        element: <AppShell />,
        children: [
          { index: true, element: <Navigate to="home" replace /> },
          { path: 'home', element: <HomePage /> },
          { path: 'patients', element: <PatientsPlaceholderPage /> },
          { path: 'encounters', element: <EncountersPlaceholderPage /> },
          { path: 'admin', element: <AdministrationPlaceholderPage /> },
        ],
      },
      ...(developerToolsEnabled
        ? [{ path: '/developer', element: <DeveloperToolsPage /> }]
        : []),
    ],
  },
  { path: '/', element: <Navigate to="/app/home" replace /> },
  { path: '*', element: <NotFoundPage /> },
])

export function AppRouter() {
  return <RouterProvider router={router} />
}
