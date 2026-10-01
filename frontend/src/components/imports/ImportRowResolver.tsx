import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
	AlertCircle,
	CheckCircle2,
	Copy,
	ExternalLink,
	MinusCircle,
	RefreshCw,
	XCircle,
} from "lucide-react";
import { useState } from "react";
import { fetchAllActiveCreditCards } from "../../api/credit-cards-api";
import { isNetworkUncertainError } from "../../api/errors";
import { fetchShortTermGoals } from "../../api/f7-api";
import { getImportRow, resolveImportRow } from "../../api/imports-api";
import type {
	ImportRowDetail,
	ImportRowStatus,
	NormalizedCardPurchasePayload,
	NormalizedIncomeReceiptPayload,
	ResolveImportRowRequest,
	ResolveImportRowResponse,
} from "../../api/imports-types";
import { fetchAllActiveIncomeSources } from "../../api/income-api";
import { fetchAllLedgerAccounts } from "../../api/manual-expenses-api";
import { formatIstanbulDateTime } from "../../lib/istanbul-date";
import { AccessibleModal } from "../common/AccessibleModal";

interface ImportRowResolverProps {
	batchId?: string;
	rowId?: string;
	row?: ImportRowDetail;
	isOpen: boolean;
	onClose: () => void;
	onResolved?: (updatedRow: ImportRowDetail) => void;
}

