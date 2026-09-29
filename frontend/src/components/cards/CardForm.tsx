/**
 * Credit Card Create & Edit Form
 *
 * Implements Section 11 & 12:
 *   - Create: POST /credit-cards (code, displayName, issuer, statementDay 1..31, dueDay 1..31, creditLimit, lastFour?, note?, occurredAt)
 *   - Edit: POST /credit-cards/:cardId (expectedRevisionNo, displayName, issuer, statementDay, dueDay, creditLimit, lastFour?, note?, changeReason?, occurredAt)
 *   - OCC: on CREDIT_CARD_REVISION_CONFLICT, refetch latest card, require user review
 *   - Idempotency: stable UUID per logical attempt
 */

import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { mapCreditCardError } from "../../api/credit-card-errors";
import {
	createCreditCard,
	fetchCreditCard,
	updateCreditCard,
} from "../../api/credit-cards-api";
import type { CreditCardItem } from "../../api/credit-cards-types";
import { ApiError } from "../../api/errors";
import {
	formatIstanbulDateTimeLocal,
	parseIstanbulDateTimeLocalToIso,
} from "../../lib/istanbul-date";
import { MoneyInput } from "../common/MoneyInput";

export interface CardFormProps {
	mode: "create" | "edit";
	card?: CreditCardItem | undefined;
	cardId?: string | undefined;
	onSuccess?: ((card: CreditCardItem) => void) | undefined;
	onCancel?: (() => void) | undefined;
}

