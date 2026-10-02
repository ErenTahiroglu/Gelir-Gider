import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "../src/auth/auth-context";
import type { WebAuthnAdapter } from "../src/auth/webauthn-client";
import { setWebAuthnAdapter } from "../src/auth/webauthn-client";
import { AuthGate } from "../src/components/auth/AuthGate";
import { DeviceManagementPage } from "../src/components/devices/DeviceManagementPage";

describe("Workstream B: Multi-Device Pairing Flow", () => {
	beforeEach(() => {
		vi.restoreAllMocks();
	});

	it("completes pairing flow from unlock screen to unlocked state without recovery code requirement", async () => {
		const mockAdapter: WebAuthnAdapter = {
			isSupported: vi.fn().mockReturnValue(true),
			authenticate: vi.fn(),
			register: vi.fn().mockResolvedValue({
				id: "new-device-cred-id",
				rawId: "raw-id-new",
				response: { attestationObject: "att-obj", clientDataJSON: "cdj-obj" },
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
			if (url === "/auth/passkey/enrollment/options") {
				return Promise.resolve(
					new Response(
						JSON.stringify({
							challenge: "enrollment-challenge",
							rp: { name: "Gelir-Gider", id: "localhost" },
							user: { id: "user-id", name: "user", displayName: "User" },
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
							authenticated: true,
							purpose: "ADD_CREDENTIAL",
							recoveryCode: null,
						}),
						{
							status: 200,
							headers: { "Content-Type": "application/json" },
						},
					),
				);
			}
			return Promise.reject(new Error(`Unhandled URL: ${url}`));
		});
		vi.stubGlobal("fetch", fetchMock);

		render(
			<AuthProvider>
				<AuthGate>
					<div data-testid="dashboard-content">Dashboard Protected Area</div>
				</AuthGate>
			</AuthProvider>,
		);

		// 1. Initial status resolves to AUTH_REQUIRED
		const startPairingBtn = await screen.findByTestId("start-pairing-button");
		expect(startPairingBtn).toBeInTheDocument();

		// 2. Click "Yeni cihaz bağla"
		await act(async () => {
			fireEvent.click(startPairingBtn);
		});

		// 3. Pairing flow inputs appear
		const pairingInput = await screen.findByTestId("pairing-code-input");
		const deviceNameInput = screen.getByTestId("pairing-device-name-input");
		const submitPairingBtn = screen.getByTestId("submit-pairing-button");

		await act(async () => {
			fireEvent.change(pairingInput, {
				target: { value: "pairing-grant-token-123" },
			});
			fireEvent.change(deviceNameInput, {
				target: { value: "Honor 90" },
			});
		});

		// 4. Submit pairing form
		await act(async () => {
			fireEvent.click(submitPairingBtn);
		});

		// 5. Verifies registration was called and dashboard content is unlocked directly
		expect(mockAdapter.register).toHaveBeenCalledTimes(1);
		const dashboardContent = await screen.findByTestId("dashboard-content");
		expect(dashboardContent).toBeInTheDocument();
	});

	it("shows destructive warning banner on recovery screen", async () => {
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
			return Promise.reject(new Error(`Unhandled URL: ${url}`));
		});
		vi.stubGlobal("fetch", fetchMock);

		render(
			<AuthProvider>
				<AuthGate>
					<div>Protected Content</div>
				</AuthGate>
			</AuthProvider>,
		);

		const recoveryLink = await screen.findByTestId("use-recovery-code-link");
		await act(async () => {
			fireEvent.click(recoveryLink);
		});

		const warningBanner = await screen.findByTestId(
			"recovery-destructive-warning",
		);
		expect(warningBanner).toBeInTheDocument();
		expect(warningBanner.textContent).toContain(
			"Kurtarma işlemi mevcut tüm cihazların Passkey anahtarlarını ve açık oturumlarını sıfırlar",
		);
		expect(warningBanner.textContent).toContain("Yeni cihaz bağla");
	});

	it("DeviceManagementPage displays registered devices and creates pairing grant", async () => {
		const mockAdapter: WebAuthnAdapter = {
			isSupported: vi.fn().mockReturnValue(true),
			authenticate: vi.fn().mockResolvedValue({
				id: "assertion-id",
				rawId: "raw-id",
				response: {
					authenticatorData: "auth-data",
					clientDataJSON: "cdj",
					signature: "sig",
				},
				type: "public-key",
			}),
			register: vi.fn(),
		};
		setWebAuthnAdapter(mockAdapter);

		const fetchMock = vi.fn().mockImplementation((url: string) => {
			if (url === "/auth/devices") {
				return Promise.resolve(
					new Response(
						JSON.stringify({
							devices: [
								{
									id: "dev-1",
									deviceName: "macOS Brave",
									deviceType: "platform",
									createdAt: "2026-10-01T12:00:00.000Z",
									lastUsedAt: "2026-10-02T15:00:00.000Z",
								},
							],
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
					new Response(JSON.stringify({ challenge: "reauth-challenge" }), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					}),
				);
			}
			if (url === "/auth/devices/pairing-grant") {
				return Promise.resolve(
					new Response(
						JSON.stringify({
							enrollmentGrantToken: "pairing-code-xyz-789",
							expiresAt: "2026-10-02T16:00:00.000Z",
							purpose: "ADD_CREDENTIAL",
						}),
						{
							status: 200,
							headers: { "Content-Type": "application/json" },
						},
					),
				);
			}
			return Promise.reject(new Error(`Unhandled URL: ${url}`));
		});
		vi.stubGlobal("fetch", fetchMock);

		render(<DeviceManagementPage />);

		// Verify device list renders
		const deviceItem = await screen.findByTestId("device-item-dev-1");
		expect(deviceItem).toBeInTheDocument();
		expect(screen.getByText("macOS Brave")).toBeInTheDocument();

		// Click "Yeni Cihaz / Passkey Ekle"
		const addDeviceBtn = screen.getByTestId("add-device-button");
		await act(async () => {
			fireEvent.click(addDeviceBtn);
		});

		// Verify reauth assertion was requested
		expect(mockAdapter.authenticate).toHaveBeenCalledTimes(1);

		// Verify pairing token section is displayed
		const pairingSection = await screen.findByTestId("pairing-grant-section");
		expect(pairingSection).toBeInTheDocument();
		const tokenDisplay = screen.getByTestId("pairing-token-display");
		expect(tokenDisplay.textContent).toContain("pairing-code-xyz-789");
	});
});
