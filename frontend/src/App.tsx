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

function AuthenticatedHome() {
	const { state, logout } = useAuth();
	const displayName = state.status === "UNLOCKED" ? state.user.displayName : "";

	return (
		<main className="app-shell" data-testid="authenticated-home">
			<header className="f0-header">
				<h1 className="f0-title">Gelir-Gider</h1>
				<p className="f0-subtitle">Oturum açık.</p>
				{displayName && (
					<p
						className="user-welcome"
						style={{ marginTop: "0.5rem" }}
						data-testid="user-display-name"
					>
						Hoş geldiniz, <strong>{displayName}</strong>
					</p>
				)}
				<div style={{ marginTop: "1.5rem" }}>
					<button
						type="button"
						className="btn btn-secondary"
						onClick={() => void logout()}
						data-testid="logout-button"
					>
						Çıkış Yap
					</button>
				</div>
			</header>
		</main>
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
		return <AuthenticatedHome />;
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
	component: AuthenticatedHome,
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
			<RouterProvider router={router} />
		</AuthProvider>
	);
}

export default App;
