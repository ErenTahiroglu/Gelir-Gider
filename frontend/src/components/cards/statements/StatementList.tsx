/**
 * Credit Card Statement List Component
 *
 * Implements Section 15 & 16:
 *   - Tabs: Açık (OPEN), Ödenmiş (PAID), İptal (VOID), Tümü (all)
 *   - Authoritative dates (statementDate, dueDate)
 *   - Opaque nextCursor pagination
 *   - Pay / Reopen / Void / Edit actions
 */

import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import { useState } from "react";
import { fetchCreditCardStatements } from "../../../api/credit-cards-api";
import type {
	CreditCardStatementItem,
	StatementStatus,
} from "../../../api/credit-cards-types";
import { formatMoneyToTry } from "../../../lib/money";
import { StatementPayModal } from "./StatementPayModal";
import { StatementReopenModal } from "./StatementReopenModal";
import { StatementVoidModal } from "./StatementVoidModal";

export interface StatementListProps {
	cardId: string;
	cardName?: string | undefined;
	onNewStatement?: () => void;
}

export function StatementList({
	cardId,
	cardName,
	onNewStatement,
}: StatementListProps) {
	const [activeTab, setActiveTab] = useState<"ALL" | StatementStatus>("OPEN");
	const [cursor, setCursor] = useState<string | null>(null);

	// Modals state
	const [payStatement, setPayStatement] =
		useState<CreditCardStatementItem | null>(null);
	const [reopenStatement, setReopenStatement] =
		useState<CreditCardStatementItem | null>(null);
	const [voidStatement, setVoidStatement] =
		useState<CreditCardStatementItem | null>(null);

	const statusFilter = activeTab === "ALL" ? undefined : activeTab;

	const { data, isLoading, error } = useQuery({
		queryKey: [
			"card-statements",
			cardId,
			{ status: statusFilter, after: cursor },
		],
		queryFn: () =>
			fetchCreditCardStatements(cardId, {
				status: statusFilter,
				limit: 20,
				after: cursor,
			}),
	});

	const statements = data?.statements ?? [];
	const nextCursor = data?.nextCursor ?? null;

	const handleTabChange = (tab: "ALL" | StatementStatus) => {
		setActiveTab(tab);
		setCursor(null);
	};

	return (
		<div className="statement-list-container" data-testid="statement-list">
			<div
				className="statement-list-header"
				style={{
					display: "flex",
					justifyContent: "space-between",
					alignItems: "center",
					marginBottom: "1rem",
				}}
			>
				<h3 style={{ margin: 0, fontSize: "1.1rem" }}>Ekstreler</h3>
				{onNewStatement ? (
					<button
						type="button"
						className="btn btn-primary btn-sm"
						onClick={onNewStatement}
						data-testid="new-statement-button"
					>
						<Plus size={16} aria-hidden="true" />
						<span>Yeni Ekstre</span>
					</button>
				) : (
					<Link
						to="/cards/$cardId/statements/new"
						params={{ cardId }}
						className="btn btn-primary btn-sm"
						data-testid="new-statement-link"
					>
						<Plus size={16} aria-hidden="true" />
						<span>Yeni Ekstre</span>
					</Link>
				)}
			</div>

			{/* Filter Tabs */}
			<div
				className="statement-tabs"
				role="tablist"
				aria-label="Ekstre Durum Filtreleri"
				style={{
					display: "flex",
					gap: "0.5rem",
					borderBottom: "1px solid var(--color-border, #e2e8f0)",
					paddingBottom: "0.5rem",
					marginBottom: "1rem",
				}}
			>
				{(
					[
						{ id: "OPEN", label: "Açık" },
						{ id: "PAID", label: "Ödenmiş" },
						{ id: "VOID", label: "İptal" },
						{ id: "ALL", label: "Tümü" },
					] as const
				).map((tab) => {
					const isActive = activeTab === tab.id;
					return (
						<button
							key={tab.id}
							type="button"
							role="tab"
							aria-selected={isActive}
							className={`tab-btn ${isActive ? "active" : ""}`}
							onClick={() => handleTabChange(tab.id)}
							data-testid={`statement-tab-${tab.id.toLowerCase()}`}
							style={{
								padding: "0.35rem 0.75rem",
								borderRadius: "6px",
								border: "none",
								background: isActive
									? "var(--color-primary, #2563eb)"
									: "transparent",
								color: isActive ? "#fff" : "var(--color-text-muted, #64748b)",
								fontWeight: isActive ? 600 : 400,
								cursor: "pointer",
							}}
						>
							{tab.label}
						</button>
					);
				})}
			</div>

			{/* Content */}
			{isLoading ? (
				<p style={{ color: "var(--color-text-muted)" }}>
					Ekstreler yükleniyor...
				</p>
			) : error ? (
				<div className="error-alert" role="alert">
					Ekstreler yüklenirken bir hata oluştu.
				</div>
			) : statements.length === 0 ? (
				<div
					className="empty-state"
					style={{
						padding: "2rem",
						textAlign: "center",
						color: "var(--color-text-muted, #64748b)",
					}}
					data-testid="no-statements-message"
				>
					Bu filtrelere uygun ekstre bulunamadı.
				</div>
			) : (
				<div
					className="statement-items"
					style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}
				>
					{statements.map((stmt) => {
						const isMidasFund = stmt.reservePlacement === "MIDAS_FUND";
						return (
							<div
								key={stmt.statementId}
								className="statement-card card"
								data-testid={`statement-item-${stmt.statementId}`}
								style={{
									padding: "1rem",
									borderRadius: "8px",
									border: "1px solid var(--color-border, #e2e8f0)",
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
											to="/cards/$cardId/statements/$statementId"
											params={{ cardId, statementId: stmt.statementId }}
											style={{
												fontWeight: 600,
												fontSize: "1.05rem",
												color: "inherit",
												textDecoration: "none",
											}}
										>
											{stmt.cycleYear}-
											{String(stmt.cycleMonth).padStart(2, "0")} Dönemi
										</Link>
										<div
											style={{
												fontSize: "0.85rem",
												color: "var(--color-text-muted, #64748b)",
												marginTop: "0.15rem",
											}}
										>
											Kesim: {stmt.statementDate} • Son Ödeme:{" "}
											<strong>{stmt.dueDate}</strong>
										</div>
									</div>

									<div style={{ textAlign: "right" }}>
										<div
											style={{
												fontWeight: 700,
												fontSize: "1.1rem",
												color: "var(--color-text-main, #1e293b)",
											}}
											data-testid="statement-item-amount"
										>
											{formatMoneyToTry(stmt.statementAmount)}
										</div>
										<span
											className={`badge badge-${stmt.status.toLowerCase()}`}
											data-testid={`statement-status-badge-${stmt.status.toLowerCase()}`}
											style={{
												display: "inline-block",
												marginTop: "0.25rem",
												fontSize: "0.75rem",
												padding: "0.15rem 0.5rem",
												borderRadius: "4px",
												fontWeight: 500,
												background:
													stmt.status === "OPEN"
														? "rgba(234, 179, 8, 0.15)"
														: stmt.status === "PAID"
															? "rgba(34, 197, 94, 0.15)"
															: "rgba(148, 163, 184, 0.2)",
												color:
													stmt.status === "OPEN"
														? "#ca8a04"
														: stmt.status === "PAID"
															? "#16a34a"
															: "#64748b",
											}}
										>
											{stmt.status === "OPEN"
												? "Açık"
												: stmt.status === "PAID"
													? "Ödendi"
													: "İptal Edildi"}
										</span>
									</div>
								</div>

								{/* Reserve Info */}
								<div
									style={{
										display: "flex",
										gap: "0.75rem",
										fontSize: "0.85rem",
										color: "var(--color-text-muted, #64748b)",
										borderTop: "1px solid var(--color-border, #e2e8f0)",
										paddingTop: "0.5rem",
										alignItems: "center",
									}}
								>
									<span>
										Ödeme: {isMidasFund ? "Kart Rezervi (Midas)" : "Midas Dışı"}
									</span>
									<span>•</span>
									<span>
										Rezerv:{" "}
										<strong
											style={{
												color: stmt.reserveSatisfied ? "#16a34a" : "#ca8a04",
											}}
										>
											{stmt.reserveSatisfied ? "Hazır" : "Eksik"}
										</strong>
									</span>
								</div>

								{/* Action Buttons */}
								<div
									style={{
										display: "flex",
										gap: "0.5rem",
										justifyContent: "flex-end",
										marginTop: "0.25rem",
									}}
								>
									{stmt.status === "OPEN" && (
										<>
											<button
												type="button"
												className="btn btn-secondary btn-sm"
												onClick={() => setVoidStatement(stmt)}
												data-testid={`void-statement-btn-${stmt.statementId}`}
											>
												İptal Et
											</button>
											<button
												type="button"
												className="btn btn-primary btn-sm"
												onClick={() => setPayStatement(stmt)}
												data-testid={`pay-statement-btn-${stmt.statementId}`}
											>
												Öde
											</button>
										</>
									)}

									{stmt.status === "PAID" && (
										<button
											type="button"
											className="btn btn-secondary btn-sm"
											onClick={() => setReopenStatement(stmt)}
											data-testid={`reopen-statement-btn-${stmt.statementId}`}
										>
											Ödemeyi Geri Aç
										</button>
									)}
								</div>
							</div>
						);
					})}
				</div>
			)}

			{/* Pagination */}
			{nextCursor && (
				<div style={{ marginTop: "1rem", textAlign: "center" }}>
					<button
						type="button"
						className="btn btn-secondary btn-sm"
						onClick={() => setCursor(nextCursor)}
						data-testid="statements-next-page"
					>
						Daha Fazla Ekstre Yükle
					</button>
				</div>
			)}

			{/* Modals */}
			{payStatement && (
				<StatementPayModal
					isOpen={Boolean(payStatement)}
					cardId={cardId}
					cardName={cardName}
					statement={payStatement}
					onClose={() => setPayStatement(null)}
				/>
			)}

			{reopenStatement && (
				<StatementReopenModal
					isOpen={Boolean(reopenStatement)}
					cardId={cardId}
					statement={reopenStatement}
					onClose={() => setReopenStatement(null)}
				/>
			)}

			{voidStatement && (
				<StatementVoidModal
					isOpen={Boolean(voidStatement)}
					cardId={cardId}
					statement={voidStatement}
					onClose={() => setVoidStatement(null)}
				/>
			)}
		</div>
	);
}
