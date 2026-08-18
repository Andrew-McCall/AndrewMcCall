/// <reference types="vite/client" />

// The build-time SEO values from `frontend/.env`. Declared so a typo in one of
// these names is a compile error rather than an `undefined` that quietly
// becomes the string "undefined" in a `<meta>` tag.
interface ImportMetaEnv {
  readonly VITE_SITE_URL: string;
  readonly VITE_SITE_TITLE: string;
  readonly VITE_SITE_DESCRIPTION: string;
  readonly VITE_SITE_IMAGE: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
