import {
	createMemoryHistory,
	createRootRoute,
	createRoute,
	createRouter,
	RouterProvider,
} from "@tanstack/react-router";
import { fireEvent, render, screen } from "@testing-library/react";
import type React from "react";
import { describe, expect, it, vi } from "vitest";
import { DesktopSidebar } from "../src/components/layout/DesktopSidebar";
import { MobileNav } from "../src/components/layout/MobileNav";

vi.mock("../src/auth/auth-context", () => ({
	useAuth: () => ({
		state: { status: "UNLOCKED", user: { displayName: "Eren" } },
		lockNow: vi.fn(),
		logout: vi.fn(),
	}),
}));

async function renderNavigationAt(initialPath: string) {
	const rootRoute = createRootRoute({
		component: () => (
			<div>
				<DesktopSidebar collapsed={false} onToggleCollapse={vi.fn()} />
				<MobileNav />
			</div>
		),
	});

	const indexRoute = createRoute({
		getParentRoute: () => rootRoute,
		path: "/",
		component: () => <div>Home</div>,
	});

	const cardsRoute = createRoute({
		getParentRoute: () => rootRoute,
		path: "/cards",
		component: () => <div>Cards List</div>,
	});

	const cardDetailRoute = createRoute({
		getParentRoute: () => rootRoute,
		path: "/cards/$cardId",
		component: () => <div>Card Detail</div>,
	});

	const router = createRouter({
		routeTree: rootRoute.addChildren([indexRoute, cardsRoute, cardDetailRoute]),
		history: createMemoryHistory({ initialEntries: [initialPath] }),
	});

	await router.load();
	return render(<RouterProvider router={router} />);
}

describe("F5 Navigation — Mobile Nav & Desktop Sidebar Active State", () => {
	it("activates Kartlar in mobile nav and Kredi Kartları in desktop sidebar on /cards", async () => {
		await renderNavigationAt("/cards");

		// Mobile Nav
		const mobileCards = screen.getByTestId("mobile-nav-cards");
		expect(mobileCards).toHaveAttribute("aria-current", "page");
		expect(mobileCards).toHaveClass("active");

		const mobileHome = screen.getByTestId("mobile-nav-home");
		expect(mobileHome).not.toHaveAttribute("aria-current", "page");
		expect(mobileHome).not.toHaveClass("active");

		const mobileTx = screen.getByTestId("mobile-nav-transactions");
		expect(mobileTx).not.toHaveAttribute("aria-current", "page");

		// Quick Entry FAB remains enabled and clickable
		const fab = screen.getByTestId("mobile-quick-entry-fab");
		expect(fab).not.toBeDisabled();

		// Desktop Sidebar
		const desktopCards = screen.getByTestId("nav-link-cards");
		expect(desktopCards).toHaveAttribute("aria-current", "page");
		expect(desktopCards).toHaveClass("active");

		const desktopHome = screen.getByTestId("nav-link-home");
		expect(desktopHome).not.toHaveAttribute("aria-current", "page");
	});

	it("activates Kartlar and Kredi Kartları on sub-routes like /cards/$cardId", async () => {
		await renderNavigationAt("/cards/card-123");

		const mobileCards = screen.getByTestId("mobile-nav-cards");
		expect(mobileCards).toHaveAttribute("aria-current", "page");
		expect(mobileCards).toHaveClass("active");

		const desktopCards = screen.getByTestId("nav-link-cards");
		expect(desktopCards).toHaveAttribute("aria-current", "page");
		expect(desktopCards).toHaveClass("active");
	});
});
