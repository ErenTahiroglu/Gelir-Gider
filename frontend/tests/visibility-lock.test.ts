import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	BACKGROUND_LOCK_THRESHOLD_MS,
	clearStoredHiddenTimestamp,
	evaluateElapsedHiddenDuration,
	getStoredHiddenTimestamp,
	saveHiddenTimestamp,
	setupVisibilityLock,
} from "../src/auth/visibility-lock";

describe("Background Lock Timing & Suspension Resilience", () => {
	beforeEach(() => {
		sessionStorage.clear();
		vi.restoreAllMocks();
	});

	it("does NOT lock when hidden for 119,999 ms (<120s)", () => {
		const hiddenAt = 1_000_000;
		const now = hiddenAt + 119_999;

		const { shouldLock, elapsedMs } = evaluateElapsedHiddenDuration(
			hiddenAt,
			now,
		);

		expect(elapsedMs).toBe(119_999);
		expect(shouldLock).toBe(false);
	});

	it("DOES lock when hidden for exactly 120,000 ms (>=120s)", () => {
		const hiddenAt = 1_000_000;
		const now = hiddenAt + BACKGROUND_LOCK_THRESHOLD_MS;

		const { shouldLock, elapsedMs } = evaluateElapsedHiddenDuration(
			hiddenAt,
			now,
		);

		expect(elapsedMs).toBe(120_000);
		expect(shouldLock).toBe(true);
	});

	it("DOES lock after prolonged mobile suspension (e.g. 1 hour elapsed)", () => {
		const hiddenAt = 1_000_000;
		const now = hiddenAt + 3_600_000;

		const { shouldLock, elapsedMs } = evaluateElapsedHiddenDuration(
			hiddenAt,
			now,
		);

		expect(elapsedMs).toBe(3_600_000);
		expect(shouldLock).toBe(true);
	});

	it("persists non-sensitive timestamp in sessionStorage to survive tab lifecycle suspension", () => {
		saveHiddenTimestamp(123456789);
		expect(getStoredHiddenTimestamp()).toBe(123456789);

		clearStoredHiddenTimestamp();
		expect(getStoredHiddenTimestamp()).toBeNull();
	});

	it("evaluates lock correctly using wall-clock timestamps on visibilitychange even if no timer fired", () => {
		const onHide = vi.fn();
		const onRestoreUnlocked = vi.fn();
		const onRequireReauth = vi.fn();

		const isUnlocked = true;

		const cleanup = setupVisibilityLock(
			{ onHide, onRestoreUnlocked, onRequireReauth },
			() => isUnlocked,
		);

		// 1. Hide document
		const startTime = 10_000;
		vi.spyOn(Date, "now").mockReturnValue(startTime);
		Object.defineProperty(document, "visibilityState", {
			value: "hidden",
			configurable: true,
		});
		document.dispatchEvent(new Event("visibilitychange"));

		expect(onHide).toHaveBeenCalledWith(startTime);

		// 2. Return visible 50 seconds later (< 120s)
		vi.spyOn(Date, "now").mockReturnValue(startTime + 50_000);
		Object.defineProperty(document, "visibilityState", {
			value: "visible",
			configurable: true,
		});
		document.dispatchEvent(new Event("visibilitychange"));

		expect(onRestoreUnlocked).toHaveBeenCalledTimes(1);
		expect(onRequireReauth).not.toHaveBeenCalled();

		// 3. Hide again
		const secondStartTime = 100_000;
		vi.spyOn(Date, "now").mockReturnValue(secondStartTime);
		Object.defineProperty(document, "visibilityState", {
			value: "hidden",
			configurable: true,
		});
		document.dispatchEvent(new Event("visibilitychange"));

		// 4. Return visible 125 seconds later (>= 120s)
		vi.spyOn(Date, "now").mockReturnValue(secondStartTime + 125_000);
		Object.defineProperty(document, "visibilityState", {
			value: "visible",
			configurable: true,
		});
		document.dispatchEvent(new Event("visibilitychange"));

		expect(onRequireReauth).toHaveBeenCalledTimes(1);

		cleanup();
	});

	it("evaluates lock correctly on window blur / focus events", () => {
		const onHide = vi.fn();
		const onRestoreUnlocked = vi.fn();
		const onRequireReauth = vi.fn();

		const cleanup = setupVisibilityLock(
			{ onHide, onRestoreUnlocked, onRequireReauth },
			() => true,
		);

		// 1. Blur window
		const t0 = 500_000;
		vi.spyOn(Date, "now").mockReturnValue(t0);
		window.dispatchEvent(new Event("blur"));

		expect(onHide).toHaveBeenCalledWith(t0);

		// 2. Focus window <120s later (e.g. 10s)
		vi.spyOn(Date, "now").mockReturnValue(t0 + 10_000);
		window.dispatchEvent(new Event("focus"));

		expect(onRestoreUnlocked).toHaveBeenCalledTimes(1);
		expect(onRequireReauth).not.toHaveBeenCalled();

		// 3. Blur again and focus >=120s later (e.g. 121s)
		const t1 = 600_000;
		vi.spyOn(Date, "now").mockReturnValue(t1);
		window.dispatchEvent(new Event("blur"));

		vi.spyOn(Date, "now").mockReturnValue(t1 + 121_000);
		window.dispatchEvent(new Event("focus"));

		expect(onRequireReauth).toHaveBeenCalledTimes(1);

		cleanup();
	});

	it("evaluates lock correctly on window pagehide / pageshow events", () => {
		const onHide = vi.fn();
		const onRestoreUnlocked = vi.fn();
		const onRequireReauth = vi.fn();

		const cleanup = setupVisibilityLock(
			{ onHide, onRestoreUnlocked, onRequireReauth },
			() => true,
		);

		// 1. Pagehide
		const t0 = 700_000;
		vi.spyOn(Date, "now").mockReturnValue(t0);
		window.dispatchEvent(new Event("pagehide"));

		expect(onHide).toHaveBeenCalledWith(t0);

		// 2. Pageshow <120s later
		vi.spyOn(Date, "now").mockReturnValue(t0 + 45_000);
		window.dispatchEvent(new Event("pageshow"));

		expect(onRestoreUnlocked).toHaveBeenCalledTimes(1);
		expect(onRequireReauth).not.toHaveBeenCalled();

		// 3. Pagehide again and pageshow >=120s later
		const t1 = 800_000;
		vi.spyOn(Date, "now").mockReturnValue(t1);
		window.dispatchEvent(new Event("pagehide"));

		vi.spyOn(Date, "now").mockReturnValue(t1 + 120_001);
		window.dispatchEvent(new Event("pageshow"));

		expect(onRequireReauth).toHaveBeenCalledTimes(1);

		cleanup();
	});
});
