export function registerSW(options?: {
	immediate?: boolean;
	onNeedRefresh?: () => void;
	onOfflineReady?: () => void;
	onRegistered?: (registration: ServiceWorkerRegistration | undefined) => void;
	onRegisterError?: (error: unknown) => void;
}) {
	return async (_reloadPage?: boolean) => {};
}
