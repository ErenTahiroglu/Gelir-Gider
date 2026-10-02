import { registerSW } from "virtual:pwa-register";
import { useCallback, useEffect, useState } from "react";

export interface BeforeInstallPromptEvent extends Event {
	readonly platforms: string[];
	readonly userChoice: Promise<{
		outcome: "accepted" | "dismissed";
		platform: string;
	}>;
	prompt(): Promise<void>;
}

export interface PwaState {
	needRefresh: boolean;
	canInstall: boolean;
	updateApp: () => Promise<void>;
	dismissUpdate: () => void;
	promptInstall: () => Promise<void>;
}

let deferredInstallPrompt: BeforeInstallPromptEvent | null = null;
let updateSwCallback: ((reloadPage?: boolean) => Promise<void>) | null = null;

export function usePwa(): PwaState {
	const [needRefresh, setNeedRefresh] = useState(false);
	const [canInstall, setCanInstall] = useState(false);

	useEffect(() => {
		// 1. Detect if already standalone
		const isStandalone =
			(typeof window !== "undefined" &&
				window.matchMedia?.("(display-mode: standalone)").matches) ||
			(typeof navigator !== "undefined" &&
				(navigator as unknown as { standalone?: boolean }).standalone === true);

		if (!isStandalone && deferredInstallPrompt) {
			setCanInstall(true);
		}

		// 2. Install prompt listener
		const handleBeforeInstallPrompt = (e: Event) => {
			e.preventDefault();
			deferredInstallPrompt = e as BeforeInstallPromptEvent;
			if (!isStandalone) {
				setCanInstall(true);
			}
		};

		const handleAppInstalled = () => {
			deferredInstallPrompt = null;
			setCanInstall(false);
		};

		window.addEventListener(
			"beforeinstallprompt",
			handleBeforeInstallPrompt as EventListener,
		);
		window.addEventListener("appinstalled", handleAppInstalled);

		// 3. Register root PWA Service Worker (scope: /)
		if ("serviceWorker" in navigator) {
			const updateSW = registerSW({
				onNeedRefresh() {
					setNeedRefresh(true);
				},
				onOfflineReady() {
					// Static app shell cached and ready
				},
			});
			updateSwCallback = updateSW;
		}

		return () => {
			window.removeEventListener(
				"beforeinstallprompt",
				handleBeforeInstallPrompt as EventListener,
			);
			window.removeEventListener("appinstalled", handleAppInstalled);
		};
	}, []);

	const updateApp = useCallback(async () => {
		if (updateSwCallback) {
			await updateSwCallback(true);
		}
	}, []);

	const dismissUpdate = useCallback(() => {
		setNeedRefresh(false);
	}, []);

	const promptInstall = useCallback(async () => {
		const promptEvent = deferredInstallPrompt;
		if (!promptEvent) return;
		deferredInstallPrompt = null;
		setCanInstall(false);

		try {
			await promptEvent.prompt();
			await promptEvent.userChoice;
		} catch {
			// Ignore rejection
		}
	}, []);

	return {
		needRefresh,
		canInstall,
		updateApp,
		dismissUpdate,
		promptInstall,
	};
}
