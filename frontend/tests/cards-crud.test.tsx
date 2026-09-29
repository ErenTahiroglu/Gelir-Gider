import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as creditCardsApi from "../src/api/credit-cards-api";
import { CardArchiveModal } from "../src/components/cards/CardArchiveModal";
import { CardForm } from "../src/components/cards/CardForm";

vi.mock("../src/api/credit-cards-api");

function createWrapper() {
	const queryClient = new QueryClient({
		defaultOptions: {
			queries: { retry: false },
			mutations: { retry: false },
		},
	});
	return ({ children }: { children: React.ReactNode }) => (
		<QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
	);
}

describe("F5 Card CRUD — Creation, Edit OCC & Archive Conflict", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("creates a new credit card with stable idempotency and validation", async () => {
		const mockCreate = vi
			.spyOn(creditCardsApi, "createCreditCard")
			.mockResolvedValue({
				card: {
					cardId: "card-new",
					code: "BONUS",
					status: "ACTIVE",
					revisionNo: 1,
					displayName: "Garanti Bonus",
					issuer: "Garanti",
					statementDay: 15,
					dueDay: 25,
					creditLimit: "50000.00",
					lastFour: "1234",
					note: null,
					createdAt: "2026-03-29T10:00:00Z",
				},
			});

		const onSuccess = vi.fn();
		render(<CardForm mode="create" onSuccess={onSuccess} />, {
			wrapper: createWrapper(),
		});

		// Fill fields
		fireEvent.change(screen.getByLabelText(/Kart Kodu/i), {
			target: { value: "BONUS" },
		});
		fireEvent.change(screen.getByLabelText(/Kart Adı/i), {
			target: { value: "Garanti Bonus" },
		});
		fireEvent.change(screen.getByLabelText(/Banka \/ Kuruluş/i), {
			target: { value: "Garanti" },
		});
		fireEvent.change(screen.getByLabelText(/Kredi Limiti/i), {
			target: { value: "50000.00" },
		});
		fireEvent.change(screen.getByLabelText(/Hesap Kesim Günü/i), {
			target: { value: "15" },
		});
		fireEvent.change(screen.getByLabelText(/Son Ödeme Günü/i), {
			target: { value: "25" },
		});
		fireEvent.change(screen.getByLabelText(/Son 4 Hane/i), {
			target: { value: "1234" },
		});

		fireEvent.click(screen.getByRole("button", { name: /Kartı Oluştur/i }));

		await waitFor(() => {
			expect(mockCreate).toHaveBeenCalledTimes(1);
		});

		const [payload, idempotencyKey] = mockCreate.mock.calls[0]!;
		expect(payload.code).toBe("BONUS");
		expect(payload.displayName).toBe("Garanti Bonus");
		expect(payload.issuer).toBe("Garanti");
		expect(payload.creditLimit).toBe("50000.00");
		expect(payload.statementDay).toBe(15);
		expect(payload.dueDay).toBe(25);
		expect(payload.lastFour).toBe("1234");
		expect(idempotencyKey).toBeDefined();
		expect(typeof idempotencyKey).toBe("string");
	});

	it("handles OCC revision conflict during card update without auto-overwriting", async () => {
		const existingCard: creditCardsApi.CreditCardItem = {
			cardId: "card-1",
			code: "BONUS",
			status: "ACTIVE",
			revisionNo: 1,
			displayName: "Garanti Bonus",
			issuer: "Garanti",
			statementDay: 15,
			dueDay: 25,
			creditLimit: "50000.00",
			lastFour: "1234",
			note: null,
			createdAt: "2026-03-29T10:00:00Z",
		};

		vi.spyOn(creditCardsApi, "updateCreditCard").mockRejectedValue({
			status: 409,
			code: "CREDIT_CARD_REVISION_CONFLICT",
			message: "Revision conflict",
		});

		render(<CardForm mode="edit" card={existingCard} />, {
			wrapper: createWrapper(),
		});

		fireEvent.change(screen.getByLabelText(/Kart Adı/i), {
			target: { value: "Garanti Bonus Platinum" },
		});
		fireEvent.click(
			screen.getByRole("button", { name: /Değişiklikleri Kaydet/i }),
		);

		await waitFor(() => {
			expect(
				screen.getByText(/Kart bilgileri başka bir işlemle güncellenmiş/i),
			).toBeInTheDocument();
		});
	});

	it("shows natural copy when card cannot be archived due to liability conflict", async () => {
		const existingCard: creditCardsApi.CreditCardItem = {
			cardId: "card-1",
			code: "BONUS",
			status: "ACTIVE",
			revisionNo: 2,
			displayName: "Garanti Bonus",
			issuer: "Garanti",
			statementDay: 15,
			dueDay: 25,
			creditLimit: "50000.00",
			lastFour: "1234",
			note: null,
			createdAt: "2026-03-29T10:00:00Z",
			liveLiabilityBalance: "2500.00",
		};

		vi.spyOn(creditCardsApi, "archiveCreditCard").mockRejectedValue({
			status: 409,
			code: "CREDIT_CARD_CANNOT_ARCHIVE_WITH_LIABILITY",
			message: "Cannot archive card with liability",
		});

		render(
			<CardArchiveModal
				card={existingCard}
				isOpen={true}
				onClose={vi.fn()}
				onSuccess={vi.fn()}
			/>,
			{ wrapper: createWrapper() },
		);

		fireEvent.click(screen.getByRole("button", { name: /Kartı Arşivle/i }));

		await waitFor(() => {
			expect(
				screen.getByText(
					/Bu kartın açık yükümlülüğü bulunduğu için arşivlenemiyor/i,
				),
			).toBeInTheDocument();
		});
	});
});
