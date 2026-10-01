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
			name: "Vadesiz TL",
			currency: "TRY",
			archived: false,
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
		// Staging accepts no idempotency key argument
		expect(stageMock.mock.calls[0]!.length).toBe(1);
	});

	it("handles file size > 10 MiB by showing natural error without network call", async () => {
		const stageMock = vi.mocked(importsApi.stageImportBatch);
		const { wrapper } = createWrapper();
		render(<CsvImportForm />, { wrapper });

		// 11 MiB file
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

	it("sends fresh latestRevisionNo as expectedRevisionNo in resolveImportRow", async () => {
		const rowDetail: ImportRowDetail = {
			id: "row-occ",
			userId: "user-1",
			batchId: "batch-1",
			rowOrdinal: 1,
			recordType: "CREDIT_CARD_PURCHASE",
			latestRevisionNo: 3,
			status: "NEEDS_REVIEW",
			payload: {
				recordType: "CREDIT_CARD_PURCHASE",
				occurredAt: "2026-10-01T10:00:00.000Z",
				amount: "250.00",
				merchant: "Akaryakıt",
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
				row: { ...rowDetail, status: "READY", latestRevisionNo: 4 },
				idempotentReplay: false,
			});

		const { wrapper } = createWrapper();
		render(
			<ImportRowResolver
				batchId="batch-1"
				rowId="row-occ"
				row={rowDetail}
				isOpen={true}
				onClose={() => {}}
			/>,
			{ wrapper },
		);

		await waitFor(() => screen.getByTestId("select-card-id"));
		fireEvent.change(screen.getByTestId("select-card-id"), {
			target: { value: "card-1" },
		});

		fireEvent.click(screen.getByTestId("btn-submit-resolve-card"));

		await waitFor(() => {
			expect(resolveMock).toHaveBeenCalledTimes(1);
		});

		const [batchId, rowId, body, key] = resolveMock.mock.calls[0]!;
		expect(batchId).toBe("batch-1");
		expect(rowId).toBe("row-occ");
		expect(body.expectedRevisionNo).toBe(3);
		expect(key).toBeDefined();
		expect(key.length).toBeGreaterThan(0);
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

	it("chunk apply stops immediately if failedCount > 0 without loop", async () => {
		const applyMock = vi
			.mocked(importsApi.applyReadyImportRows)
			.mockResolvedValueOnce({
				appliedCount: 49,
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

		vi.mocked(importsApi.getImportBatch).mockResolvedValueOnce({
			id: "batch-failing",
			userId: "user-1",
			provider: "HTTP_UPLOAD",
			sourceKind: "GENERIC_CSV_V1",
			sourceContentHash: "hash",
			sourceFileName: "test.csv",
			parserType: "GENERIC_CSV_V1",
			parserVersion: "1",
			observedAt: "2026-10-01T10:00:00.000Z",
			createdAt: "2026-10-01T10:00:00.000Z",
			totalRows: 50,
			readyCount: 1,
			needsReviewCount: 0,
			possibleDuplicateCount: 0,
			exactDuplicateCount: 0,
			appliedCount: 49,
			linkedCount: 0,
			skippedCount: 0,
			unsupportedCount: 0,
		});

		const { wrapper } = createWrapper();
		render(
			<ImportApplyProgress
				batchId="batch-failing"
				readyCount={50}
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

		vi.mocked(importsApi.getImportBatch).mockResolvedValueOnce({
			id: "batch-zero-prog",
			userId: "user-1",
			provider: "HTTP_UPLOAD",
			sourceKind: "GENERIC_CSV_V1",
			sourceContentHash: "hash",
			sourceFileName: "test.csv",
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
