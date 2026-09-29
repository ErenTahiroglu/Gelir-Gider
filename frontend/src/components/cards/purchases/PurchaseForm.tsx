/**
 * Card Purchase Form (New Purchase Route: /cards/:cardId/purchases/new)
 *
 * Implements Section 34:
 *   - Reuses/extends F4 CreditCardQuickPurchaseForm boundedly for:
 *     - fixed card context
 *     - installmentCount
 *     - optional "Ortak Harcama" switch
 *   - In unshared mode: canonical POST /credit-cards/:cardId/purchases
 *   - In shared mode: atomic POST /credit-cards/:cardId/purchases/shared
 */

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { User, Users } from "lucide-react";
import { useRef, useState } from "react";
import { mapCreditCardError } from "../../../api/credit-card-errors";
import { createCreditCardPurchase } from "../../../api/credit-cards-api";
import { fetchSpendingCategories } from "../../../api/manual-expenses-api";
import { assignSpendingCategory } from "../../../api/quick-entry-api";
import type {
	BudgetCategorySelection,
	CreditCardPurchasePayload,
} from "../../../api/quick-entry-types";
import {
	formatIstanbulDateTimeLocal,
	parseIstanbulDateTimeLocalToIso,
} from "../../../lib/istanbul-date";
import { MoneyInput } from "../../common/MoneyInput";
import { SharedPurchaseForm } from "./SharedPurchaseForm";

export interface PurchaseFormProps {
	cardId: string;
	cardName?: string | undefined;
	onSuccess?: () => void;
	onCancel?: () => void;
}