export function ImportRowResolver({
	batchId: propBatchId,
	rowId: propRowId,
	row: initialRow,
	isOpen,
	onClose,
	onResolved,
}: ImportRowResolverProps) {
	const queryClient = useQueryClient();
	const effectiveRowId = initialRow?.id ?? propRowId ?? "";
	const effectiveBatchId = initialRow?.batchId ?? propBatchId ?? "";

	// Fetch fresh row detail
	const {
		data: fetchedRow,
		isLoading: isRowLoading,
		isError: isRowError,
		refetch: refetchRow,
	} = useQuery({
		queryKey: ["import-row", effectiveRowId],
		queryFn: () => getImportRow(effectiveRowId),
		enabled: isOpen && !!effectiveRowId,
		initialData: initialRow,
	});

	const row = fetchedRow ?? initialRow;

	// Context queries for mapping
	const { data: cardsData } = useQuery({
		queryKey: ["active-credit-cards"],
		queryFn: () => fetchAllActiveCreditCards(100),
		enabled: isOpen && row?.recordType === "CREDIT_CARD_PURCHASE",
	});

	const { data: goalsData } = useQuery({
		queryKey: ["active-short-term-goals"],
		queryFn: async () =>
			(await fetchShortTermGoals({ status: "ACTIVE", limit: 100 })).goals,
		enabled: isOpen && row?.recordType === "CREDIT_CARD_PURCHASE",
	});

	const { data: incomeSourcesData } = useQuery({
		queryKey: ["active-income-sources"],
		queryFn: () => fetchAllActiveIncomeSources(100),
		enabled: isOpen && row?.recordType === "INCOME_RECEIPT",
	});

	const { data: ledgerAccountsData } = useQuery({
		queryKey: ["ledger-accounts"],
		queryFn: () => fetchAllLedgerAccounts(100),
		enabled: isOpen && row?.recordType === "INCOME_RECEIPT",
	});

	// Form states
	const [activeTab, setActiveTab] = useState<
		"MAPPINGS" | "CONFIRM" | "LINK" | "SKIP"
	>("MAPPINGS");

	// Card mappings
	const [selectedCardId, setSelectedCardId] = useState<string>("");
	const [selectedCategory, setSelectedCategory] = useState<string>("");
	const [selectedGoalId, setSelectedGoalId] = useState<string>("");

	// Income mappings
	const [selectedIncomeSourceId, setSelectedIncomeSourceId] =
		useState<string>("");
	const [selectedDestAccountId, setSelectedDestAccountId] =
		useState<string>("");

	// Link target
	const [selectedCandidateId, setSelectedCandidateId] = useState<string>("");
	const [selectedCandidateType, setSelectedCandidateType] = useState<
		"CREDIT_CARD_PURCHASE" | "INCOME_RECEIPT"
	>("CREDIT_CARD_PURCHASE");

	// Skip
	const [skipReasonNote, setSkipReasonNote] = useState<string>("");

	// Frozen attempt for network uncertainty & OCC
	const [frozenIdempotencyKey, setFrozenIdempotencyKey] = useState<
		string | null
	>(null);
	const [frozenPayload, setFrozenPayload] =
		useState<ResolveImportRowRequest | null>(null);
	const [isNetworkUncertain, setIsNetworkUncertain] = useState(false);
	const [errorMessage, setErrorMessage] = useState<string | null>(null);

	// Pre-fill fields when row loads
	const initializeForm = (r: ImportRowDetail) => {
		if (r.recordType === "CREDIT_CARD_PURCHASE") {
			const cp = r.payload as NormalizedCardPurchasePayload;
			setSelectedCardId(cp.cardId ?? "");
			setSelectedCategory(cp.purchaseCategory ?? "");
			setSelectedGoalId(cp.shortTermGoalId ?? "");
		} else if (r.recordType === "INCOME_RECEIPT") {
			const ip = r.payload as NormalizedIncomeReceiptPayload;
			setSelectedIncomeSourceId(ip.incomeSourceId ?? "");
			setSelectedDestAccountId(ip.destinationAccountId ?? "");
		}

		if (r.status === "POSSIBLE_DUPLICATE") {
			setActiveTab("CONFIRM");
		} else if (r.status === "NEEDS_REVIEW") {
			setActiveTab("MAPPINGS");
		}
	};

	const resolveMutation = useMutation({
		mutationFn: ({
			request,
			idempotencyKey,
		}: {
			request: ResolveImportRowRequest;
			idempotencyKey: string;
		}) =>
			resolveImportRow(
				effectiveBatchId,
				effectiveRowId,
				request,
				idempotencyKey,
			),
		retry: false,
		onSuccess: (data: ResolveImportRowResponse) => {
			setIsNetworkUncertain(false);
			setFrozenIdempotencyKey(null);
			setFrozenPayload(null);
			setErrorMessage(null);

			void queryClient.invalidateQueries({ queryKey: ["import-batches"] });
			void queryClient.invalidateQueries({
				queryKey: ["import-batch", effectiveBatchId],
			});
			void queryClient.invalidateQueries({
				queryKey: ["import-preview", effectiveBatchId],
			});
			void queryClient.invalidateQueries({
				queryKey: ["import-rows", effectiveBatchId],
			});
			void queryClient.invalidateQueries({
				queryKey: ["import-row", effectiveRowId],
			});

			onResolved?.(data.row);
			onClose();
		},
		onError: async (err: unknown) => {
			if (isNetworkUncertainError(err)) {
				setIsNetworkUncertain(true);
				setErrorMessage(
					"Bu satırdaki kararın kaydedilip kaydedilmediği doğrulanamadı. Lütfen aynı kararı tekrar kontrol edin.",
				);
			} else {
				setIsNetworkUncertain(false);
				const errStr =
					err instanceof Error ? err.message : "İşlem gerçekleştirilemedi.";

				// On OCC revision conflict, clear frozen attempt and refetch row
				if (
					errStr.includes("IMPORT_REVISION_CONFLICT") ||
					(err instanceof Error &&
						err.name === "ApiError" &&
						(err as { code?: string }).code === "IMPORT_REVISION_CONFLICT")
				) {
					setFrozenIdempotencyKey(null);
					setFrozenPayload(null);
					await refetchRow();
					setErrorMessage(
						"Satır durumu siz incelerken değişti. Güncel durum yüklendi; lütfen tekrar inceleyin.",
					);
				} else {
					setErrorMessage(errStr);
				}
			}
		},
	});

	const submitDecision = (request: ResolveImportRowRequest) => {
		setErrorMessage(null);
		const key = frozenIdempotencyKey ?? crypto.randomUUID();
		setFrozenIdempotencyKey(key);
		setFrozenPayload(request);
		resolveMutation.mutate({ request, idempotencyKey: key });
	};

	const handleRetryUncertain = () => {
		if (frozenPayload && frozenIdempotencyKey) {
			resolveMutation.mutate({
				request: frozenPayload,
				idempotencyKey: frozenIdempotencyKey,
			});
		}
	};

	if (!isOpen) return null;

	return (
		<AccessibleModal
			isOpen={isOpen}
			onClose={onClose}
			title={`Satır İnceleme #${row?.rowOrdinal !== undefined ? row.rowOrdinal + 1 : ""}`}
			className="import-resolver-modal"
		>
			<div
				className="resolver-modal-content"
				data-testid="import-resolver-dialog"
			>
				{isRowLoading ? (
					<div className="loading-state">
						<LoaderText />
					</div>
				) : isRowError || !row ? (
					<div className="form-error-banner" role="alert">
						<AlertCircle size={16} aria-hidden="true" />
						<span>Satır bilgisi yüklenemedi.</span>
					</div>
				) : (
					<>
						{/* Row Meta Header */}
						<div className="row-meta-card">
							<div className="row-meta-main">
								<span className="record-type-badge">
									{row.recordType === "CREDIT_CARD_PURCHASE"
										? "Kredi Kartı Harcaması"
										: row.recordType === "INCOME_RECEIPT"
											? "Gelir Tahsilatı"
											: "Desteklenmeyen Kayıt"}
								</span>
								<StatusBadge status={row.status} />
							</div>

							<div className="row-payload-summary">
								{row.recordType === "CREDIT_CARD_PURCHASE" && (
									<CardPurchaseSummary
										payload={row.payload as NormalizedCardPurchasePayload}
										occurredAt={row.occurredAt}
									/>
								)}
								{row.recordType === "INCOME_RECEIPT" && (
									<IncomeReceiptSummary
										payload={row.payload as NormalizedIncomeReceiptPayload}
										occurredAt={row.occurredAt}
									/>
								)}
							</div>
						</div>

						{/* Terminal Status Information */}
						{row.status === "EXACT_DUPLICATE" && (
							<div
								className="terminal-info-banner exact-dup"
								data-testid="exact-dup-info"
							>
								<Copy size={16} aria-hidden="true" />
								<div>
									<strong>
										Bu kayıt daha önce içe aktarılmış aynı işlemle eşleşiyor.
									</strong>
									<p>Bu satır terminal durumdadır ve tekrar uygulanamaz.</p>
								</div>
							</div>
						)}

						{row.status === "UNSUPPORTED" && (
							<div
								className="terminal-info-banner unsupported"
								data-testid="unsupported-info"
							>
								<XCircle size={16} aria-hidden="true" />
								<div>
									<strong>Bu satır türü desteklenmiyor.</strong>
									<p>Finansal hareket olarak uygulanamaz.</p>
								</div>
							</div>
						)}

						{row.status === "APPLIED" && (
							<div
								className="terminal-info-banner applied"
								data-testid="applied-info"
							>
								<CheckCircle2 size={16} aria-hidden="true" />
								<div>
									<strong>Bu satır başarıyla sisteme aktarıldı.</strong>
								</div>
							</div>
						)}

						{row.status === "LINKED_EXISTING" && (
							<div
								className="terminal-info-banner linked"
								data-testid="linked-info"
							>
								<CheckCircle2 size={16} aria-hidden="true" />
								<div>
									<strong>Bu satır mevcut bir işleme bağlandı.</strong>
								</div>
							</div>
						)}

						{row.status === "SKIPPED" && (
							<div
								className="terminal-info-banner skipped"
								data-testid="skipped-info"
							>
								<MinusCircle size={16} aria-hidden="true" />
								<div>
									<strong>Bu satır atlandı.</strong>
								</div>
							</div>
						)}

						{/* Action Decision Form (only for non-terminal statuses) */}
						{(row.status === "READY" ||
							row.status === "NEEDS_REVIEW" ||
							row.status === "POSSIBLE_DUPLICATE") && (
							<div className="resolver-actions-section">
								<div className="resolver-tab-bar" role="tablist">
									{row.status === "POSSIBLE_DUPLICATE" && (
										<button
											type="button"
											role="tab"
											aria-selected={activeTab === "CONFIRM"}
											className={`tab-btn ${activeTab === "CONFIRM" ? "active" : ""}`}
											onClick={() => setActiveTab("CONFIRM")}
											data-testid="tab-confirm-import"
										>
											Yine de İçe Aktar
										</button>
									)}

									<button
										type="button"
										role="tab"
										aria-selected={activeTab === "MAPPINGS"}
										className={`tab-btn ${activeTab === "MAPPINGS" ? "active" : ""}`}
										onClick={() => {
											initializeForm(row);
											setActiveTab("MAPPINGS");
										}}
										data-testid="tab-resolve-mappings"
									>
										Eşleştirmeleri Düzenle
									</button>

									<button
										type="button"
										role="tab"
										aria-selected={activeTab === "LINK"}
										className={`tab-btn ${activeTab === "LINK" ? "active" : ""}`}
										onClick={() => setActiveTab("LINK")}
										data-testid="tab-link-existing"
									>
										Mevcut Kayda Bağla
									</button>

									<button
										type="button"
										role="tab"
										aria-selected={activeTab === "SKIP"}
										className={`tab-btn ${activeTab === "SKIP" ? "active" : ""}`}
										onClick={() => setActiveTab("SKIP")}
										data-testid="tab-skip-row"
									>
										Atla
									</button>
								</div>

								{/* TAB: CONFIRM_IMPORT */}
								{activeTab === "CONFIRM" &&
									row.status === "POSSIBLE_DUPLICATE" && (
										<div className="tab-pane" data-testid="pane-confirm-import">
											<p className="tab-description">
												Bu satır sistemdeki mevcut bir kayıtla benzer görünüyor.
												Eğer farklı bir işlem olduğundan eminseniz yeni bir
												kayıt olarak içe aktarılmasını onaylayabilirsiniz.
											</p>
											<button
												type="button"
												className="btn btn-primary"
												disabled={resolveMutation.isPending}
												onClick={() =>
													submitDecision({
														expectedRevisionNo: row.latestRevisionNo,
														action: "CONFIRM_IMPORT",
													})
												}
												data-testid="btn-submit-confirm-import"
											>
												Yeni Kayıt Olarak Onayla
											</button>
										</div>
									)}

								{/* TAB: RESOLVE_MAPPINGS */}
								{activeTab === "MAPPINGS" && (
									<div className="tab-pane" data-testid="pane-resolve-mappings">
										{row.recordType === "CREDIT_CARD_PURCHASE" ? (
											<div className="mapping-fields-group">
												<div className="form-group">
													<label htmlFor="card-select">Kredi Kartı *</label>
													<select
														id="card-select"
														className="form-control"
														value={selectedCardId}
														onChange={(e) => setSelectedCardId(e.target.value)}
														data-testid="select-card-id"
													>
														<option value="">Kart Seçin...</option>
														{cardsData?.map((c) => (
															<option key={c.cardId} value={c.cardId}>
																{c.displayName}{" "}
																{c.lastFour ? `(•••• ${c.lastFour})` : ""}
															</option>
														))}
													</select>
													{cardsData?.length === 0 && (
														<span className="field-hint">
															Kayıtlı aktif kart bulunamadı.{" "}
															<Link to="/cards/new" target="_blank">
																Yeni Kart Oluştur <ExternalLink size={12} />
															</Link>
														</span>
													)}
												</div>

												<div className="form-group">
													<label htmlFor="category-select">
														Harcama Kategorisi *
													</label>
													<select
														id="category-select"
														className="form-control"
														value={selectedCategory}
														onChange={(e) =>
															setSelectedCategory(e.target.value)
														}
														data-testid="select-purchase-category"
													>
														<option value="">Kategori Seçin...</option>
														<option value="MANDATORY">Zorunlu Harcama</option>
														<option value="DISCRETIONARY">Keyfi Harcama</option>
														<option value="SHORT_TERM_PURCHASE">
															Kısa Vadeli Hedef Harcaması
														</option>
														<option value="UNCLASSIFIED">
															Sınıflandırılmamış
														</option>
													</select>
												</div>

												{selectedCategory === "SHORT_TERM_PURCHASE" && (
													<div className="form-group">
														<label htmlFor="goal-select">
															Kısa Vadeli Hedef *
														</label>
														<select
															id="goal-select"
															className="form-control"
															value={selectedGoalId}
															onChange={(e) =>
																setSelectedGoalId(e.target.value)
															}
															data-testid="select-goal-id"
														>
															<option value="">Hedef Seçin...</option>
															{goalsData?.map((g) => (
																<option key={g.goalId} value={g.goalId}>
																	{g.name}
																</option>
															))}
														</select>
														{goalsData?.length === 0 && (
															<span className="field-hint">
																Aktif hedef bulunamadı.{" "}
																<Link to="/goals/new" target="_blank">
																	Yeni Hedef Oluştur <ExternalLink size={12} />
																</Link>
															</span>
														)}
													</div>
												)}

												<button
													type="button"
													className="btn btn-primary"
													disabled={
														resolveMutation.isPending ||
														(selectedCategory === "SHORT_TERM_PURCHASE" &&
															!selectedGoalId)
													}
													onClick={() =>
														submitDecision({
															expectedRevisionNo: row.latestRevisionNo,
															action: "RESOLVE_MAPPINGS",
															resolvedMappings: {
																cardId: selectedCardId || null,
																purchaseCategory:
																	(selectedCategory as NormalizedCardPurchasePayload["purchaseCategory"]) ||
																	null,
																shortTermGoalId:
																	selectedCategory === "SHORT_TERM_PURCHASE"
																		? selectedGoalId || null
																		: null,
															},
														})
													}
													data-testid="btn-submit-resolve-card"
												>
													Eşleştirmeleri Kaydet
												</button>
											</div>
										) : row.recordType === "INCOME_RECEIPT" ? (
											<div className="mapping-fields-group">
												<div className="form-group">
													<label htmlFor="income-source-select">
														Gelir Kaynağı *
													</label>
													<select
														id="income-source-select"
														className="form-control"
														value={selectedIncomeSourceId}
														onChange={(e) =>
															setSelectedIncomeSourceId(e.target.value)
														}
														data-testid="select-income-source-id"
													>
														<option value="">Gelir Kaynağı Seçin...</option>
														{incomeSourcesData?.map((s) => (
															<option key={s.sourceId} value={s.sourceId}>
																{s.name}
															</option>
														))}
													</select>
													{incomeSourcesData?.length === 0 && (
														<span className="field-hint">
															Aktif gelir kaynağı bulunamadı.{" "}
															<Link to="/income/sources/new" target="_blank">
																Yeni Kaynak Oluştur <ExternalLink size={12} />
															</Link>
														</span>
													)}
												</div>

												<div className="form-group">
													<label htmlFor="dest-account-select">
														Tahsilat Hesabı (Banka/Kasa) *
													</label>
													<select
														id="dest-account-select"
														className="form-control"
														value={selectedDestAccountId}
														onChange={(e) =>
															setSelectedDestAccountId(e.target.value)
														}
														data-testid="select-dest-account-id"
													>
														<option value="">Hesap Seçin...</option>
														{ledgerAccountsData
															?.filter(
																(a) => a.accountType === "ASSET" && !a.archived,
															)
															.map((a) => (
																<option key={a.accountId} value={a.accountId}>
																	{a.name} ({a.currency})
																</option>
															))}
													</select>
												</div>

												<button
													type="button"
													className="btn btn-primary"
													disabled={resolveMutation.isPending}
													onClick={() =>
														submitDecision({
															expectedRevisionNo: row.latestRevisionNo,
															action: "RESOLVE_MAPPINGS",
															resolvedMappings: {
																incomeSourceId: selectedIncomeSourceId || null,
																destinationAccountId:
																	selectedDestAccountId || null,
															},
														})
													}
													data-testid="btn-submit-resolve-income"
												>
													Eşleştirmeleri Kaydet
												</button>
											</div>
										) : null}
									</div>
								)}

								{/* TAB: LINK_EXISTING */}
								{activeTab === "LINK" && (
									<div className="tab-pane" data-testid="pane-link-existing">
										<p className="tab-description">
											Bu satırı sistemdeki mevcut bir işleme bağlayabilirsiniz.
										</p>

										{row.duplicateCandidates.length > 0 ? (
											<div className="duplicate-candidates-list">
												<span className="field-label">
													Benzer Kayıt Adayları:
												</span>
												{row.duplicateCandidates.map((cand) => {
													const isImportRowCandidate =
														cand.candidateType === "IMPORT_ROW";
													return (
														<button
															type="button"
															key={`${cand.candidateType}-${cand.candidateId}`}
															className={`candidate-card ${
																selectedCandidateId === cand.candidateId
																	? "selected"
																	: ""
															}`}
															onClick={() => {
																if (!isImportRowCandidate) {
																	setSelectedCandidateId(cand.candidateId);
																	setSelectedCandidateType(
																		cand.candidateType as
																			| "CREDIT_CARD_PURCHASE"
																			| "INCOME_RECEIPT",
																	);
																}
															}}
															disabled={isImportRowCandidate}
															data-testid={`candidate-${cand.candidateId}`}
														>
															<div className="candidate-header">
																<span className="candidate-type">
																	{cand.candidateType === "CREDIT_CARD_PURCHASE"
																		? "Mevcut Kart Harcaması"
																		: cand.candidateType === "INCOME_RECEIPT"
																			? "Mevcut Gelir Tahsilatı"
																			: "Aynı Dosyadaki Başka Bir Satır"}
																</span>
																<span className="candidate-reason">
																	{cand.reasonCode}
																</span>
															</div>

															{isImportRowCandidate ? (
																<p className="candidate-note">
																	Aynı dosyada benzer bir satır var. Önce o
																	satırın kararını tamamlayın.
																</p>
															) : (
																<span className="candidate-id">
																	ID: {cand.candidateId}
																</span>
															)}
														</button>
													);
												})}
											</div>
										) : (
											<p className="no-candidates-text">
												Bu satır için otomatik tespit edilen bir aday
												bulunmuyor.
											</p>
										)}

										<button
											type="button"
											className="btn btn-primary"
											disabled={
												!selectedCandidateId || resolveMutation.isPending
											}
											onClick={() =>
												submitDecision({
													expectedRevisionNo: row.latestRevisionNo,
													action: "LINK_EXISTING",
													linkTarget: {
														targetType: selectedCandidateType,
														targetId: selectedCandidateId,
													},
												})
											}
											data-testid="btn-submit-link-existing"
										>
											Seçili Kayda Bağla
										</button>
									</div>
								)}

								{/* TAB: SKIP */}
								{activeTab === "SKIP" && (
									<div className="tab-pane" data-testid="pane-skip-row">
										<p className="tab-description">
											Bu satırı içe aktarmadan atlamak istiyor musunuz? Finansal
											bir hareket oluşturulmayacaktır.
										</p>

										<div className="form-group">
											<label htmlFor="skip-note">
												Atlama Nedeni (İsteğe bağlı)
											</label>
											<input
												id="skip-note"
												type="text"
												maxLength={500}
												className="form-control"
												placeholder="Örn: Kişisel olmayan işlem"
												value={skipReasonNote}
												onChange={(e) => setSkipReasonNote(e.target.value)}
												data-testid="input-skip-note"
											/>
										</div>

										<button
											type="button"
											className="btn btn-danger"
											disabled={resolveMutation.isPending}
											onClick={() =>
												submitDecision({
													expectedRevisionNo: row.latestRevisionNo,
													action: "SKIP",
													reasonNote: skipReasonNote.trim()
														? skipReasonNote.trim()
														: null,
												})
											}
											data-testid="btn-submit-skip"
										>
											Satırı Atla
										</button>
									</div>
								)}
							</div>
						)}

						{errorMessage && (
							<div
								className="form-error-banner"
								role="alert"
								data-testid="resolver-error-banner"
							>
								<AlertCircle size={16} aria-hidden="true" />
								<span>{errorMessage}</span>
							</div>
						)}

						{isNetworkUncertain && frozenPayload && (
							<div className="network-uncertain-action-bar">
								<button
									type="button"
									className="btn btn-warning"
									onClick={handleRetryUncertain}
									disabled={resolveMutation.isPending}
									data-testid="btn-retry-resolver"
								>
									<RefreshCw
										size={16}
										className={resolveMutation.isPending ? "spin" : ""}
										aria-hidden="true"
									/>
									<span>Aynı Kararı Tekrar Gönder</span>
								</button>
							</div>
						)}
					</>
				)}

				<div className="modal-actions">
					<button
						type="button"
						className="btn btn-secondary"
						onClick={onClose}
						data-testid="btn-close-resolver"
					>
						Kapat
					</button>
				</div>
			</div>
		</AccessibleModal>
	);
}

