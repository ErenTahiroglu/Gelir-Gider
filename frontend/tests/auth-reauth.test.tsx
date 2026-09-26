import {
	act,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "../src/auth/auth-context";
import type { WebAuthnAdapter } from "../src/auth/webauthn-client";
import { setWebAuthnAdapter } from "../src/auth/webauthn-client";
import { AuthGate } from "../src/components/auth/AuthGate";

describe("Background Reauthentication (>=120s)", () => {
	beforeEach(() => {
		sessionStorage.clear();
		vi.restoreAllMocks();
	});

	it("completes step-up reauthentication and unlocks application without replacing session", async () => {
		const mockAdapter: WebAuthnAdapter = {
			isSupported: vi.fn().mockReturnValue(true),
			authenticate: vi.fn().mockResolvedValue({
				id: "reauth-id",
				rawId: "raw-reauth-id",
				response: {
					authenticatorData: "authData",
					clientDataJSON: "clientDataJSON",
					signature: "sig",
				},
				type: "public-key",
			}),
			register: vi.fn(),
		};
		setWebAuthnAdapter(mockAdapter);

		const fetchMock = vi.fn().mockImplementation((url: string) => {
			if (url === "/auth/status") {
				return Promise.resolve(
					new Response(JSON.stringify({ state: "INITIALIZED" }), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					}),
				);
			}
			if (url === "/auth/session") {
				return Promise.resolve(
					new Response(
						JSON.stringify({
							authenticated: true,
							user: { displayName: "Eren" },
						}),
						{
							status: 200,
							headers: { "Content-Type": "application/json" },
						},
					),
				);
			}
			if (url === "/auth/passkey/reauth/options") {
				return Promise.resolve(
					new Response(JSON.stringify({ challenge: "reauth-c" }), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					}),
				);
			}
			if (url === "/auth/passkey/reauth/verify") {
				return Promise.resolve(
					new Response(
						JSON.stringify({
							verified: true,
							credential: { deviceName: "Bu cihaz" },
						}),
						{
							status: 200,
							headers: { "Content-Type": "application/json" },
						},
					),
				);
			}
			return Promise.reject(new Error(`Unhandled route ${url}`));
		});
		vi.stubGlobal("fetch", fetchMock);

		render(
			<AuthProvider>
				<AuthGate>
					<div data-testid="protected-content">Unlocked Content</div>
				</AuthGate>
			</AuthProvider>,
		);

		await screen.findByTestId("protected-content");

		// Trigger background lock (>= 120s)
		const t0 = 100_000;
		vi.spyOn(Date, "now").mockReturnValue(t0);
		await act(async () => {
			Object.defineProperty(document, "visibilityState", {
				value: "hidden",
				configurable: true,
			});
			document.dispatchEvent(new Event("visibilitychange"));
		});

		vi.spyOn(Date, "now").mockReturnValue(t0 + 125_000);
		await act(async () => {
			Object.defineProperty(document, "visibilityState", {
				value: "visible",
				configurable: true,
			});
			document.dispatchEvent(new Event("visibilitychange"));
		});

		// Locked overlay is present
		const unlockBtn = await screen.findByTestId("reauth-passkey-button");
		expect(unlockBtn).toBeInTheDocument();

		// Click reauth
		await act(async () => {
			fireEvent.click(unlockBtn);
		});

		// Verified and returned to unlocked
		await waitFor(() => {
			expect(screen.queryByTestId("locked-overlay")).not.toBeInTheDocument();
		});

		const reauthVerifyCalls = fetchMock.mock.calls.filter(
			(c) => c[0] === "/auth/passkey/reauth/verify",
		);
		expect(reauthVerifyCalls).toHaveLength(1);
	});

	it("falls back to full cold authentication if session expired during background lock (401)", async () => {
		const mockAdapter: WebAuthnAdapter = {
			isSupported: vi.fn().mockReturnValue(true),
			authenticate: vi.fn(),
			register: vi.fn(),
		};
		setWebAuthnAdapter(mockAdapter);

		const fetchMock = vi.fn().mockImplementation((url: string) => {
			if (url === "/auth/status") {
				return Promise.resolve(
					new Response(JSON.stringify({ state: "INITIALIZED" }), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					}),
				);
			}
			if (url === "/auth/session") {
				return Promise.resolve(
					new Response(
						JSON.stringify({
							authenticated: true,
							user: { displayName: "Eren" },
						}),
						{
							status: 200,
							headers: { "Content-Type": "application/json" },
						},
					),
				);
			}
			if (url === "/auth/passkey/reauth/options") {
				// Session has expired in backend!
				return Promise.resolve(
					new Response(
						JSON.stringify({
							error: { code: "UNAUTHENTICATED", message: "Session expired" },
						}),
						{
							status: 401,
							headers: { "Content-Type": "application/json" },
						},
					),
				);
			}
			return Promise.reject(new Error(`Unhandled route ${url}`));
		});
		vi.stubGlobal("fetch", fetchMock);

		render(
			<AuthProvider>
				<AuthGate>
					<div>Protected</div>
				</AuthGate>
			</AuthProvider>,
		);

		await screen.findByText("Protected");

		// Trigger lock
		const t0 = 100_000;
		vi.spyOn(Date, "now").mockReturnValue(t0);
		await act(async () => {
			Object.defineProperty(document, "visibilityState", {
				value: "hidden",
				configurable: true,
			});
			document.dispatchEvent(new Event("visibilitychange"));
		});

		vi.spyOn(Date, "now").mockReturnValue(t0 + 125_000);
		await act(async () => {
			Object.defineProperty(document, "visibilityState", {
				value: "visible",
				configurable: true,
			});
			document.dispatchEvent(new Event("visibilitychange"));
		});

		const unlockBtn = await screen.findByTestId("reauth-passkey-button");
		await act(async () => {
			fireEvent.click(unlockBtn);
		});

		// Falls back to full cold authentication UnlockScreen
		const coldUnlockBtn = await screen.findByTestId("unlock-passkey-button");
		expect(coldUnlockBtn).toBeInTheDocument();
		expect(screen.queryByTestId("locked-overlay")).not.toBeInTheDocument();
	});
});
