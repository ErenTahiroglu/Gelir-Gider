/**
 * Split Detail Page (/cards/$cardId/purchases/$purchaseId/split)
 *
 * Implements Section 50, 52, 54:
 *   - Read: GET /credit-cards/:cardId/purchases/:purchaseId/split
 *   - Renders: Toplam, Senin Payın, Diğerlerinden Alacak
 *   - Participants table: person, share, settled, remaining, due date, status
 *   - Actions: Revise split, Void split
 *   - No F6 settlement buttons
 */

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowLeft, Edit3, Trash2, Users } from "lucide-react";
import { useRef, useState } from "react";
import { apiPost } from "../../../api/client";
import { mapCreditCardError } from "../../../api/credit-card-errors";
import {
	fetchCreditCard,
	fetchCreditCardPurchase,
	fetchPurchaseSplit,
} from "../../../api/credit-cards-api";
import { parseIstanbulDateTimeLocalToIso } from "../../../lib/istanbul-date";
import { formatMoneyToTry } from "../../../lib/money";
import { AccessibleModal } from "../../common/AccessibleModal";
import { ReviseSplitModal } from "./ReviseSplitModal";

export interface SplitDetailPageProps {
	cardId: string;
	purchaseId: string;
}

export function SplitDetailPage({ cardId, purchaseId }: SplitDetailPageProps) {
	const queryClient = useQueryClient();

	const [isReviseOpen, setIsReviseOpen] = useState<boolean>(false);
	const [isVoidOpen, setIsVoidOpen] = useState<boolean>(false);
	const [voidReason, setVoidReason] = useState<string>("");
	const [isSubmittingVoid, setIsSubmittingVoid] = useState<boolean>(false);
	const [voidError, setVoidError] = useState<string | null>(null);

	const voidIdempotencyKeyRef = useRef<string>(crypto.randomUUID());

	const { data: cardData } = useQuery({
		queryKey: ["credit-card", cardId],
		queryFn: () => fetchCreditCard(cardId),
	});

	const { data: purchaseData } = useQuery({
		queryKey: ["card-purchase", cardId, purchaseId],
		queryFn: () => fetchCreditCardPurchase(cardId, purchaseId),
	});

	const {
		data: splitData,
		isLoading,
		error,
	} = useQuery({
		queryKey: ["purchase-split", cardId, purchaseId],
		queryFn: () => fetchPurchaseSplit(cardId, purchaseId),
	});

	const card = cardData?.card;
	const purchase = purchaseData?.purchase;
	const split = splitData?.split;

	if (isLoading) {
		return (
			<div className="page-container" style={{ padding: "2rem" }}>
				<p style={{ color: "var(--color-text-muted)" }}>
					Paylaşım bilgileri yükleniyor...
				</p>
			</div>
		);
	}

	if (error || !split) {
		return (
			<div className="page-container" style={{ padding: "2rem" }}>
				<div className="error-alert" role="alert">
					Paylaşım detayları bulunamadı veya yüklenirken bir hata oluştu.
				</div>
				<Link
					to="/cards/$cardId/purchases/$purchaseId"
					params={{ cardId, purchaseId }}
					className="btn btn-secondary"
					style={{ marginTop: "1rem" }}
				>
					<ArrowLeft size={16} aria-hidden="true" />
					<span>Harcama Detayına Dön</span>
				</Link>
			</div>
		);
	}

	const isSplitActive = split.status === "ACTIVE";

	const handleConfirmVoidSplit = async (e: React.FormEvent) => {
		e.preventDefault();
		setIsSubmittingVoid(true);
		setVoidError(null);

		const occurredAtIso = parseIstanbulDateTimeLocalToIso(
			new Date().toISOString().slice(0, 16),
		);

		try {
			await apiPost(
				`/credit-cards/${encodeURIComponent(cardId)}/purchases/${encodeURIComponent(purchaseId)}/split/void`,
				{
					expectedRevisionNo: split.revisionNo,
					reasonNote: voidReason.trim() || undefined,
					occurredAt: occurredAtIso,
				},
				{
					headers: {
						"Idempotency-Key": voidIdempotencyKeyRef.current,
					},
				},
			);

			await Promise.all([
				queryClient.invalidateQueries({
					queryKey: ["purchase-split", cardId, purchaseId],
				}),
				queryClient.invalidateQueries({
					queryKey: ["card-purchase", cardId, purchaseId],
				}),
				queryClient.invalidateQueries({ queryKey: ["card-purchases", cardId] }),
				queryClient.invalidateQueries({ queryKey: ["credit-card", cardId] }),
			]);

			setIsVoidOpen(false);
		} catch (err) {
			setVoidError(mapCreditCardError(err));
		} finally {
			setIsSubmittingVoid(false);
		}
	};

	return (
		<div className="page-container" data-testid="split-detail-page">
			<div className="page-header" style={{ marginBottom: "1.5rem" }}>
				<Link
					to="/cards/$cardId/purchases/$purchaseId"
					params={{ cardId, purchaseId }}
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
					<span>Harcama Detayına Dön</span>
				</Link>

				<div
					style={{
						display: "flex",
						justifyContent: "space-between",
						alignItems: "center",
					}}
				>
					<div>
						<h1
							className="page-title"
							style={{
								margin: 0,
								display: "flex",
								alignItems: "center",
								gap: "0.5rem",
							}}
						>
							<Users size={24} aria-hidden="true" />
							<span>Ortak Harcama Paylaşımı</span>
						</h1>
						{card && (
							<p
								style={{
									margin: "0.25rem 0 0 0",
									color: "var(--color-text-muted, #64748b)",
									fontSize: "0.9rem",
								}}
							>
								{card.displayName} •{" "}
								{purchase?.merchant || purchase?.description || "Harcama"}
							</p>
						)}
					</div>

					<div style={{ display: "flex", gap: "0.5rem" }}>
						{isSplitActive && (
							<>
								<button
									type="button"
									className="btn btn-secondary btn-sm"
									onClick={() => setIsReviseOpen(true)}
									data-testid="revise-split-btn"
								>
									<Edit3 size={16} aria-hidden="true" />
									<span>Paylaşımı Düzenle</span>
								</button>
								<button
									type="button"
									className="btn btn-danger btn-sm"
									onClick={() => setIsVoidOpen(true)}
									data-testid="void-split-btn"
								>
									<Trash2 size={16} aria-hidden="true" />
									<span>Paylaşımı İptal Et</span>
								</button>
							</>
						)}
					</div>
				</div>
			</div>

			{/* Summary Card */}
			<div
				className="card"
				style={{
					padding: "1.5rem",
					display: "flex",
					flexDirection: "column",
					gap: "1.25rem",
					marginBottom: "1.5rem",
				}}
			>
				<div
					style={{
						display: "grid",
						gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
						gap: "1rem",
					}}
				>
					<div>
						<div
							style={{ fontSize: "0.85rem", color: "var(--color-text-muted)" }}
						>
							Toplam Kart Harcaması:
						</div>
						<div
							style={{ fontSize: "1.4rem", fontWeight: 700 }}
							data-testid="split-gross-amount"
						>
							{formatMoneyToTry(split.grossAmount)}
						</div>
					</div>

					<div>
						<div
							style={{ fontSize: "0.85rem", color: "var(--color-text-muted)" }}
						>
							Senin Payın:
						</div>
						<div
							style={{ fontSize: "1.4rem", fontWeight: 700, color: "#1e293b" }}
							data-testid="split-user-share"
						>
							{formatMoneyToTry(split.userShareAmount)}
						</div>
					</div>

					<div>
						<div
							style={{ fontSize: "0.85rem", color: "var(--color-text-muted)" }}
						>
							Diğerlerinden Alacak:
						</div>
						<div
							style={{ fontSize: "1.4rem", fontWeight: 700, color: "#2563eb" }}
							data-testid="split-external-share"
						>
							{formatMoneyToTry(split.externalShareAmount)}
						</div>
					</div>

					<div>
						<div
							style={{ fontSize: "0.85rem", color: "var(--color-text-muted)" }}
						>
							Paylaşım Yöntemi:
						</div>
						<strong data-testid="split-method-badge">
							{split.splitMethod === "EQUAL"
								? "Eşit Paylaşım"
								: split.splitMethod === "MANUAL"
									? "Belirlenen Tutarlarla"
									: "Oran / Ağırlıkla"}
						</strong>
					</div>
				</div>
			</div>

			{/* Participants Table */}
			<div className="card" style={{ padding: "1.5rem" }}>
				<h3 style={{ margin: "0 0 1rem 0", fontSize: "1.1rem" }}>
					Ortak Harcama Katılımcıları ({split.participants.length} Kişi)
				</h3>

				<div className="table-responsive">
					<table
						className="data-table"
						style={{ width: "100%", borderCollapse: "collapse" }}
						data-testid="split-participants-table"
					>
						<thead>
							<tr
								style={{
									borderBottom: "2px solid var(--color-border, #e2e8f0)",
									textAlign: "left",
								}}
							>
								<th style={{ padding: "0.75rem" }}>Kişi</th>
								<th style={{ padding: "0.75rem" }}>Pay Tutarı</th>
								<th style={{ padding: "0.75rem" }}>Tahsil Edilen</th>
								<th style={{ padding: "0.75rem" }}>Kalan Alacak</th>
								<th style={{ padding: "0.75rem" }}>Vade Tarihi</th>
								<th style={{ padding: "0.75rem" }}>Durum</th>
							</tr>
						</thead>
						<tbody>
							{split.participants.map((part) => (
								<tr
									key={part.personId}
									style={{
										borderBottom: "1px solid var(--color-border, #e2e8f0)",
									}}
									data-testid={`split-participant-row-${part.personId}`}
								>
									<td style={{ padding: "0.75rem", fontWeight: 500 }}>
										{part.displayName}
									</td>
									<td style={{ padding: "0.75rem", fontWeight: 600 }}>
										{formatMoneyToTry(part.shareAmount)}
									</td>
									<td style={{ padding: "0.75rem", color: "#16a34a" }}>
										{formatMoneyToTry(part.settledAmount ?? "0.00")}
									</td>
									<td
										style={{
											padding: "0.75rem",
											color: "#2563eb",
											fontWeight: 600,
										}}
									>
										{formatMoneyToTry(part.remainingAmount)}
									</td>
									<td
										style={{
											padding: "0.75rem",
											color: "var(--color-text-muted)",
										}}
									>
										{part.dueDate || "—"}
									</td>
									<td style={{ padding: "0.75rem" }}>
										<span
											className={`badge badge-${(part.settlementStatus ?? "PENDING").toLowerCase()}`}
											style={{
												fontSize: "0.75rem",
												padding: "0.2rem 0.5rem",
												borderRadius: "4px",
												fontWeight: 500,
												background:
													part.settlementStatus === "SETTLED"
														? "rgba(34, 197, 94, 0.15)"
														: part.settlementStatus === "PARTIALLY_SETTLED"
															? "rgba(234, 179, 8, 0.15)"
															: "rgba(148, 163, 184, 0.2)",
												color:
													part.settlementStatus === "SETTLED"
														? "#16a34a"
														: part.settlementStatus === "PARTIALLY_SETTLED"
															? "#ca8a04"
															: "#64748b",
											}}
										>
											{part.settlementStatus === "SETTLED"
												? "Tahsil Edildi"
												: part.settlementStatus === "PARTIALLY_SETTLED"
													? "Kısmi Tahsilat"
													: "Bekliyor"}
										</span>
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			</div>

			{/* Revise Modal */}
			{isReviseOpen && (
				<ReviseSplitModal
					isOpen={isReviseOpen}
					cardId={cardId}
					purchaseId={purchaseId}
					grossAmount={split.grossAmount}
					split={split}
					onClose={() => setIsReviseOpen(false)}
					onSuccess={() => setIsReviseOpen(false)}
				/>
			)}

			{/* Void Modal */}
			{isVoidOpen && (
				<AccessibleModal
					isOpen={isVoidOpen}
					onClose={() => setIsVoidOpen(false)}
					title="Paylaşımı İptal Et"
					description="Ortak harcama paylaşımını iptal etme"
				>
					<form onSubmit={handleConfirmVoidSplit} noValidate>
						<p style={{ lineHeight: 1.5 }}>
							Bu ortak harcama paylaşımı iptal edilecektir. Bağlı olan kişi
							alacak kayıtları da iptal edilir. Tahsilat yapılmış paylar varsa
							iptal işlemi engellenir.
						</p>

						{voidError && (
							<div
								className="error-alert"
								role="alert"
								data-testid="void-split-error"
							>
								{voidError}
							</div>
						)}

						<div className="form-group">
							<label htmlFor="void-split-reason" className="form-label">
								İptal Gerekçesi (Opsiyonel)
							</label>
							<input
								id="void-split-reason"
								type="text"
								className="form-input"
								value={voidReason}
								onChange={(e) => setVoidReason(e.target.value)}
								placeholder="Paylaşım iptali vb."
								maxLength={500}
								data-testid="void-split-reason-input"
							/>
						</div>

						<div
							className="modal-actions"
							style={{
								display: "flex",
								justifyContent: "flex-end",
								gap: "0.5rem",
								marginTop: "1.5rem",
							}}
						>
							<button
								type="button"
								className="btn btn-secondary"
								onClick={() => setIsVoidOpen(false)}
								disabled={isSubmittingVoid}
							>
								Vazgeç
							</button>
							<button
								type="submit"
								className="btn btn-danger"
								disabled={isSubmittingVoid}
								data-testid="confirm-void-split-btn"
							>
								{isSubmittingVoid ? "İptal Ediliyor..." : "Paylaşımı İptal Et"}
							</button>
						</div>
					</form>
				</AccessibleModal>
			)}
		</div>
	);
}
