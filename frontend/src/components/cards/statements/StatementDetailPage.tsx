/**
 * Statement Detail Page
 *
 * Implements Section 20-30:
 *   - Authoritative dates (statementDate, dueDate)
 *   - Readiness inspection: liabilityCoverage vs reserveSatisfied (Section 21-22)
 *   - Actions: Pay (OPEN), Edit (OPEN), Void (OPEN), Reopen (PAID)
 */

import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { ArrowLeft, Edit3 } from "lucide-react";
import { useState } from "react";
import {
	fetchCreditCard,
	fetchCreditCardStatement,
	fetchStatementReadiness,
} from "../../../api/credit-cards-api";
import { formatMoneyToTry } from "../../../lib/money";
import { StatementForm } from "./StatementForm";
import { StatementPayModal } from "./StatementPayModal";
import { StatementReopenModal } from "./StatementReopenModal";
import { StatementVoidModal } from "./StatementVoidModal";

export interface StatementDetailPageProps {
	cardId: string;
	statementId: string;
}

export function StatementDetailPage({
	cardId,
	statementId,
}: StatementDetailPageProps) {
	const navigate = useNavigate();

	const [isEditing, setIsEditing] = useState<boolean>(false);
	const [isPayOpen, setIsPayOpen] = useState<boolean>(false);
	const [isReopenOpen, setIsReopenOpen] = useState<boolean>(false);
	const [isVoidOpen, setIsVoidOpen] = useState<boolean>(false);

	const { data: cardData } = useQuery({
		queryKey: ["credit-card", cardId],
		queryFn: () => fetchCreditCard(cardId),
	});

	const {
		data: statementData,
		isLoading: statementLoading,
		error: statementError,
	} = useQuery({
		queryKey: ["statement", cardId, statementId],
		queryFn: () => fetchCreditCardStatement(cardId, statementId),
	});

	const statement = statementData?.statement;

	const { data: readinessData, isLoading: readinessLoading } = useQuery({
		queryKey: ["statement-readiness", cardId, statementId],
		queryFn: () => fetchStatementReadiness(cardId, statementId),
		enabled: Boolean(statement && statement.status === "OPEN"),
	});

	const card = cardData?.card;
	const readiness = readinessData?.readiness;

	if (statementLoading) {
		return (
			<div className="page-container" style={{ padding: "2rem" }}>
				<p style={{ color: "var(--color-text-muted)" }}>
					Ekstre bilgileri yükleniyor...
				</p>
			</div>
		);
	}

	if (statementError || !statement) {
		return (
			<div className="page-container" style={{ padding: "2rem" }}>
				<div className="error-alert" role="alert">
					Ekstre bulunamadı veya yüklenirken bir hata oluştu.
				</div>
				<Link
					to="/cards/$cardId"
					params={{ cardId }}
					className="btn btn-secondary"
					style={{ marginTop: "1rem" }}
				>
					<ArrowLeft size={16} aria-hidden="true" />
					<span>Karta Geri Dön</span>
				</Link>
			</div>
		);
	}

	const isMidasFund = statement.reservePlacement === "MIDAS_FUND";
	const isReserveSatisfied = statement.reserveSatisfied;

	return (
		<div className="page-container" data-testid="statement-detail-page">
			<div className="page-header" style={{ marginBottom: "1.5rem" }}>
				<Link
					to="/cards/$cardId"
					params={{ cardId }}
					className="btn-back"
					style={{
						display: "inline-flex",
						alignItems: "center",
						gap: "0.5rem",
						color: "var(--color-text-muted, #64748b)",
						textDecoration: "none",
						marginBottom: "0.75rem",
						fontSize: "0.9rem",
					}}
				>
					<ArrowLeft size={16} aria-hidden="true" />
					<span>{card?.displayName || "Kredi Kartı"} Detayına Dön</span>
				</Link>

				<div
					style={{
						display: "flex",
						justifyContent: "space-between",
						alignItems: "center",
					}}
				>
					<h1 className="page-title" style={{ margin: 0 }}>
						{statement.cycleYear}-
						{String(statement.cycleMonth).padStart(2, "0")} Dönemi Ekstresi
					</h1>

					<div style={{ display: "flex", gap: "0.5rem" }}>
						{statement.status === "OPEN" && !isEditing && (
							<button
								type="button"
								className="btn btn-secondary btn-sm"
								onClick={() => setIsEditing(true)}
								data-testid="edit-statement-btn"
							>
								<Edit3 size={16} aria-hidden="true" />
								<span>Düzenle</span>
							</button>
						)}
					</div>
				</div>
			</div>

			{isEditing ? (
				<div className="card" style={{ padding: "1.5rem", maxWidth: "600px" }}>
					<h2
						style={{ fontSize: "1.2rem", marginTop: 0, marginBottom: "1rem" }}
					>
						Ekstreyi Düzenle
					</h2>
					<StatementForm
						mode="edit"
						cardId={cardId}
						statementId={statementId}
						statement={statement}
						onSuccess={() => setIsEditing(false)}
						onCancel={() => setIsEditing(false)}
					/>
				</div>
			) : (
				<div
					style={{ display: "flex", flexDirection: "column", gap: "1.5rem" }}
				>
					{/* Main Info Card */}
					<div
						className="card"
						style={{
							padding: "1.5rem",
							display: "flex",
							flexDirection: "column",
							gap: "1rem",
						}}
					>
						<div
							style={{
								display: "flex",
								justifyContent: "space-between",
								alignItems: "center",
								flexWrap: "wrap",
								gap: "1rem",
								borderBottom: "1px solid var(--color-border, #e2e8f0)",
								paddingBottom: "1rem",
							}}
						>
							<div>
								<div
									style={{
										fontSize: "0.85rem",
										color: "var(--color-text-muted, #64748b)",
									}}
								>
									Ekstre Tutarı
								</div>
								<div
									style={{
										fontSize: "1.75rem",
										fontWeight: 700,
										color: "var(--color-text-main, #1e293b)",
									}}
									data-testid="statement-detail-amount"
								>
									{formatMoneyToTry(statement.statementAmount)}
								</div>
							</div>

							<div>
								<span
									className={`badge badge-${statement.status.toLowerCase()}`}
									data-testid="statement-detail-status-badge"
									style={{
										fontSize: "0.9rem",
										padding: "0.35rem 0.85rem",
										borderRadius: "6px",
										fontWeight: 600,
										background:
											statement.status === "OPEN"
												? "rgba(234, 179, 8, 0.15)"
												: statement.status === "PAID"
													? "rgba(34, 197, 94, 0.15)"
													: "rgba(148, 163, 184, 0.2)",
										color:
											statement.status === "OPEN"
												? "#ca8a04"
												: statement.status === "PAID"
													? "#16a34a"
													: "#64748b",
									}}
								>
									{statement.status === "OPEN"
										? "Açık"
										: statement.status === "PAID"
											? "Ödendi"
											: "İptal Edildi"}
								</span>
							</div>
						</div>

						{/* Dates (Authoritative server dates, Section 16) */}
						<div
							style={{
								display: "grid",
								gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
								gap: "1rem",
							}}
						>
							<div>
								<div
									style={{
										fontSize: "0.85rem",
										color: "var(--color-text-muted)",
									}}
								>
									Hesap Kesim Tarihi:
								</div>
								<strong data-testid="statement-detail-date">
									{statement.statementDate}
								</strong>
							</div>

							<div>
								<div
									style={{
										fontSize: "0.85rem",
										color: "var(--color-text-muted)",
									}}
								>
									Son Ödeme Tarihi:
								</div>
								<strong data-testid="statement-detail-due-date">
									{statement.dueDate}
								</strong>
							</div>

							<div>
								<div
									style={{
										fontSize: "0.85rem",
										color: "var(--color-text-muted)",
									}}
								>
									Ödeme Kaynağı:
								</div>
								<strong>
									{isMidasFund ? "Kart Rezervi (Midas)" : "Midas Dışı Ödeme"}
								</strong>
							</div>

							<div>
								<div
									style={{
										fontSize: "0.85rem",
										color: "var(--color-text-muted)",
									}}
								>
									Kart Rezervi Durumu:
								</div>
								<strong
									style={{
										color: isReserveSatisfied ? "#16a34a" : "#ca8a04",
									}}
									data-testid="statement-detail-reserve-status"
								>
									{isReserveSatisfied ? "Hazır" : "Eksik"}
								</strong>
							</div>
						</div>

						{statement.note && (
							<div
								style={{
									borderTop: "1px solid var(--color-border, #e2e8f0)",
									paddingTop: "0.75rem",
									fontSize: "0.9rem",
									color: "var(--color-text-muted)",
								}}
							>
								<strong>Not:</strong> {statement.note}
							</div>
						)}
					</div>

					{/* Readiness & Payment Inspection Card (Section 21-22) */}
					{statement.status === "OPEN" && (
						<div
							className="card"
							style={{
								padding: "1.5rem",
								border: "1px solid var(--color-border, #e2e8f0)",
							}}
							data-testid="statement-detail-readiness"
						>
							<h3 style={{ margin: "0 0 1rem 0", fontSize: "1.1rem" }}>
								Ödeme Hazırlık Analizi
							</h3>

							{readinessLoading ? (
								<p style={{ color: "var(--color-text-muted)" }}>
									Ödeme hazırlığı denetleniyor...
								</p>
							) : readiness ? (
								<div
									style={{
										display: "flex",
										flexDirection: "column",
										gap: "0.75rem",
									}}
								>
									<div
										style={{
											display: "flex",
											justifyContent: "space-between",
											padding: "0.5rem 0",
											borderBottom: "1px solid var(--color-border, #f1f5f9)",
										}}
									>
										<span>Kart Güncel Borcu:</span>
										<strong>
											{formatMoneyToTry(readiness.cardLiabilityBalance)}
										</strong>
									</div>

									<div
										style={{
											display: "flex",
											justifyContent: "space-between",
											alignItems: "center",
											padding: "0.5rem 0",
											borderBottom: "1px solid var(--color-border, #f1f5f9)",
										}}
									>
										<span>Kart Yükümlülüğü Yeterliliği:</span>
										<span
											className={`badge ${readiness.liabilityCoverage === "READY" ? "badge-success" : "badge-danger"}`}
											data-testid="detail-liability-coverage"
											style={{
												padding: "0.2rem 0.6rem",
												borderRadius: "4px",
												fontWeight: 500,
												background:
													readiness.liabilityCoverage === "READY"
														? "rgba(34, 197, 94, 0.15)"
														: "rgba(239, 68, 68, 0.15)",
												color:
													readiness.liabilityCoverage === "READY"
														? "#16a34a"
														: "#dc2626",
											}}
										>
											{readiness.liabilityCoverage === "READY"
												? "Hazır"
												: "Yetersiz"}
										</span>
									</div>

									<div
										style={{
											display: "flex",
											justifyContent: "space-between",
											alignItems: "center",
											padding: "0.5rem 0",
										}}
									>
										<span>
											Kart Rezervi ({isMidasFund ? "Midas" : "Midas Dışı"}):
										</span>
										<span
											className={`badge ${isReserveSatisfied ? "badge-success" : "badge-warning"}`}
											data-testid="detail-reserve-status"
											style={{
												padding: "0.2rem 0.6rem",
												borderRadius: "4px",
												fontWeight: 500,
												background: isReserveSatisfied
													? "rgba(34, 197, 94, 0.15)"
													: "rgba(234, 179, 8, 0.15)",
												color: isReserveSatisfied ? "#16a34a" : "#ca8a04",
											}}
										>
											{isReserveSatisfied ? "Hazır" : "Eksik"}
										</span>
									</div>

									{readiness.liabilityCoverage === "SHORTFALL" && (
										<div
											className="error-alert"
											style={{ marginTop: "0.5rem" }}
											data-testid="detail-liability-shortfall-alert"
										>
											Kart yükümlülüğü ekstre tutarını karşılamıyor.
										</div>
									)}

									{isMidasFund && !isReserveSatisfied && (
										<div
											className="warning-alert"
											style={{
												marginTop: "0.5rem",
												padding: "0.75rem",
												borderRadius: "6px",
												background: "rgba(234, 179, 8, 0.15)",
												color: "#ca8a04",
											}}
											data-testid="detail-reserve-shortfall-alert"
										>
											Kart Rezervi tutarı ekstre için eksik kalmaktadır.
										</div>
									)}
								</div>
							) : null}

							{/* Actions */}
							<div
								style={{
									display: "flex",
									gap: "0.75rem",
									justifyContent: "flex-end",
									marginTop: "1.5rem",
									borderTop: "1px solid var(--color-border, #e2e8f0)",
									paddingTop: "1rem",
								}}
							>
								<button
									type="button"
									className="btn btn-secondary"
									onClick={() => setIsVoidOpen(true)}
									data-testid="detail-void-btn"
								>
									Ekstreyi İptal Et
								</button>
								<button
									type="button"
									className="btn btn-primary"
									disabled={readiness?.liabilityCoverage === "SHORTFALL"}
									onClick={() => setIsPayOpen(true)}
									data-testid="detail-pay-btn"
								>
									Ekstreyi Öde
								</button>
							</div>
						</div>
					)}

					{/* Reopen Action for PAID Statements (Section 30) */}
					{statement.status === "PAID" && (
						<div
							className="card"
							style={{
								padding: "1.5rem",
								display: "flex",
								justifyContent: "space-between",
								alignItems: "center",
							}}
						>
							<div>
								<h3 style={{ margin: "0 0 0.25rem 0", fontSize: "1.05rem" }}>
									Ödeme Geri Açma
								</h3>
								<p
									style={{
										margin: 0,
										fontSize: "0.85rem",
										color: "var(--color-text-muted, #64748b)",
									}}
								>
									Ödenmiş olan bu ekstrenin ödeme kaydını tersine çevirerek
									yeniden açık duruma getirebilirsiniz.
								</p>
							</div>
							<button
								type="button"
								className="btn btn-secondary"
								onClick={() => setIsReopenOpen(true)}
								data-testid="detail-reopen-btn"
							>
								Ödemeyi Geri Aç
							</button>
						</div>
					)}
				</div>
			)}

			{/* Action Modals */}
			{isPayOpen && (
				<StatementPayModal
					isOpen={isPayOpen}
					cardId={cardId}
					cardName={card?.displayName}
					statement={statement}
					onClose={() => setIsPayOpen(false)}
					onSuccess={() => setIsPayOpen(false)}
				/>
			)}

			{isReopenOpen && (
				<StatementReopenModal
					isOpen={isReopenOpen}
					cardId={cardId}
					statement={statement}
					onClose={() => setIsReopenOpen(false)}
					onSuccess={() => setIsReopenOpen(false)}
				/>
			)}

			{isVoidOpen && (
				<StatementVoidModal
					isOpen={isVoidOpen}
					cardId={cardId}
					statement={statement}
					onClose={() => setIsVoidOpen(false)}
					onSuccess={() =>
						void navigate({ to: "/cards/$cardId", params: { cardId } })
					}
				/>
			)}
		</div>
	);
}
