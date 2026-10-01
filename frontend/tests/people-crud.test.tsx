import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	createMemoryHistory,
	createRootRoute,
	createRouter,
	RouterProvider,
} from "@tanstack/react-router";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../src/api/errors";
import * as peopleApi from "../src/api/people-api";
import type { PersonProductDto } from "../src/api/people-types";
import { PeoplePage } from "../src/components/people/PeoplePage";
import { PersonArchiveModal } from "../src/components/people/PersonArchiveModal";
import { PersonForm } from "../src/components/people/PersonForm";

vi.mock("../src/api/people-api");

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

async function renderWithRouter(ui: React.ReactElement) {
	const queryClient = new QueryClient({
		defaultOptions: {
			queries: { retry: false },
			mutations: { retry: false },
		},
	});

	const rootRoute = createRootRoute({
		component: () => ui,
	});
	const router = createRouter({
		routeTree: rootRoute,
		history: createMemoryHistory({ initialEntries: ["/"] }),
	});
	await router.load();

	return render(
		<QueryClientProvider client={queryClient}>
			<RouterProvider router={router} />
		</QueryClientProvider>,
	);
}

describe("F6 People CRUD — Identity, OCC, Archive & Balance Distinction", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("creates a person with trimmed name, relationship enum, note and stable idempotency", async () => {
		const mockCreate = vi.spyOn(peopleApi, "createPerson").mockResolvedValue({
			person: {
				personId: "person-123",
				status: "ACTIVE",
				displayName: "Ahmet Yılmaz",
				relationship: "FRIEND",
				note: "İş arkadaşı",
				revisionNo: 1,
				receivableBalance: "0.00",
				payableBalance: "0.00",
			},
		});

		const onSuccess = vi.fn();
		render(<PersonForm mode="create" onSuccess={onSuccess} />, {
			wrapper: createWrapper(),
		});

		fireEvent.change(screen.getByTestId("person-name-input"), {
			target: { value: "  Ahmet Yılmaz  " },
		});

		fireEvent.click(screen.getByTestId("relationship-friend"));

		fireEvent.change(screen.getByLabelText(/Not/i), {
			target: { value: "İş arkadaşı" },
		});

		fireEvent.click(screen.getByTestId("person-submit-btn"));

		await waitFor(() => {
			expect(mockCreate).toHaveBeenCalledTimes(1);
		});

		const [payload, idempotencyKey] = mockCreate.mock.calls[0]!;
		expect(payload.displayName).toBe("Ahmet Yılmaz");
		expect(payload.relationship).toBe("FRIEND");
		expect(payload.note).toBe("İş arkadaşı");
		expect(typeof idempotencyKey).toBe("string");
		expect(idempotencyKey?.length).toBeGreaterThan(10);
	});

	it("validates displayName length and note length before submission", async () => {
		const mockCreate = vi.spyOn(peopleApi, "createPerson");

		render(<PersonForm mode="create" />, {
			wrapper: createWrapper(),
		});

		fireEvent.change(screen.getByTestId("person-name-input"), {
			target: { value: "   " },
		});

		fireEvent.click(screen.getByTestId("person-submit-btn"));

		await waitFor(() => {
			expect(screen.getByTestId("person-validation-error")).toBeInTheDocument();
		});

		expect(mockCreate).not.toHaveBeenCalled();
	});

	it("submits person edit with OCC expectedRevisionNo and stops on PEOPLE_REVISION_CONFLICT", async () => {
		const initialPerson: PersonProductDto = {
			personId: "person-123",
			status: "ACTIVE",
			displayName: "Mehmet Demir",
			relationship: "FAMILY",
			note: null,
			revisionNo: 2,
			receivableBalance: "0.00",
			payableBalance: "0.00",
		};

		vi.spyOn(peopleApi, "fetchPerson").mockResolvedValue({
			person: initialPerson,
		});

		const conflictError = new ApiError({
			status: 409,
			code: "PEOPLE_REVISION_CONFLICT",
			message: "Revision conflict",
		});

		const mockUpdate = vi
			.spyOn(peopleApi, "updatePerson")
			.mockRejectedValue(conflictError);

		render(<PersonForm mode="edit" personId="person-123" />, {
			wrapper: createWrapper(),
		});

		await waitFor(() => {
			expect(screen.getByDisplayValue("Mehmet Demir")).toBeInTheDocument();
		});

		fireEvent.change(screen.getByDisplayValue("Mehmet Demir"), {
			target: { value: "Mehmet Demir Güncel" },
		});

		fireEvent.click(screen.getByTestId("person-submit-btn"));

		await waitFor(() => {
			expect(mockUpdate).toHaveBeenCalledTimes(1);
		});

		const [, updatePayload] = mockUpdate.mock.calls[0]!;
		expect(updatePayload.expectedRevisionNo).toBe(2);

		// Assert conflict notice and review required (no blind retry)
		await waitFor(() => {
			expect(screen.getByTestId("person-conflict-box")).toBeInTheDocument();
			expect(screen.getByTestId("reload-conflict-btn")).toBeInTheDocument();
		});
	});

	it("shows natural conflict message when archiving person with outstanding balance", async () => {
		const personWithBalance: PersonProductDto = {
			personId: "person-with-bal",
			status: "ACTIVE",
			displayName: "Ayşe Kaya",
			relationship: "FRIEND",
			note: null,
			revisionNo: 3,
			receivableBalance: "150.00",
			payableBalance: "0.00",
		};

		const balanceConflictError = new ApiError({
			status: 400,
			code: "PEOPLE_PERSON_HAS_OUTSTANDING_BALANCE",
			message: "Outstanding balance",
		});

		const mockArchive = vi
			.spyOn(peopleApi, "archivePerson")
			.mockRejectedValue(balanceConflictError);

		render(
			<PersonArchiveModal
				isOpen={true}
				onClose={vi.fn()}
				person={personWithBalance}
			/>,
			{ wrapper: createWrapper() },
		);

		// Assert balance warning banner in modal
		expect(screen.getByTestId("archive-balance-warning")).toBeInTheDocument();

		fireEvent.click(screen.getByTestId("confirm-archive-btn"));

		await waitFor(() => {
			expect(mockArchive).toHaveBeenCalledTimes(1);
		});

		expect(mockArchive).toHaveBeenCalledWith(
			"person-with-bal",
			expect.objectContaining({ expectedRevisionNo: 3 }),
			expect.any(String),
		);

		await waitFor(() => {
			expect(
				screen.getByText(
					/Bu kişide açık borç\/alacak bulunduğu için arşivlenemiyor/i,
				),
			).toBeInTheDocument();
		});
	});

	it("renders people list with distinct receivable and payable amounts, never collapsing into a fake net", async () => {
		vi.spyOn(peopleApi, "fetchPeople").mockResolvedValue({
			people: [
				{
					personId: "p1",
					status: "ACTIVE",
					displayName: "Caner Eren",
					relationship: "OTHER",
					note: null,
					revisionNo: 1,
					receivableBalance: "500.00",
					payableBalance: "120.00",
				},
			],
			limit: 50,
			hasMore: false,
			nextCursor: null,
		});

		await renderWithRouter(<PeoplePage />);

		await waitFor(() => {
			expect(screen.getAllByText("Caner Eren").length).toBeGreaterThan(0);
		});

		// Assert both balances exist distinctly
		expect(screen.getAllByText(/Bana Ödeyecek/i).length).toBeGreaterThan(0);
		expect(screen.getAllByText(/Ben Ödeyeceğim/i).length).toBeGreaterThan(0);
		expect(screen.getAllByText(/₺500,00/i).length).toBeGreaterThan(0);
		expect(screen.getAllByText(/₺120,00/i).length).toBeGreaterThan(0);

		// Verify NO fake net amount (500 - 120 = 380) is rendered
		expect(screen.queryByText(/₺380,00/i)).not.toBeInTheDocument();
	});

	it("R2: person create uncertain retry reuses exact same Idempotency-Key, payload, and occurredAt", async () => {
		const networkError = new ApiError({
			status: 0,
			code: "NETWORK_ERROR",
			message: "Failed to fetch",
		});

		const mockCreate = vi
			.spyOn(peopleApi, "createPerson")
			.mockRejectedValueOnce(networkError)
			.mockResolvedValueOnce({
				person: {
					personId: "person-unc",
					status: "ACTIVE",
					displayName: "Zeynep Arslan",
					relationship: "FRIEND",
					note: "Ortak hesap",
					revisionNo: 1,
					receivableBalance: "0.00",
					payableBalance: "0.00",
				},
			});

		render(<PersonForm mode="create" />, {
			wrapper: createWrapper(),
		});

		fireEvent.change(screen.getByTestId("person-name-input"), {
			target: { value: "Zeynep Arslan" },
		});
		fireEvent.click(screen.getByTestId("relationship-friend"));
		fireEvent.change(screen.getByLabelText(/Not/i), {
			target: { value: "Ortak hesap" },
		});

		fireEvent.click(screen.getByTestId("person-submit-btn"));

		await waitFor(() => {
			expect(mockCreate).toHaveBeenCalledTimes(1);
		});

		expect(
			await screen.findByTestId("person-uncertain-alert"),
		).toBeInTheDocument();
		expect(
			screen.getByText("İşlemin kaydedilip kaydedilmediği doğrulanamadı."),
		).toBeInTheDocument();

		fireEvent.click(screen.getByTestId("retry-uncertain-btn"));

		await waitFor(() => {
			expect(mockCreate).toHaveBeenCalledTimes(2);
		});

		const [call1Payload, call1Key] = mockCreate.mock.calls[0]!;
		const [call2Payload, call2Key] = mockCreate.mock.calls[1]!;

		expect(call2Key).toBe(call1Key);
		expect(call2Payload).toEqual(call1Payload);
		expect(call2Payload.occurredAt).toBe(call1Payload.occurredAt);
	});

	it("R2: person edit uncertain retry reuses exact same Idempotency-Key, payload, and occurredAt", async () => {
		const initialPerson: PersonProductDto = {
			personId: "person-edit-unc",
			status: "ACTIVE",
			displayName: "Burak Yılmaz",
			relationship: "FRIEND",
			note: "Eski not",
			revisionNo: 5,
			receivableBalance: "0.00",
			payableBalance: "0.00",
		};

		vi.spyOn(peopleApi, "fetchPerson").mockResolvedValue({
			person: initialPerson,
		});

		const networkError = new ApiError({
			status: 0,
			code: "NETWORK_ERROR",
			message: "Connection abort",
		});

		const mockUpdate = vi
			.spyOn(peopleApi, "updatePerson")
			.mockRejectedValueOnce(networkError)
			.mockResolvedValueOnce({
				person: {
					...initialPerson,
					displayName: "Burak Yılmaz Güncel",
					revisionNo: 6,
				},
			});

		render(<PersonForm mode="edit" personId="person-edit-unc" />, {
			wrapper: createWrapper(),
		});

		await waitFor(() => {
			expect(screen.getByDisplayValue("Burak Yılmaz")).toBeInTheDocument();
		});

		fireEvent.change(screen.getByDisplayValue("Burak Yılmaz"), {
			target: { value: "Burak Yılmaz Güncel" },
		});

		fireEvent.click(screen.getByTestId("person-submit-btn"));

		await waitFor(() => {
			expect(mockUpdate).toHaveBeenCalledTimes(1);
		});

		expect(
			await screen.findByTestId("person-uncertain-alert"),
		).toBeInTheDocument();

		fireEvent.click(screen.getByTestId("retry-uncertain-btn"));

		await waitFor(() => {
			expect(mockUpdate).toHaveBeenCalledTimes(2);
		});

		const [call1Id, call1Payload, call1Key] = mockUpdate.mock.calls[0]!;
		const [call2Id, call2Payload, call2Key] = mockUpdate.mock.calls[1]!;

		expect(call1Id).toBe("person-edit-unc");
		expect(call2Id).toBe("person-edit-unc");
		expect(call2Key).toBe(call1Key);
		expect(call2Payload).toEqual(call1Payload);
		expect(call2Payload.expectedRevisionNo).toBe(5);
		expect(call2Payload.occurredAt).toBe(call1Payload.occurredAt);
	});

	it("R2: person archive uncertain retry reuses exact same Idempotency-Key, payload, and occurredAt", async () => {
		const personToArchive: PersonProductDto = {
			personId: "person-arch-unc",
			status: "ACTIVE",
			displayName: "Fatma Şen",
			relationship: "OTHER",
			note: null,
			revisionNo: 4,
			receivableBalance: "0.00",
			payableBalance: "0.00",
		};

		const networkError = new ApiError({
			status: 0,
			code: "NETWORK_ERROR",
			message: "Timeout archiving",
		});

		const mockArchive = vi
			.spyOn(peopleApi, "archivePerson")
			.mockRejectedValueOnce(networkError)
			.mockResolvedValueOnce({
				person: {
					...personToArchive,
					status: "ARCHIVED",
					revisionNo: 5,
				},
			});

		render(
			<PersonArchiveModal
				isOpen={true}
				onClose={vi.fn()}
				person={personToArchive}
			/>,
			{ wrapper: createWrapper() },
		);

		fireEvent.click(screen.getByTestId("confirm-archive-btn"));

		await waitFor(() => {
			expect(mockArchive).toHaveBeenCalledTimes(1);
		});

		expect(
			await screen.findByTestId("archive-uncertain-alert"),
		).toBeInTheDocument();
		expect(
			screen.getByText("İşlemin kaydedilip kaydedilmediği doğrulanamadı."),
		).toBeInTheDocument();

		fireEvent.click(screen.getByTestId("retry-uncertain-btn"));

		await waitFor(() => {
			expect(mockArchive).toHaveBeenCalledTimes(2);
		});

		const [call1Id, call1Payload, call1Key] = mockArchive.mock.calls[0]!;
		const [call2Id, call2Payload, call2Key] = mockArchive.mock.calls[1]!;

		expect(call1Id).toBe("person-arch-unc");
		expect(call2Id).toBe("person-arch-unc");
		expect(call2Key).toBe(call1Key);
		expect(call2Payload).toEqual(call1Payload);
		expect(call2Payload.expectedRevisionNo).toBe(4);
		expect(call2Payload.occurredAt).toBe(call1Payload.occurredAt);
	});
});
