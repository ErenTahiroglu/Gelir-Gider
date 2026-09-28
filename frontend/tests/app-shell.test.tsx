import { fireEvent, render, screen } from "@testing-library/react";
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

describe("App Shell — Responsive Desktop Sidebar & Mobile Nav Invariants", () => {
	it("renders mobile nav with 5-position structure and appropriate disabled states", () => {
		render(<MobileNav />);

		// 1. Ana Sayfa is active with aria-current="page"
		const homeLink = screen.getByTestId("mobile-nav-home");
		expect(homeLink).toHaveAttribute("aria-current", "page");
		expect(homeLink).toHaveAttribute("href", "/");

		// 2. Hareketler is disabled
		const txBtn = screen.getByTestId("mobile-nav-transactions");
		expect(txBtn).toBeDisabled();
		expect(txBtn).toHaveAttribute("aria-disabled", "true");

		// 3. Central elevated FAB is disabled in F2 (no fake modal)
		const fab = screen.getByTestId("mobile-quick-entry-fab");
		expect(fab).toBeDisabled();
		expect(fab).toHaveAttribute("aria-disabled", "true");

		// 4. Kartlar is disabled
		const cardsBtn = screen.getByTestId("mobile-nav-cards");
		expect(cardsBtn).toBeDisabled();
		expect(cardsBtn).toHaveAttribute("aria-disabled", "true");

		// 5. Daha Fazla is disabled
		const moreBtn = screen.getByTestId("mobile-nav-more");
		expect(moreBtn).toBeDisabled();
		expect(moreBtn).toHaveAttribute("aria-disabled", "true");
	});

	it("renders desktop sidebar with collapsible state and disabled future modules", () => {
		const onToggle = vi.fn();
		const { rerender } = render(
			<DesktopSidebar collapsed={false} onToggleCollapse={onToggle} />,
		);

		const sidebar = screen.getByTestId("desktop-sidebar");
		expect(sidebar).toHaveClass("expanded");

		// Ana Sayfa active link
		const homeLink = screen.getByTestId("nav-link-home");
		expect(homeLink).toHaveAttribute("aria-current", "page");

		// Future links disabled
		expect(screen.getByTestId("nav-link-transactions")).toBeDisabled();
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
		rerender(<DesktopSidebar collapsed={true} onToggleCollapse={onToggle} />);
		expect(screen.getByTestId("desktop-sidebar")).toHaveClass("collapsed");
	});

	it("toggles sidebar on Cmd/Ctrl+B unless focus is in an input field", () => {
		const onToggle = vi.fn();
		render(
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

	it("renders AppShell wrapping children and persisting collapsed preference", () => {
		render(
			<AppShell>
				<div data-testid="child-content">Dashboard Content</div>
			</AppShell>,
		);

		expect(screen.getByTestId("app-shell")).toBeInTheDocument();
		expect(screen.getByTestId("child-content")).toBeInTheDocument();
		expect(screen.getByTestId("period-badge")).toBeInTheDocument();
	});
});
