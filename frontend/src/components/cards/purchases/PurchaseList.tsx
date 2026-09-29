/**
 * Credit Card Purchase List Component
 *
 * Implements Section 31-33:
 *   - GET /credit-cards/:cardId/purchases?limit=50 (opaque cursor)
 *   - Gross vs Personal amounts:
 *       Toplam Kart Harcaması = amount
 *       Senin Payın = personalExpenseAmount
 *       Diğerlerinden Alacak = externalReceivableAmount
 *   - Status: POSTED (active) vs VOID (İptal Edildi)
 *   - Never deletes void row from UI
 */

import { useInfiniteQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Plus, Users } from "lucide-react";
import { fetchCreditCardPurchases } from "../../../api/credit-cards-api";
import type { CreditCardPurchaseItem } from "../../../api/credit-cards-types";
import { formatMoneyToTry } from "../../../lib/money";

export interface PurchaseListProps {
	cardId: string;
	cardName?: string | undefined;
	onNewPurchase?: () => void;
}

export function PurchaseList({
	cardId,
	cardName,
	onNewPurchase,
}: PurchaseListProps) {
	const {
		data,
		isLoading,
		error,
		fetchNextPage,
		hasNextPage,
		isFetchingNextPage,
	} = useInfiniteQuery({
		queryKey: ["card-purchases", cardId],
		queryFn: ({ pageParam }) =>
			fetchCreditCardPurchases(cardId, {
				limit: 50,
				after: pageParam ?? null,
			}),
		initialPageParam: null as string | null,
		getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
	});

	const purchases: CreditCardPurchaseItem[] =
		data?.pages.flatMap((page) => page.purchases) ?? [];

	return (
		<div className="purchase-list-container" data-testid="purchase-list">
			<div
				className="purchase-list-header"
				style={{
					display: "flex",
					justifyContent: "space-between",
					alignItems: "center",
					marginBottom: "1rem",
				}}
			>
				<h3 style={{ margin: 0, fontSize: "1.1rem" }}>Kart Harcamaları</h3>
				{onNewPurchase ? (
					<button
						type="button"
						className="btn btn-primary btn-sm"
						onClick={onNewPurchase}
						data-testid="new-purchase-button"
					>
						<Plus size={16} aria-hidden="true" />
						<span>Yeni Harcama</span>
					</button>
				) : (
					<Link
						to="/cards/$cardId/purchases/new"
						params={{ cardId }}
						className="btn btn-primary btn-sm"
						data-testid="new-purchase-link"
					>
						<Plus size={16} aria-hidden="true" />
						<span>Yeni Harcama</span>
					</Link>
				)}
			</div>

			{isLoading ? (
				<p style={{ color: "var(--color-text-muted)" }}>
					Harcamalar yükleniyor...
				</p>
			) : error ? (
				<div className="error-alert" role="alert">
					Harcamalar yüklenirken bir hata oluştu.
				</div>
			) : purchases.length === 0 ? (
				<div
					className="empty-state"
					style={{
						padding: "2rem",
						textAlign: "center",
						color: "var(--color-text-muted, #64748b)",
					}}
					data-testid="no-purchases-message"
				>
					Bu kart için henüz harcama kaydı bulunmuyor.
				</div>
			) : (
				<div
					className="purchase-items"
					style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}
				>
					{purchases.map((purchase) => {
						const isShared = Boolean(
							purchase.split && purchase.split.status === "ACTIVE",
						);
						const isVoid = purchase.status === "VOID";

						const pid = purchase.purchaseId ?? purchase.eventId ?? "";
						return (
							<div
								key={pid}
								className={`purchase-card card ${isVoid ? "is-void" : ""}`}
								data-testid={`purchase-item-${pid}`}
								style={{
									padding: "1rem",
									borderRadius: "8px",
									border: "1px solid var(--color-border, #e2e8f0)",
									opacity: isVoid ? 0.75 : 1,
									background: isVoid
										? "var(--color-bg-secondary, #f8fafc)"
										: "var(--color-bg-surface, #ffffff)",
									display: "flex",
									flexDirection: "column",
									gap: "0.5rem",
								}}
							>
								<div
									style={{
										display: "flex",
										justifyContent: "space-between",
										alignItems: "flex-start",
									}}
								>
									<div>
										<Link
											to="/cards/$cardId/purchases/$purchaseId"
											params={{ cardId, purchaseId: pid }}
											style={{
												fontWeight: 600,
												fontSize: "1rem",
												color: "inherit",
												textDecoration: isVoid ? "line-through" : "none",
											}}
										>
											{purchase.merchant ||
												purchase.description ||
												"Kart Harcaması"}
										</Link>

										<div
											style={{
												fontSize: "0.85rem",
												color: "var(--color-text-muted, #64748b)",
												marginTop: "0.15rem",
											}}
										>
											{purchase.purchaseDate}
											{purchase.installmentCount &&
											purchase.installmentCount > 1
												? ` • ${purchase.installmentCount} Taksit`
												: ""}
											{purchase.description && purchase.merchant
												? ` • ${purchase.description}`
												: ""}
										</div>
									</div>

									<div style={{ textAlign: "right" }}>
										<div
											style={{
												fontWeight: 700,
												fontSize: "1.05rem",
												color: isVoid
													? "var(--color-text-muted, #64748b)"
													: "var(--color-text-main, #1e293b)",
												textDecoration: isVoid ? "line-through" : "none",
											}}
											data-testid="purchase-gross-amount"
										>
											{formatMoneyToTry(purchase.amount)}
										</div>

										{isVoid ? (
											<span
												className="badge badge-void"
												data-testid="purchase-status-void"
												style={{
													fontSize: "0.75rem",
													padding: "0.15rem 0.5rem",
													borderRadius: "4px",
													background: "rgba(148, 163, 184, 0.2)",
													color: "#64748b",
													fontWeight: 500,
												}}
											>
												İptal Edildi
											</span>
										) : isShared ? (
											<Link
												to="/cards/$cardId/purchases/$purchaseId/split"
												params={{ cardId, purchaseId: pid }}
												className="badge badge-shared"
												data-testid="purchase-split-badge"
												style={{
													display: "inline-flex",
													alignItems: "center",
													gap: "0.25rem",
													fontSize: "0.75rem",
													padding: "0.15rem 0.5rem",
													borderRadius: "4px",
													background: "rgba(99, 102, 241, 0.15)",
													color: "#4f46e5",
													fontWeight: 500,
													textDecoration: "none",
												}}
											>
												<Users size={12} aria-hidden="true" />
												<span>Ortak Harcama</span>
											</Link>
										) : null}
									</div>
								</div>

								{/* Shared Split Breakdown (Section 32) */}
								{isShared && (
									<div
										style={{
											display: "flex",
											justifyContent: "space-between",
											fontSize: "0.85rem",
											borderTop: "1px dashed var(--color-border, #e2e8f0)",
											paddingTop: "0.4rem",
											marginTop: "0.25rem",
											color: "var(--color-text-muted, #64748b)",
										}}
										data-testid="purchase-split-breakdown"
									>
										<span>
											Senin Payın:{" "}
											<strong
												style={{ color: "var(--color-text-main, #1e293b)" }}
												data-testid="purchase-personal-share"
											>
												{formatMoneyToTry(purchase.personalExpenseAmount)}
											</strong>
										</span>
										<span>
											Diğerlerinden Alacak:{" "}
											<strong
												style={{ color: "#2563eb" }}
												data-testid="purchase-external-receivable"
											>
												{formatMoneyToTry(purchase.externalReceivableAmount)}
											</strong>
										</span>
									</div>
								)}
							</div>
						);
					})}

					{hasNextPage && (
						<div style={{ marginTop: "1rem", textAlign: "center" }}>
							<button
								type="button"
								className="btn btn-secondary btn-sm"
								onClick={() => void fetchNextPage()}
								disabled={isFetchingNextPage}
								data-testid="purchases-next-page"
							>
								{isFetchingNextPage ? "Yükleniyor..." : "Daha Fazla Harcama"}
							</button>
						</div>
					)}
				</div>
			)}
		</div>
	);
}
