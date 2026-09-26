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
			<AuthProvider>
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
});
