import { QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import * as dashboardApi from "../src/api/dashboard-api";
import { AuthProvider, useAuth } from "../src/auth/auth-context";
import { DashboardPage } from "../src/components/dashboard/DashboardPage";
import { QuerySecurityBoundary } from "../src/query/QuerySecurityBoundary";
import { createApplicationQueryClient } from "../src/query/query-client";

function SecurityProbe() {
	const queryClient = useQueryClient();
	const { state } = useAuth();

	return (
		<div>
			<span data-testid="cache-count">
				{queryClient.getQueryCache().getAll().length}
			</span>
			<span data-testid="auth-status">{state.status}</span>
		</div>
	);
}

describe("Query Security Boundary — Cache Invalidation & Execution Control", () => {
	it("does not execute financial queries when state is not UNLOCKED", () => {
		const checkpointsSpy = vi.spyOn(dashboardApi, "fetchBudgetCheckpoints");
		const spendingSpy = vi.spyOn(dashboardApi, "fetchSpendingSummary");
		const cardsSpy = vi.spyOn(dashboardApi, "fetchActiveCreditCards");

		const testClient = createApplicationQueryClient();

		render(
			<AuthProvider initialAuthState={{ status: "AUTH_REQUIRED" }}>
				<QueryClientProvider client={testClient}>
					<QuerySecurityBoundary>
						<DashboardPage />
					</QuerySecurityBoundary>
				</QueryClientProvider>
			</AuthProvider>,
		);

		// Queries have enabled: isUnlocked (false when AUTH_REQUIRED)
		expect(checkpointsSpy).not.toHaveBeenCalled();
		expect(spendingSpy).not.toHaveBeenCalled();
		expect(cardsSpy).not.toHaveBeenCalled();
	});

	it("clears query cache when transitioning to session-ending state (AUTH_REQUIRED / LOGOUT_FAILED_LOCKED)", () => {
		const testClient = createApplicationQueryClient();

		// Populate cache with sensitive financial query data
		testClient.setQueryData(["spending-summary", "2026-09"], {
			totalPersonalSpending: "15000.00",
		});
		testClient.setQueryData(["active-credit-cards"], {
			cards: [{ cardId: "card-1", liveLiabilityBalance: "5000.00" }],
		});

		expect(testClient.getQueryCache().getAll().length).toBe(2);

		// Render with AUTH_REQUIRED state
		render(
			<AuthProvider initialAuthState={{ status: "AUTH_REQUIRED" }}>
				<QueryClientProvider client={testClient}>
					<QuerySecurityBoundary>
						<SecurityProbe />
					</QuerySecurityBoundary>
				</QueryClientProvider>
			</AuthProvider>,
		);

		// QuerySecurityBoundary should have called queryClient.clear()
		expect(testClient.getQueryCache().getAll().length).toBe(0);
	});

	it("cancels active queries when entering REAUTH_REQUIRED without destroying in-memory cache", () => {
		const testClient = createApplicationQueryClient();
		const cancelSpy = vi.spyOn(testClient, "cancelQueries");

		testClient.setQueryData(["spending-summary", "2026-09"], {
			totalPersonalSpending: "15000.00",
		});

		render(
			<AuthProvider
				initialAuthState={{
					status: "REAUTH_REQUIRED",
					user: { displayName: "Eren" },
				}}
			>
				<QueryClientProvider client={testClient}>
					<QuerySecurityBoundary>
						<SecurityProbe />
					</QuerySecurityBoundary>
				</QueryClientProvider>
			</AuthProvider>,
		);

		// Cancel was called
		expect(cancelSpy).toHaveBeenCalled();
		// Same-session cache remains in memory
		expect(testClient.getQueryCache().getAll().length).toBe(1);
	});
});
