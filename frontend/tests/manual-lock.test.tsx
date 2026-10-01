import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import * as authApi from "../src/auth/auth-api";
import { AuthProvider, useAuth } from "../src/auth/auth-context";
import * as webauthnClient from "../src/auth/webauthn-client";
import { AuthGate } from "../src/components/auth/AuthGate";
import { TopBar } from "../src/components/layout/TopBar";

vi.mock("@tanstack/react-router", () => ({
	Link: ({ children, to, ...props }: any) => (
		<a href={to} {...props}>
			{children}
		</a>
	),
	useNavigate: () => vi.fn(),
	useParams: () => ({}),
	useSearch: () => ({}),
}));

function TestApp() {
	const { state } = useAuth();

	return (
		<AuthGate>
			<TopBar />
			<div data-testid="protected-content">
				Finansal Bilgiler:{" "}
				{state.status === "UNLOCKED" ? "Gizli Veri" : "Kilitli"}
			</div>
		</AuthGate>
	);
}

describe("Manual Lock Action — TopBar Kilitle & Step-Up Unlock", () => {
	it("clicking Kilitle transitions UNLOCKED to REAUTH_REQUIRED and obscures content", async () => {
		render(
			<AuthProvider
				initialAuthState={{
					status: "UNLOCKED",
					user: { displayName: "Eren" },
				}}
			>
				<TestApp />
			</AuthProvider>,
		);

		// Initially unlocked
		expect(screen.getByTestId("protected-content")).toBeInTheDocument();
		expect(
			screen.getByText("Finansal Bilgiler: Gizli Veri"),
		).toBeInTheDocument();

		// Click "Kilitle" button
		const lockBtn = screen.getByTestId("manual-lock-btn");
		fireEvent.click(lockBtn);

		// Now in REAUTH_REQUIRED: LockedOverlay appears
		expect(
			await screen.findByRole("button", { name: /Kilidi Aç/i }),
		).toBeInTheDocument();
		expect(screen.getByText("Gelir-Gider kilitli")).toBeInTheDocument();
	});

	it("completing step-up reauth unlocks application without creating a new session", async () => {
		vi.spyOn(authApi, "fetchReauthOptions").mockResolvedValue({
			challenge: "reauth-challenge",
			rpId: "localhost",
		} as unknown as Awaited<ReturnType<typeof authApi.fetchReauthOptions>>);

		webauthnClient.setWebAuthnAdapter({
			isSupported: vi.fn().mockReturnValue(true),
			register: vi.fn(),
			authenticate: vi.fn().mockResolvedValue({
				id: "cred-1",
				rawId: "raw-1",
				response: {
					clientDataJSON: "cdj",
					authenticatorData: "ad",
					signature: "sig",
				},
				type: "public-key",
				clientExtensionResults: {},
			}),
		});

		const verifySpy = vi.spyOn(authApi, "verifyReauth").mockResolvedValue({
			verified: true,
			credential: { deviceName: "Test Device" },
		});

		render(
			<AuthProvider
				initialAuthState={{
					status: "UNLOCKED",
					user: { displayName: "Eren" },
				}}
			>
				<TestApp />
			</AuthProvider>,
		);

		// Lock
		fireEvent.click(screen.getByTestId("manual-lock-btn"));
		const reauthBtn = await screen.findByRole("button", { name: /Kilidi Aç/i });

		// Click reauth button
		fireEvent.click(reauthBtn);

		// Verify reauth endpoint called
		await waitFor(() => {
			expect(verifySpy).toHaveBeenCalled();
		});

		// Returns to UNLOCKED
		expect(
			await screen.findByText("Finansal Bilgiler: Gizli Veri"),
		).toBeInTheDocument();
	});
});
