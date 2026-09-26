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

describe("Initial Bootstrap & Passkey Enrollment", () => {
	beforeEach(() => {
		vi.restoreAllMocks();
		try {
			sessionStorage.clear();
		} catch {}
		try {
			localStorage.clear();
		} catch {}
	});

	it("completes full bootstrap -> enrollment -> recovery code flow and requires explicit acknowledgement", async () => {
		const mockAdapter: WebAuthnAdapter = {
			isSupported: vi.fn().mockReturnValue(true),
			authenticate: vi.fn(),
			register: vi.fn().mockResolvedValue({
				id: "new-cred-id",
				rawId: "new-raw-cred-id",
				response: {
					attestationObject: "attObj",
					clientDataJSON: "clientDataJSON",
				},
				type: "public-key",
			}),
		};
		setWebAuthnAdapter(mockAdapter);

		const fetchMock = vi.fn().mockImplementation((url: string) => {
			if (url === "/auth/status") {
				return Promise.resolve(
					new Response(JSON.stringify({ state: "UNINITIALIZED" }), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					}),
				);
			}
			if (url === "/auth/bootstrap/authorize") {
				return Promise.resolve(
					new Response(
						JSON.stringify({ enrollmentGrantToken: "grant-token-123" }),
						{
							status: 200,
							headers: { "Content-Type": "application/json" },
						},
					),
				);
			}
			if (url === "/auth/passkey/enrollment/options") {
				return Promise.resolve(
					new Response(
						JSON.stringify({
							challenge: "enrollment-challenge",
							rp: { name: "Gelir Gider", id: "localhost" },
							user: { id: "user-1", name: "Eren", displayName: "Eren" },
							pubKeyCredParams: [],
						}),
						{
							status: 200,
							headers: { "Content-Type": "application/json" },
						},
					),
				);
			}
			if (url === "/auth/passkey/enrollment/verify") {
				return Promise.resolve(
					new Response(
						JSON.stringify({
							verified: true,
							purpose: "BOOTSTRAP",
							credential: { deviceName: "Bu cihaz" },
							recoveryCode: "REC-1234-5678-ABCD",
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
					<div data-testid="protected-content">Unlocked Content</div>
				</AuthGate>
			</AuthProvider>,
		);

		// Bootstrap enrollment form appears
		const tokenInput = await screen.findByTestId("bootstrap-token-input");
		const nameInput = screen.getByTestId("display-name-input");
		const authorizeBtn = screen.getByTestId("authorize-bootstrap-button");

		await act(async () => {
			fireEvent.change(tokenInput, {
				target: { value: "secret-bootstrap-token" },
			});
			fireEvent.change(nameInput, { target: { value: "Eren" } });
			fireEvent.click(authorizeBtn);
		});

		// Now in ENROLLING state, prompts for deviceName
		const registerBtn = await screen.findByTestId("register-passkey-button");
		await act(async () => {
			fireEvent.click(registerBtn);
		});

		// Recovery code is displayed
		const recoveryBox = await screen.findByTestId("recovery-code-box");
		expect(recoveryBox).toHaveTextContent("REC-1234-5678-ABCD");

		// Verify recovery code was NOT persisted to localStorage or sessionStorage
		expect(sessionStorage?.getItem("recoveryCode")).toBeFalsy();
		if (typeof localStorage !== "undefined" && localStorage !== null) {
			expect(localStorage.getItem("recoveryCode")).toBeFalsy();
		}

		// Devam Et button is initially disabled until acknowledgement
		const continueBtn = screen.getByTestId("acknowledge-recovery-button");
		expect(continueBtn).toBeDisabled();

		// Check acknowledgement
		const ackCheckbox = screen.getByTestId("recovery-ack-checkbox");
		await act(async () => {
			fireEvent.click(ackCheckbox);
		});

		expect(continueBtn).not.toBeDisabled();

		// Click continue
		await act(async () => {
			fireEvent.click(continueBtn);
		});

		// Successfully unlocked
		await waitFor(() => {
			expect(screen.getByTestId("protected-content")).toBeInTheDocument();
		});
	});

	it("handles partial success (SESSION_ESTABLISHMENT_FAILED) without re-enrolling", async () => {
		const mockAdapter: WebAuthnAdapter = {
			isSupported: vi.fn().mockReturnValue(true),
			authenticate: vi.fn(),
			register: vi.fn().mockResolvedValue({
				id: "new-cred-id",
				rawId: "new-raw-cred-id",
				response: {
					attestationObject: "attObj",
					clientDataJSON: "clientDataJSON",
				},
				type: "public-key",
			}),
		};
		setWebAuthnAdapter(mockAdapter);

		const fetchMock = vi.fn().mockImplementation((url: string) => {
			if (url === "/auth/status") {
				return Promise.resolve(
					new Response(JSON.stringify({ state: "UNINITIALIZED" }), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					}),
				);
			}
			if (url === "/auth/bootstrap/authorize") {
				return Promise.resolve(
					new Response(
						JSON.stringify({ enrollmentGrantToken: "grant-token-123" }),
						{
							status: 200,
							headers: { "Content-Type": "application/json" },
						},
					),
				);
			}
			if (url === "/auth/passkey/enrollment/options") {
				return Promise.resolve(
					new Response(JSON.stringify({ challenge: "c" }), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					}),
				);
			}
			if (url === "/auth/passkey/enrollment/verify") {
				// Partial success: verified true, authenticated false
				return Promise.resolve(
					new Response(
						JSON.stringify({
							verified: true,
							purpose: "BOOTSTRAP",
							credential: { deviceName: "Bu cihaz" },
							recoveryCode: "REC-9999",
							authenticated: false,
							warning: {
								code: "SESSION_ESTABLISHMENT_FAILED",
								message: "Oturum oluşturulamadı",
							},
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

		const tokenInput = await screen.findByTestId("bootstrap-token-input");
		const nameInput = screen.getByTestId("display-name-input");
		const authorizeBtn = screen.getByTestId("authorize-bootstrap-button");

		await act(async () => {
			fireEvent.change(tokenInput, { target: { value: "token" } });
			fireEvent.change(nameInput, { target: { value: "Eren" } });
			fireEvent.click(authorizeBtn);
		});

		const registerBtn = await screen.findByTestId("register-passkey-button");
		await act(async () => {
			fireEvent.click(registerBtn);
		});

		// Warning alert is displayed
		const warningAlert = await screen.findByTestId("recovery-warning-alert");
		expect(warningAlert).toBeInTheDocument();

		// Recovery code is still displayed
		expect(screen.getByTestId("recovery-code-box")).toHaveTextContent(
			"REC-9999",
		);

		// Acknowledge and proceed
		await act(async () => {
			fireEvent.click(screen.getByTestId("recovery-ack-checkbox"));
		});
		await act(async () => {
			fireEvent.click(screen.getByTestId("acknowledge-recovery-button"));
		});

		// After acknowledgement, proceeds to normal unlock screen instead of re-enrolling
		const unlockBtn = await screen.findByTestId("unlock-passkey-button");
		expect(unlockBtn).toBeInTheDocument();
	});
});
