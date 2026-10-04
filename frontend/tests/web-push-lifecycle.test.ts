import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	findPushRegistration,
	getOrRegisterPushServiceWorker,
	safeErrorName,
	waitForActivatedWorker,
} from "../src/lib/web-push";

type State =
	| "installing"
	| "installed"
	| "activating"
	| "activated"
	| "redundant";

function makeWorker(state: State) {
	const listeners = new Set<() => void>();
	return {
		state,
		addEventListener: (_t: string, l: () => void) => listeners.add(l),
		removeEventListener: (_t: string, l: () => void) => listeners.delete(l),
		transition(next: State) {
			this.state = next;
			for (const l of [...listeners]) l();
		},
	};
}

function makeReg(
	scopePath: string,
	worker: ReturnType<typeof makeWorker> | null,
) {
	const isActive = worker?.state === "activated";
	return {
		scope: `${window.location.origin}${scopePath}`,
		active: isActive ? worker : null,
		installing: worker && !isActive ? worker : null,
		waiting: null,
		pushManager: { getSubscription: vi.fn(), subscribe: vi.fn() },
	};
}

function stubSw(
	regs: ReturnType<typeof makeReg>[],
	registerImpl?: () => unknown,
) {
	const register = vi.fn(async (_url: string, opts: { scope: string }) => {
		const r = registerImpl
			? (registerImpl() as ReturnType<typeof makeReg>)
			: makeReg(opts.scope, makeWorker("activated"));
		regs.push(r);
		return r;
	});
	const sw = {
		getRegistrations: vi.fn(async () => [...regs]),
		// Mimics the real defect: "/push/" client URL matches the root scope too.
		getRegistration: vi.fn(async () => regs[0]),
		register,
	};
	Object.defineProperty(navigator, "serviceWorker", {
		value: sw,
		configurable: true,
	});
	return sw;
}

describe("push service worker exact-scope resolution", () => {
	beforeEach(() => {
		Object.defineProperty(window, "isSecureContext", {
			value: true,
			configurable: true,
		});
		(window as unknown as Record<string, unknown>).PushManager = class {};
		(window as unknown as Record<string, unknown>).Notification = class {};
	});
	afterEach(() => vi.restoreAllMocks());

	it("root-only registration: registers dedicated /push/ and never returns root", async () => {
		const root = makeReg("/", makeWorker("activated"));
		const sw = stubSw([root]);

		const reg = await getOrRegisterPushServiceWorker();

		expect(sw.register).toHaveBeenCalledTimes(1);
		expect(sw.register).toHaveBeenCalledWith("/push-sw.js", {
			scope: "/push/",
		});
		expect(reg).not.toBe(root);
		expect(new URL(reg.scope).pathname).toBe("/push/");
	});

	it("root + /push/ both exist: returns exact /push/, no re-register", async () => {
		const root = makeReg("/", makeWorker("activated"));
		const push = makeReg("/push/", makeWorker("activated"));
		const sw = stubSw([root, push]);

		const reg = await getOrRegisterPushServiceWorker();

		expect(reg).toBe(push);
		expect(sw.register).not.toHaveBeenCalled();
	});

	it("findPushRegistration ignores root", async () => {
		stubSw([makeReg("/", makeWorker("activated"))]);
		expect(await findPushRegistration()).toBeUndefined();
	});

	it("rejects a register() result with a non-/push/ scope", async () => {
		stubSw([], () => makeReg("/", makeWorker("activated")));
		await expect(getOrRegisterPushServiceWorker()).rejects.toMatchObject({
			name: "PushScopeMismatch",
		});
	});
});

describe("push worker activation lifecycle", () => {
	beforeEach(() => {
		Object.defineProperty(window, "isSecureContext", {
			value: true,
			configurable: true,
		});
		(window as unknown as Record<string, unknown>).PushManager = class {};
		(window as unknown as Record<string, unknown>).Notification = class {};
	});

	it("does not resolve until installing worker becomes activated", async () => {
		const worker = makeWorker("installing");
		stubSw([], () => makeReg("/push/", worker));

		let resolved = false;
		const p = getOrRegisterPushServiceWorker().then((r) => {
			resolved = true;
			return r;
		});
		await Promise.resolve();
		await Promise.resolve();
		expect(resolved).toBe(false);

		worker.transition("installed");
		await Promise.resolve();
		expect(resolved).toBe(false);
		worker.transition("activating");
		await Promise.resolve();
		expect(resolved).toBe(false);

		worker.transition("activated");
		const reg = await p;
		expect(resolved).toBe(true);
		expect(new URL(reg.scope).pathname).toBe("/push/");
	});

	it("times out safely and never reaches subscribe", async () => {
		vi.useFakeTimers();
		try {
			const worker = makeWorker("installing");
			const reg = makeReg("/push/", worker);
			const p = waitForActivatedWorker(
				reg as unknown as ServiceWorkerRegistration,
				50,
			);
			const assertion = expect(p).rejects.toMatchObject({
				name: "PushActivationTimeout",
			});
			await vi.advanceTimersByTimeAsync(60);
			await assertion;
			expect(reg.pushManager.subscribe).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});

	it("rejects when worker becomes redundant", async () => {
		const worker = makeWorker("installing");
		const reg = makeReg("/push/", worker);
		const p = waitForActivatedWorker(
			reg as unknown as ServiceWorkerRegistration,
			1000,
		);
		worker.transition("redundant");
		await expect(p).rejects.toMatchObject({ name: "PushActivationFailed" });
	});
});

describe("safeErrorName", () => {
	it("returns only the error name, never message", () => {
		const e = new DOMException("endpoint=https://secret", "AbortError");
		expect(safeErrorName(e)).toBe("AbortError");
		expect(safeErrorName({ name: "x y/secret" })).toBe("UnknownError");
		expect(safeErrorName(null)).toBe("UnknownError");
	});
});
