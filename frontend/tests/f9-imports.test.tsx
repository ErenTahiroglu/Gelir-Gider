import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import type React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../src/api/errors";
import * as importsApi from "../src/api/imports-api";
import type {
	ApplyReadyRowsResponse,
	ImportBatchSummary,
	ImportRowDetail,
	StageImportBatchResponse,
} from "../src/api/imports-types";
import * as manualExpensesApi from "../src/api/manual-expenses-api";
import { CsvImportForm } from "../src/components/imports/CsvImportForm";
import { ImportApplyProgress } from "../src/components/imports/ImportApplyProgress";
import { ImportBatchPage } from "../src/components/imports/ImportBatchPage";
import { ImportRowResolver } from "../src/components/imports/ImportRowResolver";
import { ImportRowsReview } from "../src/components/imports/ImportRowsReview";

vi.mock("../src/api/imports-api");
vi.mock("../src/api/credit-cards-api", () => ({
	fetchAllActiveCreditCards: vi.fn().mockResolvedValue([
		{
			cardId: "card-1",
			displayName: "Garanti Bonus",
			lastFour: "1234",
			status: "ACTIVE",
		},
	]),
}));
vi.mock("../src/api/f7-api", () => ({
	fetchShortTermGoals: vi.fn().mockResolvedValue({
		goals: [
			{
				goalId: "goal-1",
				name: "Yeni Laptop",
				status: "ACTIVE",
			},
		],
	}),
}));
vi.mock("../src/api/income-api", () => ({
	fetchAllActiveIncomeSources: vi.fn().mockResolvedValue([
		{
			sourceId: "source-1",
			name: "Maaş",
			status: "ACTIVE",
		},
	]),
}));
vi.mock("../src/api/manual-expenses-api", () => ({
	fetchAllLedgerAccounts: vi.fn().mockResolvedValue([
		{
			accountId: "acc-1",
			accountType: "ASSET",
			normalBalance: "DEBIT",
			name: "Vadesiz TL",
			currency: "TRY",
			archived: false,
			balance: "1000.00",
			code: "102.01",
		},
	]),
}));

let mockParams: Record<string, string> = {};
const mockNavigate = vi.fn();

vi.mock("@tanstack/react-router", () => ({
	Link: ({ children, to, ...props }: any) => (
		<a href={to} {...props}>
			{children}
		</a>
	),
	useNavigate: () => mockNavigate,
	useParams: () => mockParams,
	useSearch: () => ({}),
}));

function createWrapper() {
	const queryClient = new QueryClient({
		defaultOptions: {
			queries: { retry: false },
			mutations: { retry: false },
		},
	});
	return {
		queryClient,
		wrapper: ({ children }: { children: React.ReactNode }) => (
			<QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
		),
	};
}

