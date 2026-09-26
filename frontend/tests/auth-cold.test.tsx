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
import {
	resetWebAuthnAdapter,
	setBrowserWebAuthnClient,
	setWebAuthnAdapter,
} from "../src/auth/webauthn-client";
import { AuthGate } from "../src/components/auth/AuthGate";

describe("Cold Launch Passkey Authentication", () => {
	beforeEach(() => {
		vi.restoreAllMocks();
	});

	it("completes full passkey authentication ceremony and reveals protected content only after success", async () => {
		const mockAdapter: WebAuthnAdapter = {
			isSupported: vi.fn().mockReturnValue(true),
			authenticate: vi.fn().mockResolvedValue({
				id: "cred-test-id",
				rawId: "raw-cred-id",
				response: {
					authenticatorData: "authData",
					clientDataJSON: "clientDataJSON",
					signature: "signature",
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
				// Initially unauthenticated (cold launch)
				return Promise.resolve(
					new Response(
						JSON.stringify({
							error: { code: "UNAUTHENTICATED", message: "Required" },
						}),
						{
							status: 401,
							headers: { "Content-Type": "application/json" },
						},
					),
				);
			}
			if (url === "/auth/passkey/authentication/options") {
				return Promise.resolve(
					new Response(
						JSON.stringify({
							challenge: "test-auth-challenge",
							rpId: "localhost",
						}),
						{
							status: 200,
							headers: { "Content-Type": "application/json" },
						},
					),
				);
			}
			if (url === "/auth/passkey/authentication/verify") {
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
			return Promise.reject(new Error(`Unhandled route ${url}`));
		});
		vi.stubGlobal("fetch", fetchMock);

		render(
			<AuthProvider>
				<AuthGate>
					<div data-testid="protected-finance-dashboard">
						Protected Financial Content
					</div>
				</AuthGate>
			</AuthProvider>,
		);

		// Initial render: protected content MUST NOT be displayed
		expect(
			screen.queryByTestId("protected-finance-dashboard"),
		).not.toBeInTheDocument();

		// Wait for unlock screen to appear
		const unlockBtn = await screen.findByTestId("unlock-passkey-button");
		expect(unlockBtn).toBeInTheDocument();
		expect(
			screen.queryByTestId("protected-finance-dashboard"),
		).not.toBeInTheDocument();

		// Click passkey button
		await act(async () => {
			fireEvent.click(unlockBtn);
		});

		// Verify protected content is revealed only after ceremony completes
		await waitFor(() => {
			expect(
				screen.getByTestId("protected-finance-dashboard"),
			).toBeInTheDocument();
		});

		// Verification of exact request sequence:
		// 1 options call, 1 browser adapter call, 1 verify call
		const optionsCalls = fetchMock.mock.calls.filter(
			(c) => c[0] === "/auth/passkey/authentication/options",
		);
		const verifyCalls = fetchMock.mock.calls.filter(
			(c) => c[0] === "/auth/passkey/authentication/verify",
		);

		expect(optionsCalls).toHaveLength(1);
		expect(mockAdapter.authenticate).toHaveBeenCalledTimes(1);
		expect(verifyCalls).toHaveLength(1);
	});

	it("handles user cancellation of passkey ceremony cleanly with retryable error", async () => {
		resetWebAuthnAdapter();
		setBrowserWebAuthnClient({
			startAuthentication: vi
				.fn()
				.mockRejectedValue(
					new DOMException("The operation was aborted", "AbortError"),
				),
			startRegistration: vi.fn(),
		});

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
					new Response(JSON.stringify({ error: { code: "UNAUTHENTICATED" } }), {
						status: 401,
						headers: { "Content-Type": "application/json" },
					}),
				);
			}
			if (url === "/auth/passkey/authentication/options") {
				return Promise.resolve(
					new Response(JSON.stringify({ challenge: "c1" }), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					}),
				);
			}
			return Promise.reject(new Error(`Unhandled route ${url}`));
		});
		vi.stubGlobal("fetch", fetchMock);

		render(
			<AuthProvider>
				<AuthGate>
					<div data-testid="protected-finance-dashboard">Protected</div>
				</AuthGate>
			</AuthProvider>,
		);

		const unlockBtn = await screen.findByTestId("unlock-passkey-button");
		await act(async () => {
			fireEvent.click(unlockBtn);
		});

		// User sees retryable message, not raw internal error
		const alert = await screen.findByTestId("auth-error-alert");
		expect(alert).toHaveTextContent(/tamamlanmadı|tekrar/i);
		expect(
			screen.queryByTestId("protected-finance-dashboard"),
		).not.toBeInTheDocument();
	});
});
