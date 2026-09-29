/**
 * Purchase Detail Page (/cards/$cardId/purchases/$purchaseId)
 *
 * Implements Section 31-38, 51-54:
 *   - Gross vs Personal vs External breakdown
 *   - Unshared lifecycle: edit / void via ordinary routes
 *   - Coordinated shared lifecycle: shared-revisions / shared-void
 *   - Attach split for unshared purchase
 *   - Navigation to split details
 */

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { ArrowLeft, Edit3, Trash2, Users } from "lucide-react";
import { useRef, useState } from "react";
import { mapCreditCardError } from "../../../api/credit-card-errors";
import {
	fetchCreditCard,
	fetchCreditCardPurchase,
	fetchPurchaseSplit,
	updateCreditCardPurchase,
	voidCreditCardPurchase,
	voidSharedCreditCardPurchase,
} from "../../../api/credit-cards-api";
import {
	formatIstanbulDateTimeLocal,
	parseIstanbulDateTimeLocalToIso,
} from "../../../lib/istanbul-date";
import { formatMoneyToTry } from "../../../lib/money";
import { AccessibleModal } from "../../common/AccessibleModal";
import { AttachSplitModal } from "./AttachSplitModal";

export interface PurchaseDetailPageProps {
	cardId: string;
	purchaseId: string;
}

