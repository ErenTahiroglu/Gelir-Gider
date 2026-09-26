export const BACKGROUND_LOCK_THRESHOLD_MS = 120_000; // 120 seconds
const STORAGE_KEY_HIDDEN_AT = "gg_hidden_at";

export interface VisibilityLockCallbacks {
	onHide: (hiddenAt: number) => void;
	onRestoreUnlocked: () => void;
	onRequireReauth: () => void;
}

export function saveHiddenTimestamp(timestamp: number): void {
	try {
		sessionStorage.setItem(STORAGE_KEY_HIDDEN_AT, timestamp.toString());
	} catch {
		// Ignore storage quota or disabled storage in privacy mode
	}
}

export function getStoredHiddenTimestamp(): number | null {
	try {
		const val = sessionStorage.getItem(STORAGE_KEY_HIDDEN_AT);
		if (!val) return null;
		const parsed = Number.parseInt(val, 10);
		return Number.isNaN(parsed) ? null : parsed;
	} catch {
		return null;
	}
}

export function clearStoredHiddenTimestamp(): void {
	try {
		sessionStorage.removeItem(STORAGE_KEY_HIDDEN_AT);
	} catch {
		// Ignore
	}
}

export function evaluateElapsedHiddenDuration(
	hiddenAt: number,
	now: number = Date.now(),
): { shouldLock: boolean; elapsedMs: number } {
	const elapsedMs = Math.max(0, now - hiddenAt);
	return {
		shouldLock: elapsedMs >= BACKGROUND_LOCK_THRESHOLD_MS,
		elapsedMs,
	};
}

export function setupVisibilityLock(
	callbacks: VisibilityLockCallbacks,
	isUnlocked: () => boolean,
): () => void {
	let inMemoryHiddenAt: number | null = getStoredHiddenTimestamp();

	const handleVisibilityChange = () => {
		if (document.visibilityState === "hidden") {
			if (isUnlocked()) {
				const now = Date.now();
				inMemoryHiddenAt = now;
				saveHiddenTimestamp(now);
				callbacks.onHide(now);
			}
		} else if (document.visibilityState === "visible") {
			const hiddenAt = inMemoryHiddenAt ?? getStoredHiddenTimestamp();
			if (hiddenAt !== null) {
				const { shouldLock } = evaluateElapsedHiddenDuration(hiddenAt);
				inMemoryHiddenAt = null;
				clearStoredHiddenTimestamp();

				if (shouldLock) {
					callbacks.onRequireReauth();
				} else {
					callbacks.onRestoreUnlocked();
				}
			}
		}
	};

	document.addEventListener("visibilitychange", handleVisibilityChange);

	return () => {
		document.removeEventListener("visibilitychange", handleVisibilityChange);
	};
}
