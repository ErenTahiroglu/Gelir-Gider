/// <reference types="vite/client" />

interface ImportMetaEnv {
	readonly VITE_WEB_PUSH_VAPID_PUBLIC_KEY?: string;
}

interface ImportMeta {
	readonly env: ImportMetaEnv;
}
