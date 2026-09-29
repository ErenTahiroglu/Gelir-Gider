/**
 * Credit Card Statement Create & Edit Form
 *
 * Implements Section 17-20:
 *   - POST /credit-cards/:cardId/statements
 *   - Midas dependency: GET /midas/liquidity
 *   - If no Midas account: disable statement creation with natural copy
 *   - Edit: POST /credit-cards/:cardId/statements/:statementId (OCC)
 */

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { mapCreditCardError } from "../../../api/credit-card-errors";
import {
	createCreditCardStatement,
	fetchCreditCardStatement,
	fetchMidasLiquidity,
	updateCreditCardStatement,
} from "../../../api/credit-cards-api";
import type {
	CreditCardStatementItem,
	ReservePlacement,
} from "../../../api/credit-cards-types";
import { ApiError } from "../../../api/errors";
import {
	formatIstanbulDateTimeLocal,
	parseIstanbulDateTimeLocalToIso,
} from "../../../lib/istanbul-date";
import { MoneyInput } from "../../common/MoneyInput";

export interface StatementFormProps {
	mode: "create" | "edit";
	cardId: string;
	statementId?: string | undefined;
	statement?: CreditCardStatementItem | undefined;
	onSuccess?: ((statement: CreditCardStatementItem) => void) | undefined;
	onCancel?: (() => void) | undefined;
}