describe("F9 — CSV Imports & Resolution Unit & Integration Suite", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockParams = {};
	});

	afterEach(() => {
		cleanup();
	});

	it("stages valid CSV with GENERIC_CSV_V1 and NO Idempotency-Key", async () => {
		const stageMock = vi
			.mocked(importsApi.stageImportBatch)
			.mockResolvedValueOnce({
				batch: {
					id: "batch-100",
					userId: "user-1",
					provider: "HTTP_UPLOAD",
					sourceKind: "GENERIC_CSV_V1",
					sourceContentHash: "hash123",
					sourceFileName: "ekstre.csv",
					parserType: "GENERIC_CSV_V1",
					parserVersion: "1",
					observedAt: "2026-10-01T10:00:00.000Z",
					createdAt: "2026-10-01T10:00:00.000Z",
					totalRows: 10,
					readyCount: 10,
					needsReviewCount: 0,
					possibleDuplicateCount: 0,
					exactDuplicateCount: 0,
					appliedCount: 0,
					linkedCount: 0,
					skippedCount: 0,
					unsupportedCount: 0,
				},
				rows: [],
				idempotentReplay: false,
			});

		const { wrapper } = createWrapper();
		const onSuccess = vi.fn();
		render(<CsvImportForm onSuccess={onSuccess} />, { wrapper });

		const csvContent =
			"recordType,date,amount,description\nPURCHASE,2026-10-01,150.00,Market\n";
		const file = new File([csvContent], "ekstre.csv", { type: "text/csv" });

		const input = screen.getByTestId("csv-file-input");
		fireEvent.change(input, { target: { files: [file] } });

		await waitFor(() => {
			expect(screen.getByTestId("btn-upload-csv")).toBeEnabled();
		});

		fireEvent.click(screen.getByTestId("btn-upload-csv"));

		await waitFor(() => {
			expect(stageMock).toHaveBeenCalledTimes(1);
		});

		const callArg = stageMock.mock.calls[0]![0];
		expect(callArg.sourceKind).toBe("GENERIC_CSV_V1");
		expect(callArg.sourceFileName).toBe("ekstre.csv");
		expect(callArg.sourceContent).toBe(csvContent);
		expect(callArg.observedAt).toBeDefined();
		expect(stageMock.mock.calls[0]!.length).toBe(1);
	});

	it("handles file size > 10 MiB by showing natural error without network call", async () => {
		const stageMock = vi.mocked(importsApi.stageImportBatch);
		const { wrapper } = createWrapper();
		render(<CsvImportForm />, { wrapper });

		const largeContent = "a".repeat(11 * 1024 * 1024);
		const file = new File([largeContent], "huge.csv", { type: "text/csv" });

		const input = screen.getByTestId("csv-file-input");
		fireEvent.change(input, { target: { files: [file] } });

		expect(
			screen.getByText(/Dosya 10 MB sınırını aşıyor/i),
		).toBeInTheDocument();
		expect(stageMock).not.toHaveBeenCalled();
	});

	it("preserves exact frozen body on network uncertainty retry", async () => {
		const stageMock = vi
			.mocked(importsApi.stageImportBatch)
			.mockRejectedValueOnce(
				new ApiError({
					status: 0,
					code: "NETWORK_ERROR",
					message: "Failed to fetch",
				}),
			)
			.mockResolvedValueOnce({
				batch: {
					id: "batch-101",
					userId: "user-1",
					provider: "HTTP_UPLOAD",
					sourceKind: "GENERIC_CSV_V1",
					sourceContentHash: "hash123",
					sourceFileName: "ekstre.csv",
					parserType: "GENERIC_CSV_V1",
					parserVersion: "1",
					observedAt: "2026-10-01T10:00:00.000Z",
					createdAt: "2026-10-01T10:00:00.000Z",
					totalRows: 5,
					readyCount: 5,
					needsReviewCount: 0,
					possibleDuplicateCount: 0,
					exactDuplicateCount: 0,
					appliedCount: 0,
					linkedCount: 0,
					skippedCount: 0,
					unsupportedCount: 0,
				},
				rows: [],
				idempotentReplay: false,
			});

		const { wrapper } = createWrapper();
		render(<CsvImportForm />, { wrapper });

		const csvContent = "type,date,amount\nPURCHASE,2026-10-01,50.00\n";
		const file = new File([csvContent], "ekstre.csv", { type: "text/csv" });

		fireEvent.change(screen.getByTestId("csv-file-input"), {
			target: { files: [file] },
		});
		await waitFor(() => screen.getByTestId("btn-upload-csv"));
		fireEvent.click(screen.getByTestId("btn-upload-csv"));

		await waitFor(() => {
			expect(
				screen.getByText(/Dosyanın yüklenip yüklenmediği doğrulanamadı/i),
			).toBeInTheDocument();
		});

		const retryBtn = screen.getByTestId("btn-retry-staging");
		expect(retryBtn).toBeInTheDocument();
		fireEvent.click(retryBtn);

		await waitFor(() => {
			expect(stageMock).toHaveBeenCalledTimes(2);
		});

		const firstCall = stageMock.mock.calls[0]![0];
		const secondCall = stageMock.mock.calls[1]![0];
		expect(secondCall.observedAt).toBe(firstCall.observedAt);
		expect(secondCall.sourceContent).toBe(firstCall.sourceContent);
		expect(secondCall.sourceFileName).toBe(firstCall.sourceFileName);
	});

	it("treats 200 idempotentReplay=true as successful staging", async () => {
		vi.mocked(importsApi.stageImportBatch).mockResolvedValueOnce({
			batch: {
				id: "batch-replay",
				userId: "user-1",
				provider: "HTTP_UPLOAD",
				sourceKind: "GENERIC_CSV_V1",
				sourceContentHash: "hash123",
				sourceFileName: "ekstre.csv",
				parserType: "GENERIC_CSV_V1",
				parserVersion: "1",
				observedAt: "2026-10-01T10:00:00.000Z",
				createdAt: "2026-10-01T10:00:00.000Z",
				totalRows: 2,
				readyCount: 2,
				needsReviewCount: 0,
				possibleDuplicateCount: 0,
				exactDuplicateCount: 0,
				appliedCount: 0,
				linkedCount: 0,
				skippedCount: 0,
				unsupportedCount: 0,
			},
			rows: [],
			idempotentReplay: true,
		});

		const { wrapper } = createWrapper();
		const onSuccess = vi.fn();
		render(<CsvImportForm onSuccess={onSuccess} />, { wrapper });

		const file = new File(["type,amount\nPURCHASE,10.00\n"], "ekstre.csv", {
			type: "text/csv",
		});
		fireEvent.change(screen.getByTestId("csv-file-input"), {
			target: { files: [file] },
		});
		await waitFor(() => screen.getByTestId("btn-upload-csv"));
		fireEvent.click(screen.getByTestId("btn-upload-csv"));

		await waitFor(() => {
			expect(onSuccess).toHaveBeenCalledWith(
				expect.objectContaining({
					batch: expect.objectContaining({ id: "batch-replay" }),
					idempotentReplay: true,
				}),
			);
		});
	});

	it("clearly labels 25-row sample preview when totalRows > 25", async () => {
		mockParams = { batchId: "batch-large" };
		vi.mocked(importsApi.getImportBatch).mockResolvedValueOnce({
			id: "batch-large",
			userId: "user-1",
			provider: "HTTP_UPLOAD",
			sourceKind: "GENERIC_CSV_V1",
			sourceContentHash: "hash",
			sourceFileName: "huge_statement.csv",
			parserType: "GENERIC_CSV_V1",
			parserVersion: "1",
			observedAt: "2026-10-01T10:00:00.000Z",
			createdAt: "2026-10-01T10:00:00.000Z",
			totalRows: 1000,
			readyCount: 1000,
			needsReviewCount: 0,
			possibleDuplicateCount: 0,
			exactDuplicateCount: 0,
			appliedCount: 0,
			linkedCount: 0,
			skippedCount: 0,
			unsupportedCount: 0,
		});

		vi.mocked(importsApi.getImportBatchPreview).mockResolvedValueOnce({
			batch: {
				id: "batch-large",
				userId: "user-1",
				provider: "HTTP_UPLOAD",
				sourceKind: "GENERIC_CSV_V1",
				sourceContentHash: "hash",
				sourceFileName: "huge_statement.csv",
				parserType: "GENERIC_CSV_V1",
				parserVersion: "1",
				observedAt: "2026-10-01T10:00:00.000Z",
				createdAt: "2026-10-01T10:00:00.000Z",
				totalRows: 1000,
				readyCount: 1000,
				needsReviewCount: 0,
				possibleDuplicateCount: 0,
				exactDuplicateCount: 0,
				appliedCount: 0,
				linkedCount: 0,
				skippedCount: 0,
				unsupportedCount: 0,
			},
			rowSample: Array.from({ length: 25 }, (_, i) => ({
				id: `row-${i}`,
				userId: "user-1",
				batchId: "batch-large",
				rowOrdinal: i + 1,
				recordType: "CREDIT_CARD_PURCHASE",
				latestRevisionNo: 1,
				status: "READY",
				payload: {
					recordType: "CREDIT_CARD_PURCHASE",
					occurredAt: "2026-10-01T10:00:00.000Z",
					amount: "100.00",
					merchant: `Market ${i}`,
					cardId: "card-1",
					purchaseCategory: "MANDATORY",
					shortTermGoalId: null,
					description: null,
					installmentCount: 1,
				},
				occurredAt: "2026-10-01T10:00:00.000Z",
				externalIdentityPresent: false,
				duplicateCandidates: [],
				result: null,
			})),
			rowSampleLimit: 25,
		});

		const { wrapper } = createWrapper();
		render(<ImportBatchPage />, { wrapper });

		await waitFor(() => {
			expect(screen.getByTestId("preview-sample-label")).toHaveTextContent(
				"İlk 25 satırdan örnek (Toplam 1000 satır)",
			);
		});
	});

	it("integrates ImportBatchPage with readyCount = 3, enables modal start button, and triggers applyReadyImportRows", async () => {
		mockParams = { batchId: "batch-real-1" };
		vi.mocked(importsApi.getImportBatch).mockResolvedValue({
			id: "batch-real-1",
			userId: "user-1",
			provider: "HTTP_UPLOAD",
			sourceKind: "GENERIC_CSV_V1",
			sourceContentHash: "hash",
			sourceFileName: "test.csv",
			parserType: "GENERIC_CSV_V1",
			parserVersion: "1",
			observedAt: "2026-10-01T10:00:00.000Z",
			createdAt: "2026-10-01T10:00:00.000Z",
			totalRows: 3,
			readyCount: 3,
			needsReviewCount: 0,
			possibleDuplicateCount: 0,
			exactDuplicateCount: 0,
			appliedCount: 0,
			linkedCount: 0,
			skippedCount: 0,
			unsupportedCount: 0,
		});

		vi.mocked(importsApi.getImportBatchPreview).mockResolvedValue({
			batch: {
				id: "batch-real-1",
				userId: "user-1",
				provider: "HTTP_UPLOAD",
				sourceKind: "GENERIC_CSV_V1",
				sourceContentHash: "hash",
				sourceFileName: "test.csv",
				parserType: "GENERIC_CSV_V1",
				parserVersion: "1",
				observedAt: "2026-10-01T10:00:00.000Z",
				createdAt: "2026-10-01T10:00:00.000Z",
				totalRows: 3,
				readyCount: 3,
				needsReviewCount: 0,
				possibleDuplicateCount: 0,
				exactDuplicateCount: 0,
				appliedCount: 0,
				linkedCount: 0,
				skippedCount: 0,
				unsupportedCount: 0,
			},
			rowSample: [],
			rowSampleLimit: 25,
		});

		const applyMock = vi
			.mocked(importsApi.applyReadyImportRows)
			.mockResolvedValueOnce({
				appliedCount: 3,
				failedCount: 0,
				remainingReadyCount: 0,
				hasMore: false,
				results: [],
			});

		const { wrapper } = createWrapper();
		render(<ImportBatchPage />, { wrapper });

		await waitFor(() => {
			expect(screen.getByTestId("btn-apply-ready")).toBeInTheDocument();
		});

		fireEvent.click(screen.getByTestId("btn-apply-ready"));

		await waitFor(() => {
			expect(screen.getByTestId("metric-remaining-count")).toHaveTextContent(
				"3",
			);
		});

		const startBtn = screen.getByTestId("btn-start-apply");
		expect(startBtn).toBeEnabled();

		fireEvent.click(startBtn);

		await waitFor(() => {
			expect(applyMock).toHaveBeenCalledWith("batch-real-1", 50);
		});
	});

	it("integrates ImportRowsReview with readyCount = 3 and initializes apply modal correctly", async () => {
		mockParams = { batchId: "batch-review-1" };
		vi.mocked(importsApi.getImportBatch).mockResolvedValue({
			id: "batch-review-1",
			userId: "user-1",
			provider: "HTTP_UPLOAD",
			sourceKind: "GENERIC_CSV_V1",
			sourceContentHash: "hash",
			sourceFileName: "test.csv",
			parserType: "GENERIC_CSV_V1",
			parserVersion: "1",
			observedAt: "2026-10-01T10:00:00.000Z",
			createdAt: "2026-10-01T10:00:00.000Z",
			totalRows: 3,
			readyCount: 3,
			needsReviewCount: 0,
			possibleDuplicateCount: 0,
			exactDuplicateCount: 0,
			appliedCount: 0,
			linkedCount: 0,
			skippedCount: 0,
			unsupportedCount: 0,
		});

		vi.mocked(importsApi.getImportRows).mockResolvedValue({
			items: [],
			nextCursor: null,
		});

		const { wrapper } = createWrapper();
		render(<ImportRowsReview />, { wrapper });

		await waitFor(() => {
			expect(
				screen.getByTestId("btn-apply-ready-from-review"),
			).toBeInTheDocument();
		});

		fireEvent.click(screen.getByTestId("btn-apply-ready-from-review"));

		await waitFor(() => {
			expect(screen.getByTestId("metric-remaining-count")).toHaveTextContent(
				"3",
			);
			expect(screen.getByTestId("btn-start-apply")).toBeEnabled();
		});
	});

	it("enters REVIEW_REQUIRED state on failed apply and disables/hides normal start button", async () => {
		const applyMock = vi
			.mocked(importsApi.applyReadyImportRows)
			.mockResolvedValueOnce({
				appliedCount: 1,
				failedCount: 1,
				remainingReadyCount: 1,
				hasMore: true,
				results: [
					{
						importRowId: "row-failing",
						status: "FAILED",
						errorMessage: "Kart limiti yetersiz",
					},
				],
			});

		const { wrapper } = createWrapper();
		render(
			<ImportApplyProgress
				batchId="batch-fail-gate"
				readyCount={2}
				isOpen={true}
				onClose={() => {}}
			/>,
			{ wrapper },
		);

		fireEvent.click(screen.getByTestId("btn-start-apply"));

		await waitFor(() => {
			expect(applyMock).toHaveBeenCalledTimes(1);
		});

		await waitFor(() => {
			expect(
				screen.getByText(/Bazı satırlar uygulanamadı/i),
			).toBeInTheDocument();
		});

		// Start button must be hidden or disabled to prevent hammering the failing row
		expect(screen.queryByTestId("btn-start-apply")).not.toBeInTheDocument();
		expect(screen.getByTestId("btn-close-apply")).toHaveTextContent(
			/Kapat ve Satırları İncele/i,
		);
	});

	it("apply network uncertainty explicitly refreshes batch + READY rows authority", async () => {
		vi.mocked(importsApi.applyReadyImportRows).mockRejectedValueOnce(
			new ApiError({
				status: 0,
				code: "NETWORK_ERROR",
				message: "Network failure",
			}),
		);

		const batchMock = vi
			.mocked(importsApi.getImportBatch)
			.mockResolvedValueOnce({
				id: "batch-uncertain",
				userId: "user-1",
				provider: "HTTP_UPLOAD",
				sourceKind: "GENERIC_CSV_V1",
				sourceContentHash: "hash",
				sourceFileName: "test.csv",
				parserType: "GENERIC_CSV_V1",
				parserVersion: "1",
				observedAt: "2026-10-01T10:00:00.000Z",
				createdAt: "2026-10-01T10:00:00.000Z",
				totalRows: 5,
				readyCount: 3,
				needsReviewCount: 0,
				possibleDuplicateCount: 0,
				exactDuplicateCount: 0,
				appliedCount: 2,
				linkedCount: 0,
				skippedCount: 0,
				unsupportedCount: 0,
			});

		const rowsMock = vi.mocked(importsApi.getImportRows).mockResolvedValueOnce({
			items: [],
			nextCursor: null,
		});

		const { wrapper } = createWrapper();
		render(
			<ImportApplyProgress
				batchId="batch-uncertain"
				readyCount={5}
				isOpen={true}
				onClose={() => {}}
			/>,
			{ wrapper },
		);

		fireEvent.click(screen.getByTestId("btn-start-apply"));

		await waitFor(() => {
			expect(batchMock).toHaveBeenCalledWith("batch-uncertain");
			expect(rowsMock).toHaveBeenCalledWith({
				batchId: "batch-uncertain",
				status: "READY",
				limit: 50,
			});
		});

		await waitFor(() => {
			expect(screen.getByTestId("metric-remaining-count")).toHaveTextContent(
				"3",
			);
			expect(screen.getByTestId("metric-applied-count")).toHaveTextContent("2");
		});
	});

	it("preserves prefilled purchaseCategory when resolving card mapping partially", async () => {
		const rowDetail: ImportRowDetail = {
			id: "row-card-prefill",
			userId: "user-1",
			batchId: "batch-1",
			rowOrdinal: 1,
			recordType: "CREDIT_CARD_PURCHASE",
			latestRevisionNo: 1,
			status: "NEEDS_REVIEW",
			payload: {
				recordType: "CREDIT_CARD_PURCHASE",
				occurredAt: "2026-10-01T10:00:00.000Z",
				amount: "150.00",
				merchant: "Süpermarket",
				cardId: null,
				purchaseCategory: "MANDATORY",
				shortTermGoalId: null,
				description: null,
				installmentCount: 1,
			},
			occurredAt: "2026-10-01T10:00:00.000Z",
			externalIdentityPresent: false,
			duplicateCandidates: [],
			result: null,
		};

		vi.mocked(importsApi.getImportRow).mockResolvedValue(rowDetail);
		const resolveMock = vi
			.mocked(importsApi.resolveImportRow)
			.mockResolvedValueOnce({
				row: { ...rowDetail, status: "READY", latestRevisionNo: 2 },
				idempotentReplay: false,
			});

		const { wrapper } = createWrapper();
		render(
			<ImportRowResolver
				batchId="batch-1"
				rowId="row-card-prefill"
				row={rowDetail}
				isOpen={true}
				onClose={() => {}}
			/>,
			{ wrapper },
		);

		// Assert category is already prefilled to MANDATORY and cards are loaded
		await waitFor(() => {
			expect(screen.getByTestId("select-purchase-category")).toHaveValue(
				"MANDATORY",
			);
			expect(screen.getByText(/Garanti Bonus/i)).toBeInTheDocument();
		});

		// User selects ONLY the card
		fireEvent.change(screen.getByTestId("select-card-id"), {
			target: { value: "card-1" },
		});

		fireEvent.click(screen.getByTestId("btn-submit-resolve-card"));

		await waitFor(() => {
			expect(resolveMock).toHaveBeenCalledTimes(1);
		});

		const [_bId, _rId, body] = resolveMock.mock.calls[0]!;
		expect(body.action).toBe("RESOLVE_MAPPINGS");
		expect(body.resolvedMappings).toEqual({
			cardId: "card-1",
			purchaseCategory: "MANDATORY",
			shortTermGoalId: null,
		});
	});

	it("preserves prefilled incomeSourceId when resolving income mapping partially", async () => {
		const rowDetail: ImportRowDetail = {
			id: "row-income-prefill",
			userId: "user-1",
			batchId: "batch-1",
			rowOrdinal: 1,
			recordType: "INCOME_RECEIPT",
			latestRevisionNo: 1,
			status: "NEEDS_REVIEW",
			payload: {
				recordType: "INCOME_RECEIPT",
				receivedAt: "2026-10-01T10:00:00.000Z",
				amount: "5000.00",
				note: "Danışmanlık",
				incomeSourceId: "source-1",
				destinationAccountId: null,
			},
			occurredAt: "2026-10-01T10:00:00.000Z",
			externalIdentityPresent: false,
			duplicateCandidates: [],
			result: null,
		};

		vi.mocked(importsApi.getImportRow).mockResolvedValue(rowDetail);
		const resolveMock = vi
			.mocked(importsApi.resolveImportRow)
			.mockResolvedValueOnce({
				row: { ...rowDetail, status: "READY", latestRevisionNo: 2 },
				idempotentReplay: false,
			});

		const { wrapper } = createWrapper();
		render(
			<ImportRowResolver
				batchId="batch-1"
				rowId="row-income-prefill"
				row={rowDetail}
				isOpen={true}
				onClose={() => {}}
			/>,
			{ wrapper },
		);

		// Assert income source is already prefilled to source-1
		await waitFor(() => {
			expect(screen.getByTestId("select-income-source-id")).toHaveValue(
				"source-1",
			);
		});

		// User selects ONLY destination account
		fireEvent.change(screen.getByTestId("select-dest-account-id"), {
			target: { value: "acc-1" },
		});

		fireEvent.click(screen.getByTestId("btn-submit-resolve-income"));

		await waitFor(() => {
			expect(resolveMock).toHaveBeenCalledTimes(1);
		});

		const [_bId, _rId, body] = resolveMock.mock.calls[0]!;
		expect(body.action).toBe("RESOLVE_MAPPINGS");
		expect(body.resolvedMappings).toEqual({
			incomeSourceId: "source-1",
			destinationAccountId: "acc-1",
		});
	});

	it("strictly filters Income destination accounts to ASSET + DEBIT + TRY + active", async () => {
		vi.mocked(manualExpensesApi.fetchAllLedgerAccounts).mockResolvedValueOnce([
			{
				accountId: "acc-A",
				accountType: "ASSET",
				normalBalance: "DEBIT",
				currency: "TRY",
				archived: false,
				name: "Kasa A",
				code: "100.01",
				balance: "0.00",
			},
			{
				accountId: "acc-B",
				accountType: "ASSET",
				normalBalance: "CREDIT",
				currency: "TRY",
				archived: false,
				name: "Hesap B",
				code: "100.02",
				balance: "100.00",
			},
			{
				accountId: "acc-C",
				accountType: "ASSET",
				normalBalance: "DEBIT",
				currency: "USD",
				archived: false,
				name: "Hesap C",
				code: "100.03",
				balance: "100.00",
			},
			{
				accountId: "acc-D",
				accountType: "ASSET",
				normalBalance: "DEBIT",
				currency: "TRY",
				archived: true,
				name: "Hesap D",
				code: "100.04",
				balance: "100.00",
			},
		]);

		const rowDetail: ImportRowDetail = {
			id: "row-income-filter",
			userId: "user-1",
			batchId: "batch-1",
			rowOrdinal: 1,
			recordType: "INCOME_RECEIPT",
			latestRevisionNo: 1,
			status: "NEEDS_REVIEW",
			payload: {
				recordType: "INCOME_RECEIPT",
				receivedAt: "2026-10-01T10:00:00.000Z",
				amount: "1000.00",
				note: "Gelir",
				incomeSourceId: "source-1",
				destinationAccountId: null,
			},
			occurredAt: "2026-10-01T10:00:00.000Z",
			externalIdentityPresent: false,
			duplicateCandidates: [],
			result: null,
		};

		vi.mocked(importsApi.getImportRow).mockResolvedValue(rowDetail);

		const { wrapper } = createWrapper();
		render(
			<ImportRowResolver
				batchId="batch-1"
				rowId="row-income-filter"
				row={rowDetail}
				isOpen={true}
				onClose={() => {}}
			/>,
			{ wrapper },
		);

		await waitFor(() => {
			const select = screen.getByTestId("select-dest-account-id");
			const options = Array.from(select.querySelectorAll("option")).map(
				(o) => o.value,
			);
			expect(options).toContain("acc-A");
			expect(options).not.toContain("acc-B");
			expect(options).not.toContain("acc-C");
			expect(options).not.toContain("acc-D");
		});
	});

	it("resolver network-uncertain retry resends SAME key and EXACT payload with locked inputs", async () => {
		const rowDetail: ImportRowDetail = {
			id: "row-uncertain-retry",
			userId: "user-1",
			batchId: "batch-1",
			rowOrdinal: 1,
			recordType: "CREDIT_CARD_PURCHASE",
			latestRevisionNo: 1,
			status: "NEEDS_REVIEW",
			payload: {
				recordType: "CREDIT_CARD_PURCHASE",
				occurredAt: "2026-10-01T10:00:00.000Z",
				amount: "150.00",
				merchant: "Restoran",
				cardId: null,
				purchaseCategory: "DISCRETIONARY",
				shortTermGoalId: null,
				description: null,
				installmentCount: 1,
			},
			occurredAt: "2026-10-01T10:00:00.000Z",
			externalIdentityPresent: false,
			duplicateCandidates: [],
			result: null,
		};

		vi.mocked(importsApi.getImportRow).mockResolvedValue(rowDetail);

		const resolveMock = vi
			.mocked(importsApi.resolveImportRow)
			.mockRejectedValueOnce(
				new ApiError({
					status: 0,
					code: "NETWORK_ERROR",
					message: "Connection lost",
				}),
			)
			.mockResolvedValueOnce({
				row: { ...rowDetail, status: "READY", latestRevisionNo: 2 },
				idempotentReplay: false,
			});

		const { wrapper } = createWrapper();
		render(
			<ImportRowResolver
				batchId="batch-1"
				rowId="row-uncertain-retry"
				row={rowDetail}
				isOpen={true}
				onClose={() => {}}
			/>,
			{ wrapper },
		);

		await waitFor(() => {
			expect(screen.getByTestId("select-card-id")).toBeInTheDocument();
			expect(screen.getByText(/Garanti Bonus/i)).toBeInTheDocument();
		});
		fireEvent.change(screen.getByTestId("select-card-id"), {
			target: { value: "card-1" },
		});

		fireEvent.click(screen.getByTestId("btn-submit-resolve-card"));

		await waitFor(() => {
			expect(resolveMock).toHaveBeenCalledTimes(1);
			expect(screen.getByTestId("btn-retry-resolver")).toBeInTheDocument();
		});

		const [b1, r1, body1, key1] = resolveMock.mock.calls[0]!;

		// While uncertain, verify controls are locked
		expect(screen.getByTestId("select-card-id")).toBeDisabled();
		expect(screen.getByTestId("select-purchase-category")).toBeDisabled();
		expect(screen.getByTestId("tab-link-existing")).toBeDisabled();
		expect(screen.getByTestId("tab-skip-row")).toBeDisabled();
		expect(screen.getByTestId("btn-submit-resolve-card")).toBeDisabled();

		// Click retry
		fireEvent.click(screen.getByTestId("btn-retry-resolver"));

		await waitFor(() => {
			expect(resolveMock).toHaveBeenCalledTimes(2);
		});

		const [b2, r2, body2, key2] = resolveMock.mock.calls[1]!;
		expect(b2).toBe(b1);
		expect(r2).toBe(r1);
		expect(key2).toBe(key1);
		expect(body2).toEqual(body1);
	});

	it("deterministic rejection clears frozen state; subsequent corrected submit gets new key", async () => {
		const rowDetail: ImportRowDetail = {
			id: "row-determ-error",
			userId: "user-1",
			batchId: "batch-1",
			rowOrdinal: 1,
			recordType: "CREDIT_CARD_PURCHASE",
			latestRevisionNo: 1,
			status: "NEEDS_REVIEW",
			payload: {
				recordType: "CREDIT_CARD_PURCHASE",
				occurredAt: "2026-10-01T10:00:00.000Z",
				amount: "150.00",
				merchant: "Restoran",
				cardId: null,
				purchaseCategory: "DISCRETIONARY",
				shortTermGoalId: null,
				description: null,
				installmentCount: 1,
			},
			occurredAt: "2026-10-01T10:00:00.000Z",
			externalIdentityPresent: false,
			duplicateCandidates: [],
			result: null,
		};

		vi.mocked(importsApi.getImportRow).mockResolvedValue(rowDetail);

		const resolveMock = vi
			.mocked(importsApi.resolveImportRow)
			.mockRejectedValueOnce(
				new ApiError({
					status: 400,
					code: "IMPORT_INVALID_INPUT",
					message: "Invalid card selection",
				}),
			)
			.mockResolvedValueOnce({
				row: { ...rowDetail, status: "READY", latestRevisionNo: 2 },
				idempotentReplay: false,
			});

		const { wrapper } = createWrapper();
		render(
			<ImportRowResolver
				batchId="batch-1"
				rowId="row-determ-error"
				row={rowDetail}
				isOpen={true}
				onClose={() => {}}
			/>,
			{ wrapper },
		);

		await waitFor(() => {
			expect(screen.getByTestId("select-card-id")).toBeInTheDocument();
			expect(screen.getByText(/Garanti Bonus/i)).toBeInTheDocument();
		});
		fireEvent.change(screen.getByTestId("select-card-id"), {
			target: { value: "card-1" },
		});

		fireEvent.click(screen.getByTestId("btn-submit-resolve-card"));

		await waitFor(() => {
			expect(resolveMock).toHaveBeenCalledTimes(1);
			expect(screen.getByTestId("resolver-error-banner")).toBeInTheDocument();
		});

		const key1 = resolveMock.mock.calls[0]![3];

		// No uncertain retry button should be present
		expect(screen.queryByTestId("btn-retry-resolver")).not.toBeInTheDocument();

		// User updates category and submits again
		fireEvent.change(screen.getByTestId("select-purchase-category"), {
			target: { value: "MANDATORY" },
		});

		fireEvent.click(screen.getByTestId("btn-submit-resolve-card"));

		await waitFor(() => {
			expect(resolveMock).toHaveBeenCalledTimes(2);
		});

		const key2 = resolveMock.mock.calls[1]![3];
		expect(key2).not.toBe(key1);
	});

	it("revision conflict refetches row with new latestRevisionNo and next submit gets new key", async () => {
		const initialRow: ImportRowDetail = {
			id: "row-occ-conflict",
			userId: "user-1",
			batchId: "batch-1",
			rowOrdinal: 1,
			recordType: "CREDIT_CARD_PURCHASE",
			latestRevisionNo: 1,
			status: "NEEDS_REVIEW",
			payload: {
				recordType: "CREDIT_CARD_PURCHASE",
				occurredAt: "2026-10-01T10:00:00.000Z",
				amount: "150.00",
				merchant: "Restoran",
				cardId: null,
				purchaseCategory: "DISCRETIONARY",
				shortTermGoalId: null,
				description: null,
				installmentCount: 1,
			},
			occurredAt: "2026-10-01T10:00:00.000Z",
			externalIdentityPresent: false,
			duplicateCandidates: [],
			result: null,
		};

		const updatedRow: ImportRowDetail = {
			...initialRow,
			latestRevisionNo: 2,
		};

		const getRowMock = vi
			.mocked(importsApi.getImportRow)
			.mockResolvedValueOnce(initialRow)
			.mockResolvedValueOnce(updatedRow);

		const resolveMock = vi
			.mocked(importsApi.resolveImportRow)
			.mockRejectedValueOnce(
				new ApiError({
					status: 409,
					code: "IMPORT_REVISION_CONFLICT",
					message: "Revision conflict occurred",
				}),
			)
			.mockResolvedValueOnce({
				row: { ...updatedRow, status: "READY", latestRevisionNo: 3 },
				idempotentReplay: false,
			});

		const { wrapper } = createWrapper();
		render(
			<ImportRowResolver
				batchId="batch-1"
				rowId="row-occ-conflict"
				row={initialRow}
				isOpen={true}
				onClose={() => {}}
			/>,
			{ wrapper },
		);

		await waitFor(() => {
			expect(screen.getByTestId("select-card-id")).toBeInTheDocument();
			expect(screen.getByText(/Garanti Bonus/i)).toBeInTheDocument();
		});
		fireEvent.change(screen.getByTestId("select-card-id"), {
			target: { value: "card-1" },
		});

		fireEvent.click(screen.getByTestId("btn-submit-resolve-card"));

		await waitFor(() => {
			expect(resolveMock).toHaveBeenCalledTimes(1);
			expect(
				screen.getByText(/Satır durumu siz incelerken değişti/i),
			).toBeInTheDocument();
		});

		const key1 = resolveMock.mock.calls[0]![3];
		expect(resolveMock.mock.calls[0]![2].expectedRevisionNo).toBe(1);

		// Assert refetch was called
		expect(getRowMock).toHaveBeenCalled();

		// User submits again
		fireEvent.click(screen.getByTestId("btn-submit-resolve-card"));

		await waitFor(() => {
			expect(resolveMock).toHaveBeenCalledTimes(2);
		});

		const [_b2, _r2, body2, key2] = resolveMock.mock.calls[1]!;
		expect(key2).not.toBe(key1);
		expect(body2.expectedRevisionNo).toBe(2);
	});

	it("disallows direct link to IMPORT_ROW candidate type", async () => {
		const rowWithRowCandidate: ImportRowDetail = {
			id: "row-with-cand",
			userId: "user-1",
			batchId: "batch-1",
			rowOrdinal: 2,
			recordType: "CREDIT_CARD_PURCHASE",
			latestRevisionNo: 1,
			status: "POSSIBLE_DUPLICATE",
			payload: {
				recordType: "CREDIT_CARD_PURCHASE",
				occurredAt: "2026-10-01T10:00:00.000Z",
				amount: "100.00",
				merchant: "Restoran",
				cardId: "card-1",
				purchaseCategory: "DISCRETIONARY",
				shortTermGoalId: null,
				description: null,
				installmentCount: 1,
			},
			occurredAt: "2026-10-01T10:00:00.000Z",
			externalIdentityPresent: false,
			duplicateCandidates: [
				{
					candidateType: "IMPORT_ROW",
					candidateId: "row-other",
					reasonCode: "SAME_CARD_DATE_AMOUNT",
				},
			],
			result: null,
		};

		vi.mocked(importsApi.getImportRow).mockResolvedValue(rowWithRowCandidate);

		const { wrapper } = createWrapper();
		render(
			<ImportRowResolver
				batchId="batch-1"
				rowId="row-with-cand"
				row={rowWithRowCandidate}
				isOpen={true}
				onClose={() => {}}
			/>,
			{ wrapper },
		);

		fireEvent.click(screen.getByTestId("tab-link-existing"));

		await waitFor(() => {
			expect(
				screen.getByText(/Aynı dosyada benzer bir satır var/i),
			).toBeInTheDocument();
		});

		expect(
			screen.queryByTestId("btn-link-candidate-row-other"),
		).not.toBeInTheDocument();
	});

	it("chunk apply engine loops forward progress and stops on completion", async () => {
		const applyMock = vi
			.mocked(importsApi.applyReadyImportRows)
			.mockResolvedValueOnce({
				appliedCount: 50,
				failedCount: 0,
				remainingReadyCount: 30,
				hasMore: true,
				results: [],
			})
			.mockResolvedValueOnce({
				appliedCount: 30,
				failedCount: 0,
				remainingReadyCount: 0,
				hasMore: false,
				results: [],
			});

		const { wrapper } = createWrapper();
		render(
			<ImportApplyProgress
				batchId="batch-apply-1"
				readyCount={80}
				isOpen={true}
				onClose={() => {}}
			/>,
			{ wrapper },
		);

		fireEvent.click(screen.getByTestId("btn-start-apply"));

		await waitFor(() => {
			expect(applyMock).toHaveBeenCalledTimes(2);
		});

		expect(applyMock).toHaveBeenNthCalledWith(1, "batch-apply-1", 50);
		expect(applyMock).toHaveBeenNthCalledWith(2, "batch-apply-1", 50);

		await waitFor(() => {
			expect(
				screen.getByText(/Tüm hazır satırlar başarıyla sisteme aktarıldı/i),
			).toBeInTheDocument();
		});
	});

	it("chunk apply stops if zero progress (appliedCount === 0 && hasMore === true)", async () => {
		const applyMock = vi
			.mocked(importsApi.applyReadyImportRows)
			.mockResolvedValueOnce({
				appliedCount: 0,
				failedCount: 0,
				remainingReadyCount: 10,
				hasMore: true,
				results: [],
			});

		const { wrapper } = createWrapper();
		render(
			<ImportApplyProgress
				batchId="batch-zero-prog"
				readyCount={10}
				isOpen={true}
				onClose={() => {}}
			/>,
			{ wrapper },
		);

		fireEvent.click(screen.getByTestId("btn-start-apply"));

		await waitFor(() => {
			expect(applyMock).toHaveBeenCalledTimes(1);
		});

		await waitFor(() => {
			expect(screen.getByText(/İlerleme sağlanamadı/i)).toBeInTheDocument();
		});
	});
});
