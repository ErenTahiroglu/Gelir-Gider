/**
 * Transaction Detail Drawer & Revision History Component
 *
 * Adheres strictly to Section 18-21, 54, 55:
 *   - Route: /transactions/:transactionId
 *   - Fetch: GET /transactions/:transactionId
 *   - Revisions: GET /transactions/:transactionId/revisions?limit=50&beforeRevisionNo=
 *   - Pagination: "Daha Eski Değişiklikleri Yükle" cursor pagination
 *   - Responsive: right-side drawer on desktop, bottom sheet style on mobile
 *   - Manual expense actions: "Düzenle" and "Harcamayı İptal Et" ONLY for ACTIVE MANUAL_EXPENSE
 *   - Natural revision timeline: "Oluşturuldu", "Düzenlendi", "İptal Edildi"
 */

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Edit, RefreshCw, Trash2 } from "lucide-react";
import { useState } from "react";
import {
	fetchAllLedgerAccounts,
	fetchCategoryAssignment,
	fetchSpendingCategories,
	voidManualExpense,
} from "../../api/manual-expenses-api";
import {
	fetchTransactionDetail,
	fetchTransactionRevisions,
} from "../../api/transactions-api";
import type {
	TransactionDetailResponse,
	TransactionRevisionItem,
} from "../../api/transactions-types";
import { formatIstanbulDateTimeTurkish } from "../../lib/istanbul-date";
import { getTransactionDisplayModel } from "../../lib/transaction-display";
import { AccessibleModal } from "../common/AccessibleModal";
import { ManualExpenseVoidDialog } from "../manual-expenses/ManualExpenseVoidDialog";

export interface TransactionDetailDrawerProps {
	transactionId: string | null;
	isOpen: boolean;
	onClose: () => void;
}

