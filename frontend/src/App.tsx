import { QueryClientProvider } from "@tanstack/react-query";
import {
	createRootRoute,
	createRoute,
	createRouter,
	Outlet,
	RouterProvider,
	useNavigate,
} from "@tanstack/react-router";
import { useEffect } from "react";
import { AuthProvider, useAuth } from "./auth/auth-context";
import { AuthGate } from "./components/auth/AuthGate";
import { UnlockScreen } from "./components/auth/UnlockScreen";
import { DashboardPage } from "./components/dashboard/DashboardPage";
import { AppShell } from "./components/layout/AppShell";
import { ManualExpenseForm } from "./components/manual-expenses/ManualExpenseForm";
import { TemplateManagement } from "./components/quick-entry/TemplateManagement";
import { TransactionTimeline } from "./components/transactions/TransactionTimeline";
import { QuerySecurityBoundary } from "./query/QuerySecurityBoundary";
import { queryClient } from "./query/query-client";

function AuthenticatedDashboard() {
	return (
		<AppShell>
			<DashboardPage />
		</AppShell>
	);
}

function AuthenticatedTransactions() {
	return (
		<AppShell>
			<TransactionTimeline />
		</AppShell>
	);
}

function AuthenticatedTransactionDetail() {
	const params = transactionsDetailRoute.useParams();
	return (
		<AppShell>
			<TransactionTimeline initialTransactionId={params.transactionId} />
		</AppShell>
	);
}

function AuthenticatedManualExpenseNew() {
	return (
		<AppShell>
			<div className="form-page-container">
				<div className="form-page-card card">
					<h1 className="page-title">Yeni Nakit / Banka Harcaması</h1>
					<ManualExpenseForm mode="create" />
				</div>
			</div>
		</AppShell>
	);
}

function AuthenticatedManualExpenseEdit() {
	const params = manualExpenseEditRoute.useParams();
	return (
		<AppShell>
			<div className="form-page-container">
				<div className="form-page-card card">
					<h1 className="page-title">Harcamayı Düzenle</h1>
					<ManualExpenseForm mode="edit" expenseId={params.expenseId} />
				</div>
			</div>
		</AppShell>
	);
}

function UnlockRouteComponent() {
	const { state } = useAuth();
	const navigate = useNavigate();

	useEffect(() => {
		if (state.status === "UNLOCKED") {
			void navigate({ to: "/" });
		}
	}, [state.status, navigate]);

	if (state.status === "UNLOCKED") {
		return <AuthenticatedDashboard />;
	}

	return <UnlockScreen />;
}

const rootRoute = createRootRoute({
	component: () => (
		<AuthGate>
			<Outlet />
		</AuthGate>
	),
});

const indexRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/",
	component: AuthenticatedDashboard,
});

const unlockRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/unlock",
	component: UnlockRouteComponent,
});

const transactionsRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/transactions",
	component: AuthenticatedTransactions,
});

const transactionsDetailRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/transactions/$transactionId",
	component: AuthenticatedTransactionDetail,
});

const manualExpenseNewRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/manual-expenses/new",
	component: AuthenticatedManualExpenseNew,
});

const manualExpenseEditRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/manual-expenses/$expenseId/edit",
	component: AuthenticatedManualExpenseEdit,
});

function AuthenticatedTemplateManagement() {
	return (
		<AppShell>
			<TemplateManagement />
		</AppShell>
	);
}

const templateManagementRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/settings/quick-templates",
	component: AuthenticatedTemplateManagement,
});

const routeTree = rootRoute.addChildren([
	indexRoute,
	unlockRoute,
	transactionsRoute,
	transactionsDetailRoute,
	manualExpenseNewRoute,
	manualExpenseEditRoute,
	templateManagementRoute,
]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
	interface Register {
		router: typeof router;
	}
}

export function App() {
	return (
		<AuthProvider>
			<QueryClientProvider client={queryClient}>
				<QuerySecurityBoundary>
					<RouterProvider router={router} />
				</QuerySecurityBoundary>
			</QueryClientProvider>
		</AuthProvider>
	);
}

export default App;