export function StatementForm({
	mode,
	cardId,
	statementId,
	statement: initialStatement,
	onSuccess,
	onCancel,
}: StatementFormProps) {
	const queryClient = useQueryClient();

	// Fetch Midas liquidity for midasAccountId
	const { data: midasData, isLoading: midasLoading } = useQuery({
		queryKey: ["midas-liquidity"],
		queryFn: fetchMidasLiquidity,
		retry: false,
		enabled: mode === "create",
	});

	const hasMidasAccount = Boolean(midasData?.liquidity?.midasAccountId);

	const [statement, setStatement] = useState<
		CreditCardStatementItem | undefined
	>(initialStatement);

	// Calculate default cycleMonth: current year-month
	const now = new Date();
	const defaultCycleMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;

	const [cycleMonth, setCycleMonth] = useState<string>(
		initialStatement
			? `${initialStatement.cycleYear}-${String(initialStatement.cycleMonth).padStart(2, "0")}`
			: defaultCycleMonth,
	);
	const [amountCanonical, setAmountCanonical] = useState<string>(
		initialStatement?.statementAmount ?? "",
	);
	const [amountDisplay, setAmountDisplay] = useState<string>(
		initialStatement?.statementAmount
			? initialStatement.statementAmount.replace(".", ",")
			: "",
	);
	const [amountValid, setAmountValid] = useState<boolean>(
		Boolean(initialStatement?.statementAmount),
	);
	const [reservePlacement, setReservePlacement] = useState<ReservePlacement>(
		initialStatement?.reservePlacement ?? "MIDAS_FUND",
	);
	const [note, setNote] = useState<string>(initialStatement?.note ?? "");
	const [reasonNote, setReasonNote] = useState<string>("");
	const [occurredAtLocal, setOccurredAtLocal] = useState<string>(() =>
		formatIstanbulDateTimeLocal(new Date()),
	);

	const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
	const [errorMessage, setErrorMessage] = useState<string | null>(null);
	const [revisionConflict, setRevisionConflict] = useState<boolean>(false);

	const idempotencyKeyRef = useRef<string>(crypto.randomUUID());

	useEffect(() => {
		if (mode === "edit" && statementId && !statement) {
			void fetchCreditCardStatement(cardId, statementId).then((res) => {
				const s = res.statement;
				setStatement(s);
				setCycleMonth(
					`${s.cycleYear}-${String(s.cycleMonth).padStart(2, "0")}`,
				);
				setAmountCanonical(s.statementAmount);
				setAmountDisplay(s.statementAmount.replace(".", ","));
				setAmountValid(true);
				setReservePlacement(s.reservePlacement);
				setNote(s.note ?? "");
			});
		}
	}, [mode, cardId, statementId, statement]);

	const handleRefreshAfterConflict = async () => {
		const targetId = statement?.statementId || statementId;
		if (!targetId) return;
		try {
			const res = await fetchCreditCardStatement(cardId, targetId);
			const s = res.statement;
			setStatement(s);
			setAmountCanonical(s.statementAmount);
			setAmountDisplay(s.statementAmount.replace(".", ","));
			setAmountValid(true);
			setReservePlacement(s.reservePlacement);
			setNote(s.note ?? "");
			setRevisionConflict(false);
			setErrorMessage(null);
			idempotencyKeyRef.current = crypto.randomUUID();
		} catch (err) {
			setErrorMessage(mapCreditCardError(err));
		}
	};

	const handleSubmit = async (e: React.FormEvent) => {
		e.preventDefault();
		setErrorMessage(null);

		if (mode === "create" && !hasMidasAccount) {
			setErrorMessage(
				"Ekstre oluşturmak için önce Midas likidite hesabı yapılandırılmalı. Bu ayar daha sonraki Likidite aşamasında yönetilecek.",
			);
			return;
		}

		if (!/^\d{4}-(?:0[1-9]|1[0-2])$/.test(cycleMonth)) {
			setErrorMessage("Dönem Yıl-Ay (YYYY-AA) formatında olmalıdır.");
			return;
		}

		if (!amountValid || !amountCanonical) {
			setErrorMessage("Geçerli bir ekstre tutarı giriniz.");
			return;
		}

		let occurredAtIso: string;
		try {
			occurredAtIso = parseIstanbulDateTimeLocalToIso(occurredAtLocal);
		} catch {
			setErrorMessage("Tarih ve saat biçimi geçersiz.");
			return;
		}

		setIsSubmitting(true);

		try {
			if (mode === "create") {
				const midasAccountId = midasData?.liquidity?.midasAccountId;
				if (!midasAccountId) {
					setErrorMessage(
						"Ekstre oluşturmak için önce Midas likidite hesabı yapılandırılmalı. Bu ayar daha sonraki Likidite aşamasında yönetilecek.",
					);
					return;
				}

				const res = await createCreditCardStatement(
					cardId,
					{
						midasAccountId,
						cycleMonth,
						statementAmount: amountCanonical,
						reservePlacement,
						note: note.trim() || undefined,
						occurredAt: occurredAtIso,
					},
					idempotencyKeyRef.current,
				);

				await Promise.all([
					queryClient.invalidateQueries({
						queryKey: ["card-statements", cardId],
					}),
					queryClient.invalidateQueries({
						queryKey: ["credit-card", cardId],
					}),
					queryClient.invalidateQueries({ queryKey: ["credit-cards"] }),
					queryClient.invalidateQueries({ queryKey: ["midas-liquidity"] }),
				]);

				if (onSuccess) onSuccess(res.statement);
			} else {
				const targetId = statement?.statementId || statementId;
				if (!targetId || !statement) {
					throw new Error("Ekstre bilgisi eksik.");
				}

				const res = await updateCreditCardStatement(
					cardId,
					targetId,
					{
						expectedRevisionNo: statement.revisionNo,
						statementAmount: amountCanonical,
						reservePlacement,
						note: note.trim() || undefined,
						reasonNote: reasonNote.trim() || undefined,
						occurredAt: occurredAtIso,
					},
					idempotencyKeyRef.current,
				);

				await Promise.all([
					queryClient.invalidateQueries({
						queryKey: ["card-statements", cardId],
					}),
					queryClient.invalidateQueries({
						queryKey: ["statement", cardId, targetId],
					}),
					queryClient.invalidateQueries({
						queryKey: ["statement-readiness", cardId, targetId],
					}),
					queryClient.invalidateQueries({
						queryKey: ["credit-card", cardId],
					}),
					queryClient.invalidateQueries({ queryKey: ["credit-cards"] }),
					queryClient.invalidateQueries({ queryKey: ["midas-liquidity"] }),
				]);

				if (onSuccess) onSuccess(res.statement);
			}
		} catch (err) {
			if (
				err instanceof ApiError &&
				err.code === "CREDIT_CARD_STATEMENT_REVISION_CONFLICT"
			) {
				setRevisionConflict(true);
			}
			setErrorMessage(mapCreditCardError(err));
		} finally {
			setIsSubmitting(false);
		}
	};

	return (
		<form
			onSubmit={handleSubmit}
			className="statement-form"
			data-testid="statement-form"
			noValidate
		>
			{mode === "create" && !midasLoading && !hasMidasAccount && (
				<div
					className="warning-alert"
					role="alert"
					data-testid="no-midas-account-warning"
					style={{
						padding: "1rem",
						borderRadius: "8px",
						background: "rgba(234, 179, 8, 0.15)",
						border: "1px solid #eab308",
						marginBottom: "1rem",
						color: "#ca8a04",
					}}
				>
					Ekstre oluşturmak için önce Midas likidite hesabı yapılandırılmalı. Bu
					ayar daha sonraki Likidite aşamasında yönetilecek.
				</div>
			)}

			{errorMessage && (
				<div
					className="error-alert"
					role="alert"
					data-testid="statement-form-error"
				>
					{errorMessage}
					{revisionConflict && (
						<button
							type="button"
							className="btn btn-secondary btn-sm"
							onClick={handleRefreshAfterConflict}
							style={{ marginTop: "0.5rem" }}
						>
							En Güncel Ekstre Bilgilerini Yükle
						</button>
					)}
				</div>
			)}

			{mode === "create" && (
				<div className="form-group">
					<label htmlFor="statement-cycle-month" className="form-label">
						Dönem (Yıl-Ay) *
					</label>
					<input
						id="statement-cycle-month"
						type="month"
						className="form-input"
						value={cycleMonth}
						onChange={(e) => setCycleMonth(e.target.value)}
						required
						data-testid="statement-cycle-month-input"
					/>
				</div>
			)}

			<div className="form-group">
				<label htmlFor="statement-amount" className="form-label">
					Ekstre Tutarı *
				</label>
				<MoneyInput
					id="statement-amount"
					value={amountDisplay}
					onChange={(canonical, raw, isValid) => {
						setAmountCanonical(canonical);
						setAmountDisplay(raw);
						setAmountValid(isValid);
					}}
					required
				/>
			</div>

			<div className="form-group">
				<span className="form-label">Ödeme / Rezerv Yerleşimi *</span>
				<div
					className="radio-group"
					style={{ display: "flex", gap: "1rem", marginTop: "0.25rem" }}
				>
					<label
						style={{
							display: "flex",
							alignItems: "center",
							gap: "0.5rem",
							cursor: "pointer",
						}}
					>
						<input
							type="radio"
							name="reservePlacement"
							value="MIDAS_FUND"
							checked={reservePlacement === "MIDAS_FUND"}
							onChange={() => setReservePlacement("MIDAS_FUND")}
							data-testid="reserve-placement-midas"
						/>
						<span>Kart Rezervi (Midas)</span>
					</label>

					<label
						style={{
							display: "flex",
							alignItems: "center",
							gap: "0.5rem",
							cursor: "pointer",
						}}
					>
						<input
							type="radio"
							name="reservePlacement"
							value="OUTSIDE_MIDAS"
							checked={reservePlacement === "OUTSIDE_MIDAS"}
							onChange={() => setReservePlacement("OUTSIDE_MIDAS")}
							data-testid="reserve-placement-outside"
						/>
						<span>Midas Dışı Ödeme</span>
					</label>
				</div>
				<small className="form-help">
					{reservePlacement === "MIDAS_FUND"
						? "Ödeme Midas rezerv fonundan karşılanır."
						: "Ödeme Midas dışındaki nakit veya banka hesabından karşılanır."}
				</small>
			</div>

			<div className="form-group">
				<label htmlFor="statement-occurred-at" className="form-label">
					Tarih / Saat *
				</label>
				<input
					id="statement-occurred-at"
					type="datetime-local"
					className="form-input"
					value={occurredAtLocal}
					onChange={(e) => setOccurredAtLocal(e.target.value)}
					required
					data-testid="statement-occurred-at-input"
				/>
			</div>

			<div className="form-group">
				<label htmlFor="statement-note" className="form-label">
					Not (Opsiyonel)
				</label>
				<textarea
					id="statement-note"
					className="form-textarea"
					value={note}
					onChange={(e) => setNote(e.target.value)}
					placeholder="Ekstre ile ilgili notlar..."
					maxLength={500}
					rows={2}
					data-testid="statement-note-input"
				/>
			</div>

			{mode === "edit" && (
				<div className="form-group">
					<label htmlFor="statement-reason-note" className="form-label">
						Değişiklik Gerekçesi (Opsiyonel)
					</label>
					<input
						id="statement-reason-note"
						type="text"
						className="form-input"
						value={reasonNote}
						onChange={(e) => setReasonNote(e.target.value)}
						placeholder="Dönem güncellemesi, tutar düzeltmesi vb."
						maxLength={500}
						data-testid="statement-reason-note-input"
					/>
				</div>
			)}

			<div className="form-actions">
				{onCancel && (
					<button
						type="button"
						className="btn btn-secondary"
						onClick={onCancel}
						disabled={isSubmitting}
					>
						İptal
					</button>
				)}
				<button
					type="submit"
					className="btn btn-primary"
					disabled={
						isSubmitting ||
						revisionConflict ||
						(mode === "create" && (!hasMidasAccount || midasLoading))
					}
					data-testid="statement-submit-button"
				>
					{isSubmitting
						? "Kaydediliyor..."
						: mode === "create"
							? "Ekstreyi Oluştur"
							: "Ekstreyi Güncelle"}
				</button>
			</div>
		</form>
	);
}
