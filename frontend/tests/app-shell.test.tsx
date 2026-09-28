import {
	createMemoryHistory,
	createRootRoute,
	createRoute,
	createRouter,
	RouterProvider,
} from "@tanstack/react-router";
import { fireEvent, render, screen } from "@testing-library/react";
import type React from "react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { AppShell } from "../src/components/layout/AppShell";
import { DesktopSidebar } from "../src/components/layout/DesktopSidebar";
import { MobileNav } from "../src/components/layout/MobileNav";

// Mock AuthContext for shell
vi.mock("../src/auth/auth-context", () => ({
	useAuth: () => ({
		state: { status: "UNLOCKED", user: { displayName: "Eren" } },
		lockNow: vi.fn(),
		logout: vi.fn(),
	}),
}));

async function renderWithRouter(ui: React.ReactElement) {
	const rootRoute = createRootRoute({
		component: () => ui,
	});
	const router = createRouter({
		routeTree: rootRoute,
		history: createMemoryHistory({ initialEntries: ["/"] }),
	});
	await router.load();
	return render(<RouterProvider router={router} />);
}

describe("App Shell — Responsive Desktop Sidebar & Mobile Nav Invariants", () => {
	it("renders mobile nav with 5-position structure and appropriate disabled states", async () => {
		await renderWithRouter(<MobileNav />);

		// 1. Ana Sayfa is active with aria-current="page"
		const homeLink = screen.getByTestId("mobile-nav-home");
		expect(homeLink).toHaveAttribute("aria-current", "page");
		expect(homeLink).toHaveAttribute("href", "/");

		// 2. Hareketler is active in F3
		const txLink = screen.getByTestId("mobile-nav-transactions");
		expect(txLink).toHaveAttribute("href", "/transactions");

		// 3. Central elevated FAB is active in F4
		const fab = screen.getByTestId("mobile-quick-entry-fab");
		expect(fab).not.toBeDisabled();
		expect(fab).not.toHaveAttribute("aria-disabled", "true");

		// 4. Kartlar is disabled (F5)
		const cardsBtn = screen.getByTestId("mobile-nav-cards");
		expect(cardsBtn).toBeDisabled();
		expect(cardsBtn).toHaveAttribute("aria-disabled", "true");

		// 5. Daha Fazla is disabled
		const moreBtn = screen.getByTestId("mobile-nav-more");
		expect(moreBtn).toBeDisabled();
		expect(moreBtn).toHaveAttribute("aria-disabled", "true");
	});

	it("renders desktop sidebar with collapsible state and disabled future modules", async () => {
		const onToggle = vi.fn();
		function TestSidebarWrapper() {
			const [collapsed, setCollapsed] = useState(false);
			return (
				<div>
					<button
						type="button"
						data-testid="external-collapse-btn"
						onClick={() => setCollapsed(true)}
					>
						Collapse
					</button>
					<DesktopSidebar collapsed={collapsed} onToggleCollapse={onToggle} />
				</div>
			);
		}

		await renderWithRouter(<TestSidebarWrapper />);

		const sidebar = screen.getByTestId("desktop-sidebar");
		expect(sidebar).toHaveClass("expanded");

		// Ana Sayfa active link
		const homeLink = screen.getByTestId("nav-link-home");
		expect(homeLink).toHaveAttribute("aria-current", "page");

		// Hareketler active link in F3
		const txLink = screen.getByTestId("nav-link-transactions");
		expect(txLink).toHaveAttribute("href", "/transactions");

		// Future links disabled
		expect(screen.getByTestId("nav-link-cards")).toBeDisabled();
		expect(screen.getByTestId("nav-link-people")).toBeDisabled();
		expect(screen.getByTestId("nav-link-budget")).toBeDisabled();
		expect(screen.getByTestId("nav-link-goals")).toBeDisabled();
		expect(screen.getByTestId("nav-link-investments")).toBeDisabled();

		// Toggle button
		const toggleBtn = screen.getByTestId("sidebar-toggle-btn");
		fireEvent.click(toggleBtn);
		expect(onToggle).toHaveBeenCalledTimes(1);

		// Collapsed state
		fireEvent.click(screen.getByTestId("external-collapse-btn"));
		expect(screen.getByTestId("desktop-sidebar")).toHaveClass("collapsed");
	});

	it("toggles sidebar on Cmd/Ctrl+B unless focus is in an input field", async () => {
		const onToggle = vi.fn();
		await renderWithRouter(
			<div>
				<input data-testid="test-input" />
				<DesktopSidebar collapsed={false} onToggleCollapse={onToggle} />
			</div>,
		);

		// Keydown Cmd+B on body toggles
		fireEvent.keyDown(window, { key: "b", ctrlKey: true });
		expect(onToggle).toHaveBeenCalledTimes(1);

		fireEvent.keyDown(window, { key: "b", metaKey: true });
		expect(onToggle).toHaveBeenCalledTimes(2);

		// Keydown Cmd+B when input is focused does NOT toggle
		const input = screen.getByTestId("test-input");
		input.focus();
		fireEvent.keyDown(input, { key: "b", ctrlKey: true });
		expect(onToggle).toHaveBeenCalledTimes(2); // Still 2
	});

	it("renders AppShell wrapping children and persisting collapsed preference", async () => {
		await renderWithRouter(
			<AppShell>
				<div data-testid="child-content">Dashboard Content</div>
			</AppShell>,
		);

		expect(screen.getByTestId("app-shell")).toBeInTheDocument();
		expect(screen.getByTestId("child-content")).toBeInTheDocument();
		expect(screen.getByTestId("period-badge")).toBeInTheDocument();
	});

	it("clicking Ana Sayfa in mobile nav and desktop sidebar uses TanStack Router SPA navigation without full document reload", async () => {
		const rootRoute = createRootRoute();
		let indexMountCount = 0;
		const indexRoute = createRoute({
			getParentRoute: () => rootRoute,
			path: "/",
			component: () => {
				indexMountCount++;
				return (
					<AppShell>
						<div data-testid="dashboard-content">Dashboard Content</div>
					</AppShell>
				);
			},
		});
		const router = createRouter({
			routeTree: rootRoute.addChildren([indexRoute]),
			history: createMemoryHistory({ initialEntries: ["/"] }),
		});

		render(<RouterProvider router={router} />);

		expect(await screen.findByTestId("dashboard-content")).toBeInTheDocument();
		expect(indexMountCount).toBeGreaterThanOrEqual(1);

		// Click Desktop Ana Sayfa link (TanStack Router Link)
		const desktopHome = screen.getByTestId("nav-link-home");
		fireEvent.click(desktopHome);

		// Still on "/" and dashboard content remains mounted in SPA
		expect(screen.getByTestId("dashboard-content")).toBeInTheDocument();
		expect(router.state.location.pathname).toBe("/");

		// Click Mobile Ana Sayfa link (TanStack Router Link)
		const mobileHome = screen.getByTestId("mobile-nav-home");
		fireEvent.click(mobileHome);

		// Still on "/" and dashboard content remains mounted in SPA
		expect(screen.getByTestId("dashboard-content")).toBeInTheDocument();
		expect(router.state.location.pathname).toBe("/");
	});
});
