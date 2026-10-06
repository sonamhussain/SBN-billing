/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_ENABLE_DEVELOPER_TOOLS?: 'true' | 'false'
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