export function PurchaseForm({
	cardId,
	cardName,
	onSuccess,
	onCancel,
}: PurchaseFormProps) {
	const queryClient = useQueryClient();

	const [isSharedMode, setIsSharedMode] = useState<boolean>(false);

	// Unshared form state
	const [amountCanonical, setAmountCanonical] = useState<string>("");
	const [amountDisplay, setAmountDisplay] = useState<string>("");
	const [amountValid, setAmountValid] = useState<boolean>(false);
	const [spendingCategoryId, setSpendingCategoryId] = useState<string>("");
	const [purchaseCategory, setPurchaseCategory] =
		useState<BudgetCategorySelection>("MANDATORY_EXPENSE");
	const [merchant, setMerchant] = useState<string>("");
	const [description, setDescription] = useState<string>("");
	const [installmentCount, setInstallmentCount] = useState<string>("1");
	const [occurredAtLocal, setOccurredAtLocal] = useState<string>(() =>
		formatIstanbulDateTimeLocal(new Date()),
	);

	const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
	const [errorMessage, setErrorMessage] = useState<string | null>(null);

	const idempotencyKeyRef = useRef<string>(crypto.randomUUID());

	// Categories
	const { data: categoriesData } = useQuery({
		queryKey: ["spending-categories"],
		queryFn: fetchSpendingCategories,
		staleTime: 60_000,
	});

	const activeCategories = (categoriesData?.categories ?? []).filter(
		(c) => c.status === "ACTIVE",
	);

	const handleCategoryChange = (catId: string) => {
		setSpendingCategoryId(catId);
		if (!catId) return;
		const cat = activeCategories.find((c) => c.id === catId);
		if (cat && cat.defaultBudgetCategory !== "ASK") {
			setPurchaseCategory(cat.defaultBudgetCategory);
		}
	};

	const handleUnsharedSubmit = async (e: React.FormEvent) => {
		e.preventDefault();
		setErrorMessage(null);

		if (!amountValid || !amountCanonical) {
			setErrorMessage("Geçerli bir harcama tutarı giriniz.");
			return;
		}

		let installments: number | undefined;
		if (installmentCount) {
			const instNum = Number.parseInt(installmentCount, 10);
			if (Number.isNaN(instNum) || instNum < 1 || instNum > 60) {
				setErrorMessage("Taksit sayısı 1 ile 60 arasında olmalıdır.");
				return;
			}
			installments = instNum > 1 ? instNum : undefined;
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
			const payload: CreditCardPurchasePayload = {
				amount: amountCanonical,
				purchaseCategory,
				merchant: merchant.trim() || undefined,
				description: description.trim() || undefined,
				installmentCount: installments,
				occurredAt: occurredAtIso,
			};

			const res = await createCreditCardPurchase(
				cardId,
				payload,
				idempotencyKeyRef.current,
			);

			// Invalidate financial queries per Section 60
			await Promise.all([
				queryClient.invalidateQueries({ queryKey: ["card-purchases", cardId] }),
				queryClient.invalidateQueries({ queryKey: ["credit-card", cardId] }),
				queryClient.invalidateQueries({ queryKey: ["credit-cards"] }),
				queryClient.invalidateQueries({ queryKey: ["active-credit-cards"] }),
				queryClient.invalidateQueries({ queryKey: ["transactions"] }),
				queryClient.invalidateQueries({ queryKey: ["spending-summary"] }),
			]);

			// Secondary category assignment
			if (spendingCategoryId) {
				try {
					await assignSpendingCategory({
						subjectType: "CREDIT_CARD_PURCHASE",
						subjectId: res.eventId,
						categoryId: spendingCategoryId,
					});
					await queryClient.invalidateQueries({
						queryKey: ["spending-summary"],
					});
				} catch {
					// Non-blocking secondary warning
				}
			}

			if (onSuccess) onSuccess();
		} catch (err) {
			setErrorMessage(mapCreditCardError(err));
		} finally {
			setIsSubmitting(false);
		}
	};

	return (
		<div
			className="purchase-form-container"
			data-testid="purchase-form-container"
		>
			{/* Mode Switcher */}
			<div
				className="mode-switcher"
				style={{
					display: "flex",
					gap: "0.5rem",
					marginBottom: "1.5rem",
					background: "var(--color-bg-secondary, #f8fafc)",
					padding: "0.35rem",
					borderRadius: "8px",
					border: "1px solid var(--color-border, #e2e8f0)",
				}}
			>
				<button
					type="button"
					className={`mode-btn ${!isSharedMode ? "active" : ""}`}
					onClick={() => setIsSharedMode(false)}
					data-testid="mode-unshared-btn"
					style={{
						flex: 1,
						display: "flex",
						alignItems: "center",
						justifyContent: "center",
						gap: "0.5rem",
						padding: "0.6rem",
						borderRadius: "6px",
						border: "none",
						background: !isSharedMode
							? "var(--color-bg-surface, #ffffff)"
							: "transparent",
						fontWeight: !isSharedMode ? 600 : 400,
						boxShadow: !isSharedMode ? "0 1px 3px rgba(0,0,0,0.1)" : "none",
						cursor: "pointer",
					}}
				>
					<User size={16} aria-hidden="true" />
					<span>Bireysel Harcama</span>
				</button>

				<button
					type="button"
					className={`mode-btn ${isSharedMode ? "active" : ""}`}
					onClick={() => setIsSharedMode(true)}
					data-testid="mode-shared-btn"
					style={{
						flex: 1,
						display: "flex",
						alignItems: "center",
						justifyContent: "center",
						gap: "0.5rem",
						padding: "0.6rem",
						borderRadius: "6px",
						border: "none",
						background: isSharedMode
							? "var(--color-bg-surface, #ffffff)"
							: "transparent",
						fontWeight: isSharedMode ? 600 : 400,
						boxShadow: isSharedMode ? "0 1px 3px rgba(0,0,0,0.1)" : "none",
						cursor: "pointer",
					}}
				>
					<Users size={16} aria-hidden="true" />
					<span>Ortak Harcama</span>
				</button>
			</div>

			{isSharedMode ? (
				<SharedPurchaseForm
					cardId={cardId}
					cardName={cardName}
					onSuccess={onSuccess}
					onCancel={onCancel}
				/>
			) : (
				<form
					onSubmit={handleUnsharedSubmit}
					className="unshared-purchase-form"
					data-testid="unshared-purchase-form"
					noValidate
				>
					{errorMessage && (
						<div
							className="error-alert"
							role="alert"
							data-testid="unshared-purchase-error"
						>
							{errorMessage}
						</div>
					)}

					<div className="form-group">
						<label htmlFor="unshared-amount" className="form-label">
							Harcama Tutarı *
						</label>
						<MoneyInput
							id="unshared-amount"
							value={amountDisplay}
							onChange={(canonical, raw, isValid) => {
								setAmountCanonical(canonical);
								setAmountDisplay(raw);
								setAmountValid(isValid);
							}}
							required
						/>
					</div>

					<div className="form-row">
						<div className="form-group" style={{ flex: 1 }}>
							<label htmlFor="unshared-merchant" className="form-label">
								İşyeri / Satıcı
							</label>
							<input
								id="unshared-merchant"
								type="text"
								className="form-input"
								value={merchant}
								onChange={(e) => setMerchant(e.target.value)}
								placeholder="Örn: Market, Restoran"
								maxLength={200}
								data-testid="unshared-merchant-input"
							/>
						</div>

						<div className="form-group" style={{ flex: 1 }}>
							<label htmlFor="unshared-installment" className="form-label">
								Taksit Sayısı
							</label>
							<input
								id="unshared-installment"
								type="number"
								min={1}
								max={60}
								className="form-input"
								value={installmentCount}
								onChange={(e) => setInstallmentCount(e.target.value)}
								placeholder="Tek çekim için 1"
								data-testid="unshared-installment-input"
							/>
						</div>
					</div>

					<div className="form-group">
						<label htmlFor="unshared-description" className="form-label">
							Açıklama
						</label>
						<input
							id="unshared-description"
							type="text"
							className="form-input"
							value={description}
							onChange={(e) => setDescription(e.target.value)}
							placeholder="Örn: Haftalık market alışverişi"
							maxLength={500}
							data-testid="unshared-description-input"
						/>
					</div>

					<div className="form-row">
						<div className="form-group" style={{ flex: 1 }}>
							<label htmlFor="unshared-category" className="form-label">
								Harcama Kategorisi
							</label>
							<select
								id="unshared-category"
								className="form-select"
								value={spendingCategoryId}
								onChange={(e) => handleCategoryChange(e.target.value)}
								data-testid="unshared-category-select"
							>
								<option value="">Kategori Seçin (Opsiyonel)</option>
								{activeCategories.map((c) => (
									<option key={c.id} value={c.id}>
										{c.name}
									</option>
								))}
							</select>
						</div>

						<div className="form-group" style={{ flex: 1 }}>
							<label htmlFor="unshared-occurred-at" className="form-label">
								Tarih / Saat *
							</label>
							<input
								id="unshared-occurred-at"
								type="datetime-local"
								className="form-input"
								value={occurredAtLocal}
								onChange={(e) => setOccurredAtLocal(e.target.value)}
								required
								data-testid="unshared-occurred-at-input"
							/>
						</div>
					</div>

					<div className="form-actions" style={{ marginTop: "1.5rem" }}>
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
							disabled={isSubmitting || !amountValid}
							data-testid="submit-unshared-purchase-button"
						>
							{isSubmitting ? "Kaydediliyor..." : "Harcamayı Kaydet"}
						</button>
					</div>
				</form>
			)}
		</div>
	);
}
