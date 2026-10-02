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
});
