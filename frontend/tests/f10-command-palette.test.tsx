import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CommandPalette } from "../src/components/command-palette/CommandPalette";
import { CommandPaletteHost } from "../src/components/command-palette/CommandPaletteHost";

const mockNavigate = vi.fn();
const mockOpenQuickEntry = vi.fn();
const mockLockNow = vi.fn();

vi.mock("@tanstack/react-router", () => ({
	useNavigate: () => mockNavigate,
	Link: ({ children, to }: any) => <a href={to}>{children}</a>,
}));

vi.mock("../src/auth/auth-context", () => ({
	useAuth: () => ({
		lockNow: mockLockNow,
	}),
}));

vi.mock("../src/context/QuickEntryContext", () => ({
	useQuickEntry: () => ({
		openQuickEntry: mockOpenQuickEntry,
	}),
}));

describe("Command Palette (F10)", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("renders dialog with accessible semantics and all minimal V1 commands", () => {
		render(<CommandPalette isOpen={true} onClose={vi.fn()} />);

		const dialog = screen.getByTestId("command-palette-dialog");
		expect(dialog).toHaveAttribute("role", "dialog");
		expect(dialog).toHaveAttribute("aria-modal", "true");
		expect(dialog).toHaveAttribute("aria-label", "Komut Paleti");

		const input = screen.getByTestId("command-palette-input");
		expect(input).toHaveAttribute("type", "search");
		expect(input).toHaveAttribute("aria-autocomplete", "list");

		// Check primary navigation and action commands
		expect(screen.getByTestId("command-item-home")).toHaveTextContent(
			"Ana Sayfa",
		);
		expect(screen.getByTestId("command-item-transactions")).toHaveTextContent(
			"Hareketler",
		);
		expect(screen.getByTestId("command-item-cards")).toHaveTextContent(
			"Kredi Kartları",
		);
		expect(screen.getByTestId("command-item-quick-entry")).toHaveTextContent(
			"Hızlı Kayıt",
		);
		expect(screen.getByTestId("command-item-lock-app")).toHaveTextContent(
			"Uygulamayı Kilitle",
		);
	});

	it("filters commands dynamically and shows empty state when nothing matches", () => {
		render(<CommandPalette isOpen={true} onClose={vi.fn()} />);
		const input = screen.getByTestId("command-palette-input");

		fireEvent.change(input, { target: { value: "Kredi" } });
		expect(screen.getByTestId("command-item-cards")).toBeInTheDocument();
		expect(screen.queryByTestId("command-item-home")).not.toBeInTheDocument();

		fireEvent.change(input, { target: { value: "olmayan-komut-xyz" } });
		expect(screen.getByTestId("command-palette-empty")).toHaveTextContent(
			"Eşleşen komut bulunamadı.",
		);
	});

	it("executes navigation command via SPA router without hard reload", () => {
		const handleClose = vi.fn();
		render(<CommandPalette isOpen={true} onClose={handleClose} />);

		const homeItem = screen.getByTestId("command-item-home");
		fireEvent.click(homeItem);

		expect(handleClose).toHaveBeenCalledTimes(1);
		expect(mockNavigate).toHaveBeenCalledWith({ to: "/" });
	});

	it("executes Quick Entry and Lock actions without hard reload", () => {
		const handleClose = vi.fn();
		render(<CommandPalette isOpen={true} onClose={handleClose} />);

		const quickEntryItem = screen.getByTestId("command-item-quick-entry");
		fireEvent.click(quickEntryItem);
		expect(mockOpenQuickEntry).toHaveBeenCalledTimes(1);

		const lockItem = screen.getByTestId("command-item-lock-app");
		fireEvent.click(lockItem);
		expect(mockLockNow).toHaveBeenCalledTimes(1);
	});

	it("handles keyboard navigation: Escape closes dialog", () => {
		const handleClose = vi.fn();
		render(<CommandPalette isOpen={true} onClose={handleClose} />);

		fireEvent.keyDown(window, { key: "Escape" });
		expect(handleClose).toHaveBeenCalledTimes(1);
	});

	it("CommandPaletteHost ignores Cmd/Ctrl+K when typing inside inputs or textareas", () => {
		render(
			<div>
				<input data-testid="test-input" type="text" />
				<CommandPaletteHost />
			</div>,
		);

		const input = screen.getByTestId("test-input");
		input.focus();

		// Dispatch Cmd+K on input
		const event = new KeyboardEvent("keydown", {
			key: "k",
			metaKey: true,
			bubbles: true,
			cancelable: true,
		});
		window.dispatchEvent(event);

		// Palette should not have opened because input was active
		expect(
			screen.queryByTestId("command-palette-dialog"),
		).not.toBeInTheDocument();
	});
});
