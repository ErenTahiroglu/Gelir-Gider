/**
 * Credit Card Statement Payment Modal
 *
 * Implements Section 21-29:
 *   - Readiness inspection: liabilityCoverage vs reserveSatisfied
 *   - MIDAS_FUND: one-tap payment, no outside asset selector
 *   - OUTSIDE_MIDAS: asset selector required (excludes Midas ledgerAccountId, TRY/ASSET/DEBIT/active only)
 *   - Idempotency & Network uncertainty retry: same key, same payload
 *   - Authoritative invalidation
 */

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { mapCreditCardError } from "../../../api/credit-card-errors";
import {
	fetchMidasLiquidity,
	fetchStatementReadiness,
	payCreditCardStatement,
} from "../../../api/credit-cards-api";
import type {
	CreditCardStatementItem,
	PayStatementPayload,
} from "../../../api/credit-cards-types";
import { ApiError } from "../../../api/errors";
import { fetchAllLedgerAccounts } from "../../../api/manual-expenses-api";
import type { LedgerAccountItem } from "../../../api/manual-expenses-types";
import {
	formatIstanbulDateTimeLocal,
	parseIstanbulDateTimeLocalToIso,
} from "../../../lib/istanbul-date";
import { formatMoneyToTry } from "../../../lib/money";
import { AccessibleModal } from "../../common/AccessibleModal";

export interface StatementPayModalProps {
	isOpen: boolean;
	cardId: string;
	cardName?: string | undefined;
	statement: CreditCardStatementItem;
	onClose: () => void;
	onSuccess?: () => void;
}