export function TransactionDetailDrawer({
	transactionId,
	isOpen,
	onClose,
}: TransactionDetailDrawerProps) {
	const queryClient = useQueryClient();
	const navigate = useNavigate();

	// 1. Fetch transaction detail
	const {
		data: transaction,
		isLoading: detailLoading,
		error: detailError,
		refetch: refetchDetail,
	} = useQuery<TransactionDetailResponse>({
		queryKey: ["transaction", transactionId],
		queryFn: () => fetchTransactionDetail(transactionId!),
		enabled: isOpen && !!transactionId,
	});

	// 2. Fetch revision history with cursor
	const [revisionsList, setRevisionsList] = useState<TransactionRevisionItem[]>(
		[],
	);
	const [nextRevisionCursor, setNextRevisionCursor] = useState<number | null>(
		null,
	);
	const [revisionsLoading, setRevisionsLoading] = useState(false);

	const loadRevisions = async (txId: string, beforeRev?: number) => {
		setRevisionsLoading(true);
		try {
			const res = await fetchTransactionRevisions(
				txId,
				beforeRev !== undefined
					? { limit: 50, beforeRevisionNo: beforeRev }
					: { limit: 50 },
			);
			if (beforeRev !== undefined) {
				setRevisionsList((prev) => [...prev, ...res.revisions]);
			} else {
				setRevisionsList(res.revisions);
			}
			setNextRevisionCursor(res.nextCursor?.beforeRevisionNo ?? null);
		} catch {
			// Non-fatal for revisions
		} finally {
			setRevisionsLoading(false);
		}
	};

	// Reset revisions when transactionId changes
	useState(() => {
		if (transactionId && isOpen) {
			void loadRevisions(transactionId);
		}
	});

	// Also fetch supporting reference data for resolving labels
	const { data: accounts } = useQuery({
		queryKey: ["ledger-accounts"],
		queryFn: () => fetchAllLedgerAccounts(100),
		enabled: isOpen,
		staleTime: 60_000,
	});

	const { data: categoriesData } = useQuery({
		queryKey: ["spending-categories"],
		queryFn: fetchSpendingCategories,
		enabled: isOpen,
		staleTime: 60_000,
	});

	const { data: categoryAssign } = useQuery({
		queryKey: ["category-assignment", transactionId],
		queryFn: () => fetchCategoryAssignment(transactionId!),
		enabled:
			isOpen && !!transactionId && transaction?.kind === "MANUAL_EXPENSE",
	});

	// Void Dialog State
	const [isVoidDialogOpen, setIsVoidDialogOpen] = useState(false);
	const [isVoiding, setIsVoiding] = useState(false);
	const [voidError, setVoidError] = useState<string | null>(null);
	const [voidIdempotencyKey, setVoidIdempotencyKey] = useState<string | null>(
		null,
	);
	const [lastVoidReason, setLastVoidReason] = useState<string | undefined>(
		undefined,
	);

	if (!isOpen || !transactionId) return null;

	const display = transaction ? getTransactionDisplayModel(transaction) : null;

	// Resolve account and category names
	const sourceAccount = accounts?.find(
		(a) => a.accountId === display?.sourceAccountId,
	);
	const categoryId =
		display?.spendingCategoryId ??
		categoryAssign?.assignments?.[transactionId] ??
		categoryAssign?.assignment?.categoryId;
	const spendingCategory = categoriesData?.categories.find(
		(c) => c.id === categoryId,
	);

	// Financial classification label
	const getClassificationLabel = (bCat?: string) => {
		switch (bCat) {
			case "MANDATORY_EXPENSE":
				return "Zorunlu Temel İhtiyaç";
			case "DISCRETIONARY_SPEND":
				return "Keyfi / Esnek Harcama";
			case "SHORT_TERM_PURCHASE":
				return "Planlı Kısa Vadeli Alım";
			default:
				return bCat ?? "—";
		}
	};

	// Start Void Flow
	const handleOpenVoidDialog = () => {
		setVoidError(null);
		setVoidIdempotencyKey(crypto.randomUUID());
		setIsVoidDialogOpen(true);
	};

	const executeVoid = async (reason?: string) => {
		if (!transaction) return;
		setIsVoiding(true);
		setVoidError(null);
		setLastVoidReason(reason);

		try {
			const key = voidIdempotencyKey ?? crypto.randomUUID();
			const payload =
				reason !== undefined
					? { expectedRevisionNo: transaction.revisionNo, reason }
					: { expectedRevisionNo: transaction.revisionNo };

			await voidManualExpense(transaction.transactionId, payload, key);

			// Invalidate all affected queries per Section 49
			await Promise.all([
				queryClient.invalidateQueries({ queryKey: ["transactions"] }),
				queryClient.invalidateQueries({
					queryKey: ["transaction", transaction.transactionId],
				}),
				queryClient.invalidateQueries({
					queryKey: ["transaction-revisions", transaction.transactionId],
				}),
				queryClient.invalidateQueries({
					queryKey: ["manual-expense", transaction.transactionId],
				}),
				queryClient.invalidateQueries({ queryKey: ["ledger-accounts"] }),
				queryClient.invalidateQueries({ queryKey: ["spending-summary"] }),
			]);

			setIsVoidDialogOpen(false);
			await refetchDetail();
			await loadRevisions(transaction.transactionId);
		} catch {
			setVoidError(
				"İptal işlemi gerçekleştirilemedi veya ağ hatası oluştu. Lütfen tekrar deneyin.",
			);
		} finally {
			setIsVoiding(false);
		}
	};

	return (
		<>
			<AccessibleModal
				isOpen={isOpen}
				onClose={onClose}
				title="İşlem Ayrıntısı"
				variant="drawer-right"
				className="transaction-detail-drawer"
			>
				{detailLoading ? (
					<div className="drawer-loading" data-testid="detail-loading">
						<div
							className="skeleton"
							style={{ height: "48px", marginBottom: "16px" }}
						/>
						<div
							className="skeleton"
							style={{ height: "120px", marginBottom: "16px" }}
						/>
						<div className="skeleton" style={{ height: "200px" }} />
					</div>
				) : detailError || !transaction || !display ? (
					<div className="drawer-error" data-testid="detail-error">
						<p>İşlem ayrıntıları alınamadı.</p>
						<button
							type="button"
							onClick={() => refetchDetail()}
							className="btn btn-secondary btn-sm"
						>
							Tekrar Dene
						</button>
					</div>
				) : (
					<div className="detail-drawer-content" data-testid="detail-content">
						{/* Header Hero */}
						<div className="detail-hero">
							<div className="detail-type-badge">{display.typeLabel}</div>
							<h3 className="detail-title">{display.title}</h3>
							{display.amountFormatted && (
								<div
									className={`detail-amount tone-${display.amountTone} ${display.isVoided ? "amount-voided" : ""}`}
								>
									{display.amountFormatted}
								</div>
							)}
							{display.isVoided && (
								<div
									className="detail-status-voided-badge"
									data-testid="detail-voided-badge"
								>
									İptal Edildi
								</div>
							)}
						</div>

						{/* Details Grid */}
						<div className="detail-info-grid">
							<div className="info-row">
								<span className="info-label">Tarih</span>
								<span className="info-value">
									{formatIstanbulDateTimeTurkish(transaction.occurredAt)}
								</span>
							</div>

							<div className="info-row">
								<span className="info-label">Durum</span>
								<span className="info-value">
									{transaction.status === "ACTIVE" ? "Aktif" : "İptal Edildi"}
								</span>
							</div>

							{sourceAccount && (
								<div className="info-row">
									<span className="info-label">Ödeme Kaynağı</span>
									<span className="info-value">{sourceAccount.name}</span>
								</div>
							)}

							{spendingCategory && (
								<div className="info-row">
									<span className="info-label">Kategori</span>
									<span className="info-value">{spendingCategory.name}</span>
								</div>
							)}

							{display.budgetCategory && (
								<div className="info-row">
									<span className="info-label">Finansal Sınıf</span>
									<span className="info-value">
										{getClassificationLabel(display.budgetCategory)}
									</span>
								</div>
							)}

							{display.subtitle && (
								<div className="info-row">
									<span className="info-label">Açıklama</span>
									<span className="info-value">{display.subtitle}</span>
								</div>
							)}
						</div>

						{/* Action Buttons: Only for ACTIVE MANUAL_EXPENSE */}
						{transaction.kind === "MANUAL_EXPENSE" &&
							transaction.status === "ACTIVE" && (
								<div className="detail-actions" data-testid="detail-actions">
									<button
										type="button"
										onClick={() => {
											onClose();
											void navigate({
												to: "/manual-expenses/$expenseId/edit",
												params: { expenseId: transaction.transactionId },
											});
										}}
										className="btn btn-secondary"
										data-testid="detail-edit-btn"
									>
										<Edit size={16} aria-hidden="true" />
										Düzenle
									</button>
									<button
										type="button"
										onClick={handleOpenVoidDialog}
										className="btn btn-danger"
										data-testid="detail-void-btn"
									>
										<Trash2 size={16} aria-hidden="true" />
										Harcamayı İptal Et
									</button>
								</div>
							)}

						{/* Revision History Section */}
						<div className="detail-revisions-section">
							<div className="revisions-header">
								<h4>Değişiklik Geçmişi</h4>
								<button
									type="button"
									onClick={() => loadRevisions(transaction.transactionId)}
									disabled={revisionsLoading}
									className="btn-icon"
									aria-label="Geçmişi Yenile"
									title="Yenile"
								>
									<RefreshCw size={14} aria-hidden="true" />
								</button>
							</div>

							<div
								className="revisions-timeline"
								data-testid="revisions-timeline"
							>
								{revisionsList.map((rev) => {
									const opLabel =
										rev.operation === "CREATE"
											? "Oluşturuldu"
											: rev.operation === "UPDATE"
												? "Düzenlendi"
												: "İptal Edildi";

									return (
										<div
											key={rev.revisionNo}
											className={`revision-item rev-op-${rev.operation.toLowerCase()}`}
											data-testid="revision-item"
										>
											<div className="revision-dot" aria-hidden="true" />
											<div className="revision-content">
												<div className="revision-title-row">
													<span className="revision-operation">{opLabel}</span>
													<span className="revision-time">
														{formatIstanbulDateTimeTurkish(rev.occurredAt)}
													</span>
												</div>
												{rev.reasonNote && (
													<p className="revision-note">{rev.reasonNote}</p>
												)}
											</div>
										</div>
									);
								})}
							</div>

							{nextRevisionCursor !== null && (
								<button
									type="button"
									onClick={() =>
										loadRevisions(transaction.transactionId, nextRevisionCursor)
									}
									disabled={revisionsLoading}
									className="btn btn-secondary btn-sm load-more-revisions-btn"
									data-testid="load-more-revisions-btn"
								>
									{revisionsLoading
										? "Yükleniyor..."
										: "Daha Eski Değişiklikleri Yükle"}
								</button>
							)}
						</div>
					</div>
				)}
			</AccessibleModal>

			{/* Void Confirmation Dialog */}
			<ManualExpenseVoidDialog
				isOpen={isVoidDialogOpen}
				onClose={() => setIsVoidDialogOpen(false)}
				onConfirmVoid={executeVoid}
				isPending={isVoiding}
				errorMessage={voidError}
				onRetry={() => executeVoid(lastVoidReason)}
			/>
		</>
	);
}