export function CardForm({
	mode,
	card: initialCard,
	cardId,
	onSuccess,
	onCancel,
}: CardFormProps) {
	const queryClient = useQueryClient();

	const [card, setCard] = useState<CreditCardItem | undefined>(initialCard);
	const [code, setCode] = useState<string>(initialCard?.code ?? "");
	const [displayName, setDisplayName] = useState<string>(
		initialCard?.displayName ?? "",
	);
	const [issuer, setIssuer] = useState<string>(initialCard?.issuer ?? "");
	const [statementDay, setStatementDay] = useState<string>(
		initialCard ? String(initialCard.statementDay) : "1",
	);
	const [dueDay, setDueDay] = useState<string>(
		initialCard ? String(initialCard.dueDay) : "10",
	);
	const [creditLimitCanonical, setCreditLimitCanonical] = useState<string>(
		initialCard?.creditLimit ?? "",
	);
	const [creditLimitDisplay, setCreditLimitDisplay] = useState<string>(
		initialCard?.creditLimit ? initialCard.creditLimit.replace(".", ",") : "",
	);
	const [creditLimitValid, setCreditLimitValid] = useState<boolean>(
		Boolean(initialCard?.creditLimit),
	);
	const [lastFour, setLastFour] = useState<string>(initialCard?.lastFour ?? "");
	const [note, setNote] = useState<string>(initialCard?.note ?? "");
	const [changeReason, setChangeReason] = useState<string>("");
	const [occurredAtLocal, setOccurredAtLocal] = useState<string>(() =>
		formatIstanbulDateTimeLocal(new Date()),
	);

	const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
	const [errorMessage, setErrorMessage] = useState<string | null>(null);
	const [revisionConflict, setRevisionConflict] = useState<boolean>(false);

	// Stable Idempotency-Key
	const idempotencyKeyRef = useRef<string>(crypto.randomUUID());

	// If in edit mode and initialCard not provided, fetch fresh
	useEffect(() => {
		if (mode === "edit" && cardId && !card) {
			void fetchCreditCard(cardId).then((res) => {
				const c = res.card;
				setCard(c);
				setCode(c.code);
				setDisplayName(c.displayName);
				setIssuer(c.issuer);
				setStatementDay(String(c.statementDay));
				setDueDay(String(c.dueDay));
				setCreditLimitCanonical(c.creditLimit);
				setCreditLimitDisplay(c.creditLimit.replace(".", ","));
				setCreditLimitValid(true);
				setLastFour(c.lastFour ?? "");
				setNote(c.note ?? "");
			});
		}
	}, [mode, cardId, card]);

	const handleRefreshAfterConflict = async () => {
		const targetId = card?.cardId || cardId;
		if (!targetId) return;
		try {
			const res = await fetchCreditCard(targetId);
			const fresh = res.card;
			setCard(fresh);
			setDisplayName(fresh.displayName);
			setIssuer(fresh.issuer);
			setStatementDay(String(fresh.statementDay));
			setDueDay(String(fresh.dueDay));
			setCreditLimitCanonical(fresh.creditLimit);
			setCreditLimitDisplay(fresh.creditLimit.replace(".", ","));
			setCreditLimitValid(true);
			setLastFour(fresh.lastFour ?? "");
			setNote(fresh.note ?? "");
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

		// Validation
		if (mode === "create") {
			const codeTrimmed = code.trim();
			if (!/^[A-Za-z0-9_-]{1,32}$/.test(codeTrimmed)) {
				setErrorMessage(
					"Kart kodu 1-32 karakter uzunluğunda, harf, rakam, tire veya alt çizgi içermelidir.",
				);
				return;
			}
		}

		const nameTrimmed = displayName.trim();
		if (!nameTrimmed || nameTrimmed.length > 120) {
			setErrorMessage("Kart adı 1 ile 120 karakter arasında olmalıdır.");
			return;
		}

		const issuerTrimmed = issuer.trim();
		if (!issuerTrimmed || issuerTrimmed.length > 120) {
			setErrorMessage(
				"Banka / Kuruluş adı 1 ile 120 karakter arasında olmalıdır.",
			);
			return;
		}

		const stmtDayNum = Number.parseInt(statementDay, 10);
		if (Number.isNaN(stmtDayNum) || stmtDayNum < 1 || stmtDayNum > 31) {
			setErrorMessage("Hesap kesim günü 1 ile 31 arasında olmalıdır.");
			return;
		}

		const dueDayNum = Number.parseInt(dueDay, 10);
		if (Number.isNaN(dueDayNum) || dueDayNum < 1 || dueDayNum > 31) {
			setErrorMessage("Son ödeme günü 1 ile 31 arasında olmalıdır.");
			return;
		}

		if (!creditLimitValid || !creditLimitCanonical) {
			setErrorMessage("Geçerli bir kredi kartı limiti giriniz.");
			return;
		}

		const lastFourTrimmed = lastFour.trim();
		if (lastFourTrimmed && !/^\d{4}$/.test(lastFourTrimmed)) {
			setErrorMessage("Son 4 hane tam olarak 4 rakamdan oluşmalıdır.");
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
				const res = await createCreditCard(
					{
						code: code.trim(),
						displayName: nameTrimmed,
						issuer: issuerTrimmed,
						statementDay: stmtDayNum,
						dueDay: dueDayNum,
						creditLimit: creditLimitCanonical,
						lastFour: lastFourTrimmed || undefined,
						note: note.trim() || undefined,
						occurredAt: occurredAtIso,
					},
					idempotencyKeyRef.current,
				);

				await Promise.all([
					queryClient.invalidateQueries({ queryKey: ["credit-cards"] }),
					queryClient.invalidateQueries({ queryKey: ["active-credit-cards"] }),
					queryClient.invalidateQueries({ queryKey: ["dashboard-cards"] }),
				]);

				if (onSuccess) onSuccess(res.card);
			} else {
				const currentCardId = card?.cardId || cardId;
				if (!currentCardId || !card) {
					throw new Error("Kart bilgisi eksik.");
				}

				const res = await updateCreditCard(
					currentCardId,
					{
						expectedRevisionNo: card.revisionNo,
						displayName: nameTrimmed,
						issuer: issuerTrimmed,
						statementDay: stmtDayNum,
						dueDay: dueDayNum,
						creditLimit: creditLimitCanonical,
						lastFour: lastFourTrimmed || undefined,
						note: note.trim() || undefined,
						changeReason: changeReason.trim() || undefined,
						occurredAt: occurredAtIso,
					},
					idempotencyKeyRef.current,
				);

				await Promise.all([
					queryClient.invalidateQueries({ queryKey: ["credit-cards"] }),
					queryClient.invalidateQueries({ queryKey: ["active-credit-cards"] }),
					queryClient.invalidateQueries({
						queryKey: ["credit-card", currentCardId],
					}),
					queryClient.invalidateQueries({ queryKey: ["dashboard-cards"] }),
				]);

				if (onSuccess) onSuccess(res.card);
			}
		} catch (err) {
			if (
				err instanceof ApiError &&
				err.code === "CREDIT_CARD_REVISION_CONFLICT"
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
			className="card-form"
			data-testid="card-form"
			noValidate
		>
			{errorMessage && (
				<div className="error-alert" role="alert" data-testid="card-form-error">
					{errorMessage}
					{revisionConflict && (
						<button
							type="button"
							className="btn btn-secondary btn-sm"
							onClick={handleRefreshAfterConflict}
							style={{ marginTop: "0.5rem" }}
						>
							En Güncel Bilgileri Yükle
						</button>
					)}
				</div>
			)}

			{mode === "create" && (
				<div className="form-group">
					<label htmlFor="card-code" className="form-label">
						Kart Kodu *
					</label>
					<input
						id="card-code"
						type="text"
						className="form-input"
						value={code}
						onChange={(e) => setCode(e.target.value)}
						placeholder="Örn: BONUS_GARANTI"
						maxLength={32}
						required
						data-testid="card-code-input"
					/>
					<small className="form-help">
						Kartın benzersiz sistem kodudur. Harf, rakam ve alt çizgi
						içerebilir.
					</small>
				</div>
			)}

			<div className="form-group">
				<label htmlFor="card-display-name" className="form-label">
					Kart Adı *
				</label>
				<input
					id="card-display-name"
					type="text"
					className="form-input"
					value={displayName}
					onChange={(e) => setDisplayName(e.target.value)}
					placeholder="Örn: Garanti BBVA Bonus"
					maxLength={120}
					required
					data-testid="card-display-name-input"
				/>
			</div>

			<div className="form-group">
				<label htmlFor="card-issuer" className="form-label">
					Banka / Kuruluş *
				</label>
				<input
					id="card-issuer"
					type="text"
					className="form-input"
					value={issuer}
					onChange={(e) => setIssuer(e.target.value)}
					placeholder="Örn: Garanti BBVA"
					maxLength={120}
					required
					data-testid="card-issuer-input"
				/>
			</div>

			<div className="form-row">
				<div className="form-group" style={{ flex: 1 }}>
					<label htmlFor="card-statement-day" className="form-label">
						Hesap Kesim Günü (1-31) *
					</label>
					<input
						id="card-statement-day"
						type="number"
						min={1}
						max={31}
						className="form-input"
						value={statementDay}
						onChange={(e) => setStatementDay(e.target.value)}
						required
						data-testid="card-statement-day-input"
					/>
				</div>

				<div className="form-group" style={{ flex: 1 }}>
					<label htmlFor="card-due-day" className="form-label">
						Son Ödeme Günü (1-31) *
					</label>
					<input
						id="card-due-day"
						type="number"
						min={1}
						max={31}
						className="form-input"
						value={dueDay}
						onChange={(e) => setDueDay(e.target.value)}
						required
						data-testid="card-due-day-input"
					/>
				</div>
			</div>

			<div className="form-group">
				<label htmlFor="card-credit-limit" className="form-label">
					Kredi Limiti *
				</label>
				<MoneyInput
					id="card-credit-limit"
					value={creditLimitDisplay}
					onChange={(canonical, raw, isValid) => {
						setCreditLimitCanonical(canonical);
						setCreditLimitDisplay(raw);
						setCreditLimitValid(isValid);
					}}
					required
				/>
			</div>

			<div className="form-row">
				<div className="form-group" style={{ flex: 1 }}>
					<label htmlFor="card-last-four" className="form-label">
						Kartın Son 4 Hanesi
					</label>
					<input
						id="card-last-four"
						type="text"
						className="form-input"
						value={lastFour}
						onChange={(e) => setLastFour(e.target.value)}
						placeholder="1234"
						maxLength={4}
						data-testid="card-last-four-input"
					/>
				</div>

				<div className="form-group" style={{ flex: 1 }}>
					<label htmlFor="card-occurred-at" className="form-label">
						Tarih / Saat *
					</label>
					<input
						id="card-occurred-at"
						type="datetime-local"
						className="form-input"
						value={occurredAtLocal}
						onChange={(e) => setOccurredAtLocal(e.target.value)}
						required
						data-testid="card-occurred-at-input"
					/>
				</div>
			</div>

			<div className="form-group">
				<label htmlFor="card-note" className="form-label">
					Not
				</label>
				<textarea
					id="card-note"
					className="form-textarea"
					value={note}
					onChange={(e) => setNote(e.target.value)}
					placeholder="Kartla ilgili opsiyonel notlar..."
					maxLength={500}
					rows={2}
					data-testid="card-note-input"
				/>
			</div>

			{mode === "edit" && (
				<div className="form-group">
					<label htmlFor="card-change-reason" className="form-label">
						Değişiklik Nedeni
					</label>
					<input
						id="card-change-reason"
						type="text"
						className="form-input"
						value={changeReason}
						onChange={(e) => setChangeReason(e.target.value)}
						placeholder="Limit artışı, kesim günü değişikliği vb."
						maxLength={500}
						data-testid="card-change-reason-input"
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
					disabled={isSubmitting || revisionConflict}
					data-testid="card-submit-button"
				>
					{isSubmitting
						? "Kaydediliyor..."
						: mode === "create"
							? "Kartı Oluştur"
							: "Değişiklikleri Kaydet"}
				</button>
			</div>
		</form>
	);
}
