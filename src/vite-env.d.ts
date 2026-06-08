/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SITEFLOW_API_TOKEN?: string;
  readonly VITE_SITEFLOW_API_URL?: string;
  readonly VITE_SITEFLOW_USE_FIXTURES?: string;
  readonly VITE_SITEFLOW_FIXTURE_SCENARIO?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
