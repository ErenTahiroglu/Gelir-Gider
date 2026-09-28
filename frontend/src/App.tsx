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
import { QuerySecurityBoundary } from "./query/QuerySecurityBoundary";
import { queryClient } from "./query/query-client";

function AuthenticatedDashboard() {
	return (
		<AppShell>
			<DashboardPage />
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

const routeTree = rootRoute.addChildren([indexRoute, unlockRoute]);

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
