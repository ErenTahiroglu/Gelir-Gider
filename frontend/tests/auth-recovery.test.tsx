import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "../src/auth/auth-context";
import type { WebAuthnAdapter } from "../src/auth/webauthn-client";
import { setWebAuthnAdapter } from "../src/auth/webauthn-client";
import { AuthGate } from "../src/components/auth/AuthGate";

describe("Emergency Recovery Flow", () => {
	beforeEach(() => {
		vi.restoreAllMocks();
	});

	it("completes recovery code -> enrollment grant -> new passkey registration", async () => {
		const mockAdapter: WebAuthnAdapter = {
			isSupported: vi.fn().mockReturnValue(true),
			authenticate: vi.fn(),
			register: vi.fn().mockResolvedValue({
				id: "recovered-cred-id",
				rawId: "raw-id",
				response: { attestationObject: "att", clientDataJSON: "cdj" },
				type: "public-key",
			}),
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
					new Response(JSON.stringify({ error: { code: "UNAUTHENTICATED" } }), {
						status: 401,
						headers: { "Content-Type": "application/json" },
					}),
				);
			}
			if (url === "/auth/recovery/authorize") {
				return Promise.resolve(
					new Response(
						JSON.stringify({ enrollmentGrantToken: "recovery-grant-456" }),
						{
							status: 200,
							headers: { "Content-Type": "application/json" },
						},
					),
				);
			}
			if (url === "/auth/passkey/enrollment/options") {
				return Promise.resolve(
					new Response(JSON.stringify({ challenge: "rec-challenge" }), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					}),
				);
			}
			if (url === "/auth/passkey/enrollment/verify") {
				return Promise.resolve(
					new Response(
						JSON.stringify({
							verified: true,
							purpose: "RECOVERY",
							credential: { deviceName: "Yeni cihaz" },
							recoveryCode: "NEW-REC-CODE-777",
							authenticated: true,
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
					<div>Protected</div>
				</AuthGate>
			</AuthProvider>,
		);

		const recoveryLink = await screen.findByTestId("use-recovery-code-link");
		await act(async () => {
			fireEvent.click(recoveryLink);
		});

		// Now on recovery screen
		const recoveryInput = await screen.findByTestId("recovery-code-input");
		const submitRecoveryBtn = screen.getByTestId("submit-recovery-code-button");

		await act(async () => {
			fireEvent.change(recoveryInput, { target: { value: "OLD-VALID-CODE" } });
			fireEvent.click(submitRecoveryBtn);
		});

		// Prompts for passkey registration
		const registerBtn = await screen.findByTestId("register-passkey-button");
		await act(async () => {
			fireEvent.click(registerBtn);
		});

		// Displays new recovery code
		const recoveryBox = await screen.findByTestId("recovery-code-box");
		expect(recoveryBox).toHaveTextContent("NEW-REC-CODE-777");
	});

	it("shows friendly retryable error when recovery code is invalid", async () => {
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
			if (url === "/auth/recovery/authorize") {
				return Promise.resolve(
					new Response(
						JSON.stringify({
							error: {
								code: "RECOVERY_CODE_INVALID",
								message: "Invalid code",
							},
						}),
						{
							status: 403,
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

		const recoveryLink = await screen.findByTestId("use-recovery-code-link");
		await act(async () => {
			fireEvent.click(recoveryLink);
		});

		const recoveryInput = await screen.findByTestId("recovery-code-input");
		const submitRecoveryBtn = screen.getByTestId("submit-recovery-code-button");

		await act(async () => {
			fireEvent.change(recoveryInput, { target: { value: "INVALID-CODE" } });
			fireEvent.click(submitRecoveryBtn);
		});

		const errorAlert = await screen.findByTestId("recovery-error-alert");
		expect(errorAlert).toHaveTextContent(
			/geçersiz veya daha önce kullanılmış/i,
		);
	});
});