export function StatementPayModal({
	isOpen,
	cardId,
	cardName,
	statement,
	onClose,
	onSuccess,
}: StatementPayModalProps) {
	const queryClient = useQueryClient();

	// Fetch readiness
	const {
		data: readinessData,
		isLoading: readinessLoading,
		isError: readinessIsError,
		isSuccess: readinessIsSuccess,
		refetch: refetchReadiness,
	} = useQuery({
		queryKey: ["statement-readiness", cardId, statement.statementId],
		queryFn: () => fetchStatementReadiness(cardId, statement.statementId),
		enabled: isOpen && statement.status === "OPEN",
		retry: false,
	});

	// Fetch Midas liquidity (for excluding Midas ledger asset on OUTSIDE_MIDAS)
	const { data: midasData } = useQuery({
		queryKey: ["midas-liquidity"],
		queryFn: fetchMidasLiquidity,
		enabled: isOpen && statement.reservePlacement === "OUTSIDE_MIDAS",
	});

	// Fetch Ledger Accounts if OUTSIDE_MIDAS
	const { data: accountsData, isLoading: accountsLoading } = useQuery({
		queryKey: ["ledger-accounts"],
		queryFn: () => fetchAllLedgerAccounts(100),
		enabled: isOpen && statement.reservePlacement === "OUTSIDE_MIDAS",
	});

	const [selectedAssetId, setSelectedAssetId] = useState<string>("");
	const [occurredAtLocal, setOccurredAtLocal] = useState<string>(() =>
		formatIstanbulDateTimeLocal(new Date()),
	);

	const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
	const [errorMessage, setErrorMessage] = useState<string | null>(null);
	const [canRetry, setCanRetry] = useState<boolean>(false);

	// Stable idempotency and last payload
	const idempotencyKeyRef = useRef<string | null>(null);
	const lastPayloadRef = useRef<PayStatementPayload | null>(null);

	// Filter outside payment assets
	const eligibleAccounts = (accountsData ?? []).filter(
		(acc: LedgerAccountItem) => {
			if (acc.accountType !== "ASSET") return false;
			if (acc.normalBalance !== "DEBIT") return false;
			if (acc.currency !== "TRY") return false;
			if (acc.archived) return false;
			// Exclude Midas physical ledger asset
			if (
				midasData?.liquidity?.ledgerAccountId &&
				acc.accountId === midasData.liquidity.ledgerAccountId
			) {
				return false;
			}
			return true;
		},
	);

	// Default select first eligible account
	useEffect(() => {
		if (
			statement.reservePlacement === "OUTSIDE_MIDAS" &&
			eligibleAccounts.length > 0 &&
			!selectedAssetId
		) {
			setSelectedAssetId(eligibleAccounts[0]?.accountId ?? "");
		}
	}, [statement.reservePlacement, eligibleAccounts, selectedAssetId]);

	const readiness = readinessData?.readiness;
	const isMidasFund = statement.reservePlacement === "MIDAS_FUND";
	const isReserveSatisfied = statement.reserveSatisfied === true;

	// R1: Explicit readiness state model (fail-closed)
	const readinessConfirmed =
		readinessIsSuccess && readiness !== undefined && readiness !== null;
	const liabilityReady =
		readinessConfirmed && readiness.liabilityCoverage === "READY";
	const isLiabilityShortfall =
		readinessConfirmed && readiness.liabilityCoverage === "SHORTFALL";
	const readinessUnavailable =
		readinessIsError || (readinessIsSuccess && !readinessConfirmed);

	// R2: Midas reserve gate (fail-closed)
	const reserveReady = !isMidasFund || isReserveSatisfied;

	// Payment eligibility: must be OPEN, readiness confirmed & READY, reserve ready, and asset ready
	const canPay =
		statement.status === "OPEN" &&
		readinessConfirmed &&
		liabilityReady &&
		reserveReady &&
		(isMidasFund || Boolean(selectedAssetId));

	const executePayment = async (payload: PayStatementPayload, key: string) => {
		setIsSubmitting(true);
		setErrorMessage(null);

		try {
			await payCreditCardStatement(cardId, statement.statementId, payload, key);

			// Authoritative invalidations per Section 28
			await Promise.all([
				queryClient.invalidateQueries({ queryKey: ["active-credit-cards"] }),
				queryClient.invalidateQueries({ queryKey: ["credit-cards"] }),
				queryClient.invalidateQueries({ queryKey: ["credit-card", cardId] }),
				queryClient.invalidateQueries({
					queryKey: ["card-statements", cardId],
				}),
				queryClient.invalidateQueries({
					queryKey: ["statement", cardId, statement.statementId],
				}),
				queryClient.invalidateQueries({
					queryKey: ["statement-readiness", cardId, statement.statementId],
				}),
				queryClient.invalidateQueries({ queryKey: ["transactions"] }),
				queryClient.invalidateQueries({ queryKey: ["spending-summary"] }),
				queryClient.invalidateQueries({ queryKey: ["ledger-accounts"] }),
				queryClient.invalidateQueries({ queryKey: ["midas-liquidity"] }),
				queryClient.invalidateQueries({ queryKey: ["budget-checkpoints"] }),
			]);

			setCanRetry(false);
			idempotencyKeyRef.current = null;
			lastPayloadRef.current = null;

			onClose();
			if (onSuccess) onSuccess();
		} catch (err) {
			if (
				(err instanceof ApiError && err.code === "NETWORK_ERROR") ||
				err instanceof TypeError ||
				(err instanceof Error &&
					(err.name === "TypeError" ||
						err.message.toLowerCase().includes("fetch")))
			) {
				// Section 29: Uncertain network response, offer retry with same key
				setCanRetry(true);
				setErrorMessage(
					"Ödemenin tamamlanıp tamamlanmadığı doğrulanamadı. Tekrar deneyebilirsiniz.",
				);
			} else {
				setCanRetry(false);
				idempotencyKeyRef.current = null;
				lastPayloadRef.current = null;
				setErrorMessage(mapCreditCardError(err));
			}
		} finally {
			setIsSubmitting(false);
		}
	};

	const handlePaySubmit = async (e: React.FormEvent) => {
		e.preventDefault();

		if (!readinessConfirmed || !liabilityReady) {
			if (isLiabilityShortfall) {
				setErrorMessage("Kart yükümlülüğü ekstre tutarını karşılamıyor.");
			} else {
				setErrorMessage("Ödeme hazırlık durumu doğrulanamadı.");
			}
			return;
		}

		if (isMidasFund && !isReserveSatisfied) {
			setErrorMessage("Kart Rezervi ekstre ödemesi için yeterli değil.");
			return;
		}

		if (!isMidasFund && !selectedAssetId) {
			setErrorMessage("Lütfen ödemenin yapılacağı varlık hesabını seçiniz.");
			return;
		}

		let occurredAtIso: string;
		try {
			occurredAtIso = parseIstanbulDateTimeLocalToIso(occurredAtLocal);
		} catch {
			setErrorMessage("Tarih ve saat biçimi geçersiz.");
			return;
		}

		const key = idempotencyKeyRef.current ?? crypto.randomUUID();
		idempotencyKeyRef.current = key;

		let payload: PayStatementPayload;
		if (isMidasFund) {
			payload = {
				expectedRevisionNo: statement.revisionNo,
				occurredAt: occurredAtIso,
			};
		} else {
			payload = {
				expectedRevisionNo: statement.revisionNo,
				paymentMethod: "OUTSIDE_MIDAS",
				outsidePaymentAssetAccountId: selectedAssetId,
				occurredAt: occurredAtIso,
			};
		}

		lastPayloadRef.current = payload;
		await executePayment(payload, key);
	};

	const handleRetry = async () => {
		if (lastPayloadRef.current && idempotencyKeyRef.current) {
			await executePayment(lastPayloadRef.current, idempotencyKeyRef.current);
		}
	};

	return (
		<AccessibleModal
			isOpen={isOpen}
			onClose={onClose}
			title="Ekstre Ödemesi"
			description={`${statement.cycleYear}-${String(statement.cycleMonth).padStart(2, "0")} dönemi ekstre ödemesi`}
		>
			<form
				onSubmit={handlePaySubmit}
				className="statement-pay-modal"
				noValidate
			>
				{errorMessage && (
					<div
						className="error-alert"
						role="alert"
						data-testid="statement-pay-error"
					>
						{errorMessage}
						{canRetry && (
							<div style={{ marginTop: "0.5rem" }}>
								<button
									type="button"
									className="btn btn-secondary btn-sm"
									onClick={handleRetry}
									disabled={isSubmitting}
									data-testid="retry-payment-button"
								>
									Tekrar Dene
								</button>
							</div>
						)}
					</div>
				)}

				<div
					className="pay-summary-card"
					style={{
						padding: "1rem",
						borderRadius: "8px",
						background: "var(--color-bg-secondary, #f8fafc)",
						marginBottom: "1rem",
					}}
				>
					<div
						style={{
							display: "flex",
							justifyContent: "space-between",
							marginBottom: "0.5rem",
						}}
					>
						<span style={{ color: "var(--color-text-muted, #64748b)" }}>
							Kart:
						</span>
						<strong>{cardName || "Kredi Kartı"}</strong>
					</div>
					<div
						style={{
							display: "flex",
							justifyContent: "space-between",
							marginBottom: "0.5rem",
						}}
					>
						<span style={{ color: "var(--color-text-muted, #64748b)" }}>
							Dönem:
						</span>
						<span>
							{statement.cycleYear}-
							{String(statement.cycleMonth).padStart(2, "0")}
						</span>
					</div>
					<div
						style={{
							display: "flex",
							justifyContent: "space-between",
							marginBottom: "0.5rem",
						}}
					>
						<span style={{ color: "var(--color-text-muted, #64748b)" }}>
							Son Ödeme:
						</span>
						<span>{statement.dueDate}</span>
					</div>
					<div
						style={{
							display: "flex",
							justifyContent: "space-between",
							borderTop: "1px solid var(--color-border, #e2e8f0)",
							paddingTop: "0.5rem",
							fontWeight: 600,
							fontSize: "1.1rem",
						}}
					>
						<span>Ekstre Tutarı:</span>
						<span data-testid="pay-statement-amount">
							{formatMoneyToTry(statement.statementAmount)}
						</span>
					</div>
				</div>

				{/* Readiness Invariants (Section 21-22) */}
				<div
					className="readiness-section"
					style={{
						padding: "1rem",
						borderRadius: "8px",
						border: "1px solid var(--color-border, #e2e8f0)",
						marginBottom: "1.25rem",
					}}
					data-testid="readiness-section"
				>
					<h4 style={{ margin: "0 0 0.5rem 0", fontSize: "0.95rem" }}>
						Ödeme Hazırlık Durumu
					</h4>

					{readinessLoading ? (
						<p style={{ color: "var(--color-text-muted, #64748b)" }}>
							Hazırlık durumu denetleniyor...
						</p>
					) : readinessUnavailable ? (
						<div
							style={{
								display: "flex",
								flexDirection: "column",
								gap: "0.5rem",
							}}
							data-testid="readiness-unavailable-state"
						>
							<p
								style={{ margin: 0, color: "#dc2626", fontSize: "0.9rem" }}
								data-testid="readiness-error-message"
							>
								Ödeme hazırlık durumu alınamadı.
							</p>
							<div>
								<button
									type="button"
									className="btn btn-secondary btn-sm"
									onClick={() => refetchReadiness()}
									data-testid="retry-readiness-button"
								>
									Tekrar Kontrol Et
								</button>
							</div>
						</div>
					) : (
						<div
							style={{
								display: "flex",
								flexDirection: "column",
								gap: "0.5rem",
							}}
						>
							<div
								style={{
									display: "flex",
									justifyContent: "space-between",
									alignItems: "center",
								}}
							>
								<span>Kart Yükümlülüğü:</span>
								<span
									className={`badge ${readiness?.liabilityCoverage === "READY" ? "badge-success" : "badge-danger"}`}
									data-testid="liability-coverage-status"
									style={{
										padding: "0.2rem 0.6rem",
										borderRadius: "4px",
										fontWeight: 500,
										background:
											readiness?.liabilityCoverage === "READY"
												? "rgba(34, 197, 94, 0.15)"
												: "rgba(239, 68, 68, 0.15)",
										color:
											readiness?.liabilityCoverage === "READY"
												? "#16a34a"
												: "#dc2626",
									}}
								>
									{readiness?.liabilityCoverage === "READY"
										? "Hazır"
										: "Yetersiz"}
								</span>
							</div>

							<div
								style={{
									display: "flex",
									justifyContent: "space-between",
									alignItems: "center",
								}}
							>
								<span>
									Kart Rezervi ({isMidasFund ? "Midas" : "Midas Dışı"}):
								</span>
								<span
									className={`badge ${isReserveSatisfied ? "badge-success" : "badge-warning"}`}
									data-testid="reserve-satisfied-status"
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

							{isLiabilityShortfall && (
								<p
									style={{
										margin: "0.25rem 0 0 0",
										color: "#dc2626",
										fontSize: "0.85rem",
									}}
									data-testid="shortfall-warning"
								>
									Kart yükümlülüğü ekstre tutarını karşılamıyor.
								</p>
							)}

							{isMidasFund && !isReserveSatisfied && (
								<p
									style={{
										margin: "0.25rem 0 0 0",
										color: "#ca8a04",
										fontSize: "0.85rem",
									}}
									data-testid="reserve-shortfall-warning"
								>
									Kart Rezervi tutarı ekstre için eksik kalmaktadır.
								</p>
							)}
						</div>
					)}
				</div>

				{/* OUTSIDE_MIDAS Asset Selector (Section 25) */}
				{!isMidasFund && (
					<div className="form-group">
						<label htmlFor="pay-asset-account" className="form-label">
							Ödeme Kaynağı Hesap *
						</label>
						{accountsLoading ? (
							<p style={{ color: "var(--color-text-muted)" }}>
								Hesaplar yükleniyor...
							</p>
						) : (
							<select
								id="pay-asset-account"
								className="form-select"
								value={selectedAssetId}
								onChange={(e) => setSelectedAssetId(e.target.value)}
								required
								data-testid="pay-asset-select"
							>
								{eligibleAccounts.length === 0 ? (
									<option value="">
										Ödeme yapılacak uygun TRY varlık hesabı bulunamadı
									</option>
								) : (
									eligibleAccounts.map((acc: LedgerAccountItem) => (
										<option key={acc.accountId} value={acc.accountId}>
											{acc.name} ({acc.code})
										</option>
									))
								)}
							</select>
						)}
						<small className="form-help">
							Midas dışı ekstre ödemeleri için kullanılacak TRY vadesiz / nakit
							hesabı.
						</small>
					</div>
				)}

				<div className="form-group">
					<label htmlFor="pay-occurred-at" className="form-label">
						Ödeme Tarihi / Saati *
					</label>
					<input
						id="pay-occurred-at"
						type="datetime-local"
						className="form-input"
						value={occurredAtLocal}
						onChange={(e) => setOccurredAtLocal(e.target.value)}
						required
						data-testid="pay-occurred-at-input"
					/>
				</div>

				<div
					className="modal-actions"
					style={{
						display: "flex",
						gap: "0.75rem",
						justifyContent: "flex-end",
						marginTop: "1.5rem",
					}}
				>
					<button
						type="button"
						className="btn btn-secondary"
						onClick={onClose}
						disabled={isSubmitting}
					>
						Vazgeç
					</button>
					<button
						type="submit"
						className="btn btn-primary"
						disabled={!canPay || isSubmitting}
						data-testid="confirm-statement-pay-button"
					>
						{isSubmitting ? "Ödeniyor..." : "Ekstreyi Öde"}
					</button>
				</div>
			</form>
		</AccessibleModal>
	);
}