export function PurchaseDetailPage({
	cardId,
	purchaseId,
}: PurchaseDetailPageProps) {
	const navigate = useNavigate();
	const queryClient = useQueryClient();

	const [isAttachSplitOpen, setIsAttachSplitOpen] = useState<boolean>(false);
	const [isVoidModalOpen, setIsVoidModalOpen] = useState<boolean>(false);
	const [voidReason, setVoidReason] = useState<string>("");
	const [isSubmittingVoid, setIsSubmittingVoid] = useState<boolean>(false);
	const [voidError, setVoidError] = useState<string | null>(null);

	const voidIdempotencyKeyRef = useRef<string>(crypto.randomUUID());

	const { data: cardData } = useQuery({
		queryKey: ["credit-card", cardId],
		queryFn: () => fetchCreditCard(cardId),
	});

	const {
		data: purchaseData,
		isLoading,
		error,
	} = useQuery({
		queryKey: ["card-purchase", cardId, purchaseId],
		queryFn: () => fetchCreditCardPurchase(cardId, purchaseId),
	});

	const purchase = purchaseData?.purchase;
	const card = cardData?.card;

	const { data: splitData } = useQuery({
		queryKey: ["purchase-split", cardId, purchaseId],
		queryFn: () => fetchPurchaseSplit(cardId, purchaseId),
		enabled: Boolean(purchase?.split && purchase.split.status === "ACTIVE"),
	});

	if (isLoading) {
		return (
			<div className="page-container" style={{ padding: "2rem" }}>
				<p style={{ color: "var(--color-text-muted)" }}>
					Harcama detayları yükleniyor...
				</p>
			</div>
		);
	}

	if (error || !purchase) {
		return (
			<div className="page-container" style={{ padding: "2rem" }}>
				<div className="error-alert" role="alert">
					Harcama bulunamadı veya yüklenirken bir hata oluştu.
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

	const hasActiveSplit = Boolean(
		purchase.split && purchase.split.status === "ACTIVE",
	);
	const isVoid = purchase.status === "VOID";

	const handleConfirmVoid = async (e: React.FormEvent) => {
		e.preventDefault();
		setIsSubmittingVoid(true);
		setVoidError(null);

		const occurredAtIso = parseIstanbulDateTimeLocalToIso(
			new Date().toISOString().slice(0, 16),
		);

		const targetPurchaseId =
			purchase.purchaseId ?? purchase.eventId ?? purchaseId ?? "";

		try {
			if (hasActiveSplit) {
				// Section 53: Atomic shared void
				await voidSharedCreditCardPurchase(
					cardId,
					targetPurchaseId,
					{
						expectedPurchaseRevisionNo: purchase.revisionNo,
						expectedSplitRevisionNo: splitData?.split.revisionNo ?? 1,
						reasonNote: voidReason.trim() || undefined,
						occurredAt: occurredAtIso,
					},
					voidIdempotencyKeyRef.current,
				);
			} else {
				// Section 37: Unshared void
				await voidCreditCardPurchase(
					cardId,
					targetPurchaseId,
					{
						expectedRevisionNo: purchase.revisionNo,
						reasonNote: voidReason.trim() || undefined,
						occurredAt: occurredAtIso,
					},
					voidIdempotencyKeyRef.current,
				);
			}

			await Promise.all([
				queryClient.invalidateQueries({ queryKey: ["card-purchases", cardId] }),
				queryClient.invalidateQueries({
					queryKey: ["card-purchase", cardId, purchaseId],
				}),
				queryClient.invalidateQueries({ queryKey: ["credit-card", cardId] }),
				queryClient.invalidateQueries({ queryKey: ["credit-cards"] }),
				queryClient.invalidateQueries({ queryKey: ["transactions"] }),
				queryClient.invalidateQueries({ queryKey: ["spending-summary"] }),
			]);

			setIsVoidModalOpen(false);
		} catch (err) {
			setVoidError(mapCreditCardError(err));
		} finally {
			setIsSubmittingVoid(false);
		}
	};

	return (
		<div className="page-container" data-testid="purchase-detail-page">
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
						{purchase.merchant || purchase.description || "Kart Harcaması"}
					</h1>

					<div style={{ display: "flex", gap: "0.5rem" }}>
						{!isVoid && (
							<>
								{!hasActiveSplit && (
									<button
										type="button"
										className="btn btn-secondary btn-sm"
										onClick={() => setIsAttachSplitOpen(true)}
										data-testid="attach-split-btn"
									>
										<Users size={16} aria-hidden="true" />
										<span>Ortak Harcamaya Dönüştür</span>
									</button>
								)}

								<button
									type="button"
									className="btn btn-danger btn-sm"
									onClick={() => setIsVoidModalOpen(true)}
									data-testid="void-purchase-btn"
								>
									<Trash2 size={16} aria-hidden="true" />
									<span>Harcamayı İptal Et</span>
								</button>
							</>
						)}
					</div>
				</div>
			</div>

			<div className="card" style={{ padding: "1.5rem" }}>
				<div
					style={{
						display: "flex",
						justifyContent: "space-between",
						alignItems: "center",
						borderBottom: "1px solid var(--color-border, #e2e8f0)",
						paddingBottom: "1rem",
						marginBottom: "1rem",
					}}
				>
					<div>
						<div
							style={{ fontSize: "0.85rem", color: "var(--color-text-muted)" }}
						>
							Toplam Kart Harcaması
						</div>
						<div
							style={{
								fontSize: "1.75rem",
								fontWeight: 700,
								color: isVoid
									? "var(--color-text-muted)"
									: "var(--color-text-main)",
								textDecoration: isVoid ? "line-through" : "none",
							}}
							data-testid="detail-gross-amount"
						>
							{formatMoneyToTry(purchase.amount)}
						</div>
					</div>

					<div>
						<span
							className={`badge badge-${purchase.status.toLowerCase()}`}
							data-testid="detail-purchase-status"
							style={{
								fontSize: "0.85rem",
								padding: "0.3rem 0.75rem",
								borderRadius: "6px",
								background: isVoid
									? "rgba(148, 163, 184, 0.2)"
									: "rgba(34, 197, 94, 0.15)",
								color: isVoid ? "#64748b" : "#16a34a",
								fontWeight: 600,
							}}
						>
							{isVoid ? "İptal Edildi" : "Aktif (Kaydedildi)"}
						</span>
					</div>
				</div>

				{/* Shared Split Details (Section 32) */}
				{hasActiveSplit && (
					<div
						className="shared-breakdown-card"
						style={{
							padding: "1rem",
							borderRadius: "6px",
							background: "rgba(99, 102, 241, 0.08)",
							border: "1px solid rgba(99, 102, 241, 0.2)",
							marginBottom: "1.25rem",
						}}
						data-testid="detail-shared-breakdown"
					>
						<div
							style={{
								display: "flex",
								justifyContent: "space-between",
								alignItems: "center",
								marginBottom: "0.75rem",
							}}
						>
							<div
								style={{
									display: "flex",
									alignItems: "center",
									gap: "0.5rem",
									color: "#4338ca",
									fontWeight: 600,
								}}
							>
								<Users size={18} aria-hidden="true" />
								<span>
									Ortak Harcama ({purchase.split?.participantCount} Kişi)
								</span>
							</div>

							<Link
								to="/cards/$cardId/purchases/$purchaseId/split"
								params={{
									cardId,
									purchaseId:
										purchase.eventId ?? purchase.purchaseId ?? purchaseId ?? "",
								}}
								className="btn btn-secondary btn-sm"
								data-testid="view-split-details-link"
							>
								Paylaşım Detayı
							</Link>
						</div>

						<div
							style={{
								display: "flex",
								justifyContent: "space-between",
								fontSize: "0.95rem",
							}}
						>
							<span>Senin Payın:</span>
							<strong data-testid="detail-personal-share">
								{formatMoneyToTry(purchase.personalExpenseAmount)}
							</strong>
						</div>

						<div
							style={{
								display: "flex",
								justifyContent: "space-between",
								fontSize: "0.95rem",
								marginTop: "0.35rem",
							}}
						>
							<span>Diğerlerinden Alacak:</span>
							<strong
								style={{ color: "#2563eb" }}
								data-testid="detail-external-receivable"
							>
								{formatMoneyToTry(purchase.externalReceivableAmount)}
							</strong>
						</div>
					</div>
				)}

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
							Tarih:
						</div>
						<strong>{purchase.purchaseDate}</strong>
					</div>

					{purchase.installmentCount && purchase.installmentCount > 1 && (
						<div>
							<div
								style={{
									fontSize: "0.85rem",
									color: "var(--color-text-muted)",
								}}
							>
								Taksit:
							</div>
							<strong data-testid="detail-installment-count">
								{purchase.installmentCount} Taksit
							</strong>
						</div>
					)}

					<div>
						<div
							style={{ fontSize: "0.85rem", color: "var(--color-text-muted)" }}
						>
							Banka / Kart:
						</div>
						<strong>{card?.displayName || "Kredi Kartı"}</strong>
					</div>

					{purchase.merchant && (
						<div>
							<div
								style={{
									fontSize: "0.85rem",
									color: "var(--color-text-muted)",
								}}
							>
								İşyeri:
							</div>
							<strong>{purchase.merchant}</strong>
						</div>
					)}
				</div>

				{purchase.description && (
					<div
						style={{
							marginTop: "1rem",
							borderTop: "1px solid var(--color-border, #e2e8f0)",
							paddingTop: "0.75rem",
							color: "var(--color-text-muted)",
						}}
					>
						<strong>Açıklama:</strong> {purchase.description}
					</div>
				)}
			</div>

			{/* Attach Split Modal */}
			{isAttachSplitOpen && (
				<AttachSplitModal
					isOpen={isAttachSplitOpen}
					cardId={cardId}
					purchase={purchase}
					onClose={() => setIsAttachSplitOpen(false)}
					onSuccess={() => setIsAttachSplitOpen(false)}
				/>
			)}

			{/* Void Modal */}
			{isVoidModalOpen && (
				<AccessibleModal
					isOpen={isVoidModalOpen}
					onClose={() => setIsVoidModalOpen(false)}
					title="Harcamayı İptal Et"
					description="Kart harcamasının iptal edilmesi"
				>
					<form onSubmit={handleConfirmVoid} noValidate>
						<p style={{ lineHeight: 1.5 }}>
							Bu kart harcaması iptal edilecektir.
							{hasActiveSplit
								? " Bu harcamaya bağlı ortak alacak kayıtları da otomatik olarak iptal edilecektir."
								: ""}
						</p>

						{voidError && (
							<div
								className="error-alert"
								role="alert"
								data-testid="void-purchase-error"
							>
								{voidError}
							</div>
						)}

						<div className="form-group">
							<label htmlFor="void-purchase-reason" className="form-label">
								İptal Nedeni (Opsiyonel)
							</label>
							<input
								id="void-purchase-reason"
								type="text"
								className="form-input"
								value={voidReason}
								onChange={(e) => setVoidReason(e.target.value)}
								placeholder="Hatalı işlem, iade vb."
								maxLength={500}
								data-testid="void-purchase-reason-input"
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
								onClick={() => setIsVoidModalOpen(false)}
								disabled={isSubmittingVoid}
							>
								Vazgeç
							</button>
							<button
								type="submit"
								className="btn btn-danger"
								disabled={isSubmittingVoid}
								data-testid="confirm-void-purchase-btn"
							>
								{isSubmittingVoid ? "İptal Ediliyor..." : "Harcamayı İptal Et"}
							</button>
						</div>
					</form>
				</AccessibleModal>
			)}
		</div>
	);
}