function StatusBadge({ status }: { status: ImportRowStatus }) {
	switch (status) {
		case "READY":
			return <span className="status-badge ready">Hazır</span>;
		case "NEEDS_REVIEW":
			return <span className="status-badge review">İnceleme Gerekiyor</span>;
		case "POSSIBLE_DUPLICATE":
			return <span className="status-badge possible-dup">Olası Tekrar</span>;
		case "EXACT_DUPLICATE":
			return <span className="status-badge exact-dup">Aynı Kayıt</span>;
		case "APPLIED":
			return <span className="status-badge applied">Uygulandı</span>;
		case "LINKED_EXISTING":
			return <span className="status-badge linked">Bağlandı</span>;
		case "SKIPPED":
			return <span className="status-badge skipped">Atlandı</span>;
		case "UNSUPPORTED":
			return <span className="status-badge unsupported">Desteklenmiyor</span>;
	}
}

function CardPurchaseSummary({
	payload,
	occurredAt,
}: {
	payload: NormalizedCardPurchasePayload;
	occurredAt: string | null;
}) {
	return (
		<div className="payload-details">
			<div className="payload-row">
				<span className="label">Tarih:</span>
				<span className="value">
					{occurredAt ? formatIstanbulDateTime(occurredAt) : "Belirtilmemiş"}
				</span>
			</div>
			<div className="payload-row">
				<span className="label">Tutar:</span>
				<span className="value font-mono font-bold">₺{payload.amount}</span>
			</div>
			{payload.merchant && (
				<div className="payload-row">
					<span className="label">İşyeri:</span>
					<span className="value">{payload.merchant}</span>
				</div>
			)}
			{payload.description && (
				<div className="payload-row">
					<span className="label">Açıklama:</span>
					<span className="value">{payload.description}</span>
				</div>
			)}
		</div>
	);
}

function IncomeReceiptSummary({
	payload,
	occurredAt,
}: {
	payload: NormalizedIncomeReceiptPayload;
	occurredAt: string | null;
}) {
	return (
		<div className="payload-details">
			<div className="payload-row">
				<span className="label">Tarih:</span>
				<span className="value">
					{occurredAt ? formatIstanbulDateTime(occurredAt) : "Belirtilmemiş"}
				</span>
			</div>
			<div className="payload-row">
				<span className="label">Tutar:</span>
				<span className="value font-mono font-bold">₺{payload.amount}</span>
			</div>
			{payload.note && (
				<div className="payload-row">
					<span className="label">Not:</span>
					<span className="value">{payload.note}</span>
				</div>
			)}
		</div>
	);
}

function LoaderText() {
	return (
		<div className="loader-text-container">
			<RefreshCw size={20} className="spin" aria-hidden="true" />
			<span>Yükleniyor...</span>
		</div>
	);
}
