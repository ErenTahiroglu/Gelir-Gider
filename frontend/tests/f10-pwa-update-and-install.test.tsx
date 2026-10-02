import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PwaInstallButton } from "../src/components/pwa/PwaInstallButton";
import { PwaUpdatePrompt } from "../src/components/pwa/PwaUpdatePrompt";
import { usePwa } from "../src/lib/pwa/usePwa";

function HookTester({
	onHook,
}: {
	onHook: (state: ReturnType<typeof usePwa>) => void;
}) {
	const pwa = usePwa();
	onHook(pwa);
	return null;
}

describe("PWA Update Prompt & Install Affordance (F10)", () => {
	it("PwaUpdatePrompt is null when needRefresh is false", () => {
		const { container } = render(
			<PwaUpdatePrompt
				needRefresh={false}
				onUpdate={vi.fn()}
				onDismiss={vi.fn()}
			/>,
		);
		expect(container.firstChild).toBeNull();
	});

	it("PwaUpdatePrompt displays non-blocking update banner with Turkish copy and safe user-triggered action", () => {
		const handleUpdate = vi.fn();
		const handleDismiss = vi.fn();

		render(
			<PwaUpdatePrompt
				needRefresh={true}
				onUpdate={handleUpdate}
				onDismiss={handleDismiss}
			/>,
		);

		const banner = screen.getByTestId("pwa-update-prompt");
		expect(banner).toBeInTheDocument();
		expect(banner).toHaveAttribute("role", "status");
		expect(banner).toHaveAttribute("aria-live", "polite");
		expect(screen.getByText("Yeni sürüm hazır.")).toBeInTheDocument();

		const refreshBtn = screen.getByTestId("pwa-update-refresh-btn");
		expect(refreshBtn).toHaveTextContent("Şimdi Yenile");
		fireEvent.click(refreshBtn);
		expect(handleUpdate).toHaveBeenCalledTimes(1);

		const dismissBtn = screen.getByTestId("pwa-update-dismiss-btn");
		expect(dismissBtn).toHaveTextContent("Sonra");
		fireEvent.click(dismissBtn);
		expect(handleDismiss).toHaveBeenCalledTimes(1);
	});

	it("PwaInstallButton renders nothing when canInstall is false", () => {
		const { container } = render(
			<PwaInstallButton canInstall={false} onInstall={vi.fn()} />,
		);
		expect(container.firstChild).toBeNull();
	});

	it("PwaInstallButton renders accessible button and triggers callback on explicit user click", () => {
		const handleInstall = vi.fn();
		render(<PwaInstallButton canInstall={true} onInstall={handleInstall} />);

		const btn = screen.getByTestId("pwa-install-button");
		expect(btn).toBeInTheDocument();
		expect(btn).toHaveTextContent("Uygulamayı Yükle");

		fireEvent.click(btn);
		expect(handleInstall).toHaveBeenCalledTimes(1);
	});

	it("usePwa responds to beforeinstallprompt event without auto-prompting", async () => {
		let currentPwa!: ReturnType<typeof usePwa>;

		render(
			<HookTester
				onHook={(state) => {
					currentPwa = state;
				}}
			/>,
		);

		expect(currentPwa.canInstall).toBe(false);

		const promptMock = vi.fn().mockResolvedValue(undefined);
		const userChoicePromise = Promise.resolve({
			outcome: "accepted" as const,
			platform: "web",
		});
		const mockEvent = new Event("beforeinstallprompt") as any;
		mockEvent.preventDefault = vi.fn();
		mockEvent.prompt = promptMock;
		mockEvent.userChoice = userChoicePromise;

		await act(async () => {
			window.dispatchEvent(mockEvent);
		});

		expect(mockEvent.preventDefault).toHaveBeenCalled();
		expect(promptMock).not.toHaveBeenCalled(); // No auto-prompting!
		expect(currentPwa.canInstall).toBe(true);

		// Trigger prompt via user action
		await act(async () => {
			await currentPwa.promptInstall();
		});

		expect(promptMock).toHaveBeenCalledTimes(1);
	});

	it("retires deferred prompt on userChoice = dismissed without nagging again, allowing fresh event to re-enable", async () => {
		let currentPwa!: ReturnType<typeof usePwa>;

		render(
			<HookTester
				onHook={(state) => {
					currentPwa = state;
				}}
			/>,
		);

		// 1. Initial state: cannot install
		expect(currentPwa.canInstall).toBe(false);

		// Create first install prompt event
		const promptMock1 = vi.fn().mockResolvedValue(undefined);
		const dismissedChoicePromise = Promise.resolve({
			outcome: "dismissed" as const,
			platform: "web",
		});
		// biome-ignore lint/suspicious/noExplicitAny: DOM mock
		const mockEvent1 = new Event("beforeinstallprompt") as any;
		mockEvent1.preventDefault = vi.fn();
		mockEvent1.prompt = promptMock1;
		mockEvent1.userChoice = dismissedChoicePromise;

		// 1. beforeinstallprompt enables CTA
		await act(async () => {
			window.dispatchEvent(mockEvent1);
		});
		expect(mockEvent1.preventDefault).toHaveBeenCalled();
		expect(promptMock1).not.toHaveBeenCalled();
		expect(currentPwa.canInstall).toBe(true);

		// 2. Explicit user action calls prompt() once
		// 3. userChoice = dismissed
		await act(async () => {
			await currentPwa.promptInstall();
		});
		expect(promptMock1).toHaveBeenCalledTimes(1);

		// 4. Current CTA becomes unavailable
		expect(currentPwa.canInstall).toBe(false);

		// 5. Invoking the old action cannot prompt the consumed event again
		await act(async () => {
			await currentPwa.promptInstall();
		});
		expect(promptMock1).toHaveBeenCalledTimes(1); // Still 1, never called again!
		expect(currentPwa.canInstall).toBe(false);

		// 6. A genuinely new beforeinstallprompt may enable a fresh CTA
		const promptMock2 = vi.fn().mockResolvedValue(undefined);
		// biome-ignore lint/suspicious/noExplicitAny: DOM mock
		const mockEvent2 = new Event("beforeinstallprompt") as any;
		mockEvent2.preventDefault = vi.fn();
		mockEvent2.prompt = promptMock2;
		mockEvent2.userChoice = Promise.resolve({
			outcome: "accepted" as const,
			platform: "web",
		});

		await act(async () => {
			window.dispatchEvent(mockEvent2);
		});
		expect(currentPwa.canInstall).toBe(true);

		await act(async () => {
			await currentPwa.promptInstall();
		});
		expect(promptMock2).toHaveBeenCalledTimes(1);
		expect(currentPwa.canInstall).toBe(false);
	});
});
