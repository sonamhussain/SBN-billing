/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_ENABLE_DEVELOPER_TOOLS?: 'true' | 'false'
  // FE-02 — deployment context (a synthetic organization UUID locally), never a user-entered tenant
  // switcher. The server validates access before any organization data loads.
  readonly VITE_ACTIVE_ORGANIZATION_ID?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
