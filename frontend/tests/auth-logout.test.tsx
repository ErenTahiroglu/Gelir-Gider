import {
	act,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider, useAuth } from "../src/auth/auth-context";
import { AuthGate } from "../src/components/auth/AuthGate";

function ProtectedAppWithLogout() {
	const { logout } = useAuth();
	return (
		<div>
			<div data-testid="protected-content">Sensitive Content</div>
			<button
				type="button"
				onClick={() => void logout()}
				data-testid="app-logout-btn"
			>
				Logout
			</button>
		</div>
	);
}

describe("Server-Authoritative Logout Flow", () => {
	beforeEach(() => {
		vi.restoreAllMocks();
	});

	it("sends POST /auth/logout once, clears auth state, and removes protected content", async () => {
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
			if (url === "/auth/logout") {
				return Promise.resolve(
					new Response(null, {
						status: 204,
					}),
				);
			}
			return Promise.reject(new Error(`Unhandled route ${url}`));
		});
		vi.stubGlobal("fetch", fetchMock);

		render(
			<AuthProvider
				initialAuthState={{
					status: "UNLOCKED",
					user: { displayName: "Eren" },
				}}
			>
				<AuthGate>
					<ProtectedAppWithLogout />
				</AuthGate>
			</AuthProvider>,
		);

		await screen.findByTestId("protected-content");

		const logoutBtn = screen.getByTestId("app-logout-btn");
		await act(async () => {
			fireEvent.click(logoutBtn);
		});

		// Protected content is removed and unlock screen is shown
		await waitFor(() => {
			expect(screen.queryByTestId("protected-content")).not.toBeInTheDocument();
		});

		expect(
			await screen.findByTestId("unlock-passkey-button"),
		).toBeInTheDocument();

		const logoutCalls = fetchMock.mock.calls.filter(
			(c) => c[0] === "/auth/logout",
		);
		expect(logoutCalls).toHaveLength(1);
		expect(logoutCalls[0]?.[1].method).toBe("POST");
	});

	it("handles logout server failure (503 SESSION_REVOCATION_FAILED) with blocking safe state without claiming success", async () => {
		const fetchMock = vi.fn().mockImplementation((url: string) => {
			if (url === "/auth/logout") {
				return Promise.resolve(
					new Response(
						JSON.stringify({
							error: {
								code: "SESSION_REVOCATION_FAILED",
								message: "Failed to revoke session",
							},
						}),
						{
							status: 503,
							headers: { "Content-Type": "application/json" },
						},
					),
				);
			}
			return Promise.reject(new Error(`Unhandled route ${url}`));
		});
		vi.stubGlobal("fetch", fetchMock);

		render(
			<AuthProvider
				initialAuthState={{
					status: "UNLOCKED",
					user: { displayName: "Eren" },
				}}
			>
				<AuthGate>
					<ProtectedAppWithLogout />
				</AuthGate>
			</AuthProvider>,
		);

		await screen.findByTestId("protected-content");

		const logoutBtn = screen.getByTestId("app-logout-btn");
		await act(async () => {
			fireEvent.click(logoutBtn);
		});

		// 1. Protected content is immediately hidden/removed
		await waitFor(() => {
			expect(screen.queryByTestId("protected-content")).not.toBeInTheDocument();
		});

		// 2. Normal unlock/login screen is NOT shown
		expect(
			screen.queryByTestId("unlock-passkey-button"),
		).not.toBeInTheDocument();

		// 3. Logout failure safe screen is shown with retry option
		const failedScreen = await screen.findByTestId("logout-failed-screen");
		expect(failedScreen).toBeInTheDocument();
		expect(failedScreen).toHaveTextContent(/Çıkış Tamamlanamadı/i);

		const retryBtn = screen.getByTestId("retry-logout-button");
		expect(retryBtn).toBeInTheDocument();
	});

	it("handles network failure during logout safely with retry available", async () => {
		const fetchMock = vi.fn().mockImplementation((url: string) => {
			if (url === "/auth/logout") {
				return Promise.reject(new TypeError("Failed to fetch"));
			}
			return Promise.reject(new Error(`Unhandled route ${url}`));
		});
		vi.stubGlobal("fetch", fetchMock);

		render(
			<AuthProvider
				initialAuthState={{
					status: "UNLOCKED",
					user: { displayName: "Eren" },
				}}
			>
				<AuthGate>
					<ProtectedAppWithLogout />
				</AuthGate>
			</AuthProvider>,
		);

		await screen.findByTestId("protected-content");

		const logoutBtn = screen.getByTestId("app-logout-btn");
		await act(async () => {
			fireEvent.click(logoutBtn);
		});

		// Protected content hidden
		await waitFor(() => {
			expect(screen.queryByTestId("protected-content")).not.toBeInTheDocument();
		});

		// Normal unlock is NOT shown
		expect(
			screen.queryByTestId("unlock-passkey-button"),
		).not.toBeInTheDocument();

		// Safe error state rendered
		expect(screen.getByTestId("logout-failed-screen")).toBeInTheDocument();
		expect(screen.getByTestId("retry-logout-button")).toBeInTheDocument();
	});

	it("retries failed logout and transitions to AUTH_REQUIRED when retry succeeds", async () => {
		let attempt = 0;
		const fetchMock = vi.fn().mockImplementation((url: string) => {
			if (url === "/auth/logout") {
				attempt += 1;
				if (attempt === 1) {
					return Promise.resolve(
						new Response(
							JSON.stringify({
								error: {
									code: "SESSION_REVOCATION_FAILED",
									message: "Server busy",
								},
							}),
							{
								status: 503,
								headers: { "Content-Type": "application/json" },
							},
						),
					);
				}
				return Promise.resolve(
					new Response(null, {
						status: 204,
					}),
				);
			}
			return Promise.reject(new Error(`Unhandled route ${url}`));
		});
		vi.stubGlobal("fetch", fetchMock);

		render(
			<AuthProvider
				initialAuthState={{
					status: "UNLOCKED",
					user: { displayName: "Eren" },
				}}
			>
				<AuthGate>
					<ProtectedAppWithLogout />
				</AuthGate>
			</AuthProvider>,
		);

		await screen.findByTestId("protected-content");

		// Attempt 1: fails
		const logoutBtn = screen.getByTestId("app-logout-btn");
		await act(async () => {
			fireEvent.click(logoutBtn);
		});

		const retryBtn = await screen.findByTestId("retry-logout-button");
		expect(retryBtn).toBeInTheDocument();

		// Attempt 2: retry succeeds
		await act(async () => {
			fireEvent.click(retryBtn);
		});

		// Successful retry transitions to AUTH_REQUIRED
		expect(
			await screen.findByTestId("unlock-passkey-button"),
		).toBeInTheDocument();
		expect(
			screen.queryByTestId("logout-failed-screen"),
		).not.toBeInTheDocument();
		expect(screen.queryByTestId("protected-content")).not.toBeInTheDocument();

		const logoutCalls = fetchMock.mock.calls.filter(
			(c) => c[0] === "/auth/logout",
		);
		expect(logoutCalls).toHaveLength(2);
	});
});
