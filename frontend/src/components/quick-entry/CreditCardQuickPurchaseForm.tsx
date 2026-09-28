/**
 * Credit Card Quick Purchase Form Component
 *
 * Adheres strictly to Sections 42-51:
 *   - Fields: Tutar *, Kart *, Kategori, Harcama Türü / Finansal Sınıf *, İşyeri, Açıklama, Tarih / Saat
 *   - Active credit cards loaded via cursor-loop (GET /credit-cards?status=ACTIVE&limit=100)
 *   - Stale card reference detection: "Şablondaki kart artık kullanılamıyor."
 *   - Stale category reference detection: "Şablondaki kategori artık kullanılamıyor."
 *   - Canonical purchase endpoint: POST /credit-cards/:cardId/purchases
 *   - Does NOT send budgetCategoryOverride, spendingCategoryId, or defaultAmount to purchase endpoint
 *   - Stable UUID Idempotency-Key per logical attempt. Retry reuses exact key and payload.
 *   - Secondary category assignment: POST /spending/category-assignments with subjectId: eventId
 *   - Secondary failure does NOT retry financial purchase. Shows persistent warning until acknowledged.
 *   - Invalidation: ["transactions"], ["spending-summary"], ["active-credit-cards"]. No client budget hero calc.
 */

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { ApiError } from "../../api/errors";
import { fetchSpendingCategories } from "../../api/manual-expenses-api";
import {
	assignSpendingCategory,
	createCreditCardPurchase,
	fetchAllActiveCreditCards,
} from "../../api/quick-entry-api";
import type {
	BudgetCategorySelection,
	CreditCardExpenseTemplateConfig,
	CreditCardPurchasePayload,
} from "../../api/quick-entry-types";
import {
	formatIstanbulDateTimeLocal,
	parseIstanbulDateTimeLocalToIso,
} from "../../lib/istanbul-date";
import { MoneyInput } from "../common/MoneyInput";

export interface CreditCardQuickPurchaseFormProps {
	config?: CreditCardExpenseTemplateConfig | undefined;
	onSuccess?: (() => void) | undefined;
	onCancel?: (() => void) | undefined;
}

export function CreditCardQuickPurchaseForm({
	config,
	onSuccess,
	onCancel,
}: CreditCardQuickPurchaseFormProps) {
	const queryClient = useQueryClient();

	// Reference data
	const { data: cards, isLoading: cardsLoading } = useQuery({
		queryKey: ["active-credit-cards"],
		queryFn: () => fetchAllActiveCreditCards(100),
		staleTime: 60_000,
	});

	const { data: categoriesData, isLoading: categoriesLoading } = useQuery({
		queryKey: ["spending-categories"],
		queryFn: fetchSpendingCategories,
		staleTime: 60_000,
	});

	const activeCards = useMemo(() => cards ?? [], [cards]);

	const activeCategories = useMemo(
		() =>
			(categoriesData?.categories ?? []).filter((c) => c.status === "ACTIVE"),
		[categoriesData?.categories],
	);

	// Form State
	const [amountCanonical, setAmountCanonical] = useState<string>("");
	const [amountDisplay, setAmountDisplay] = useState<string>("");
	const [amountValid, setAmountValid] = useState<boolean>(false);
	const [selectedCardId, setSelectedCardId] = useState<string>("");
	const [spendingCategoryId, setSpendingCategoryId] = useState<string>("");
	const [purchaseCategory, setPurchaseCategory] =
		useState<BudgetCategorySelection>("MANDATORY_EXPENSE");
	const [isAskCategory, setIsAskCategory] = useState<boolean>(false);
	const [merchant, setMerchant] = useState<string>("");
	const [description, setDescription] = useState<string>("");
	const [occurredAtLocal, setOccurredAtLocal] = useState<string>(() =>
		formatIstanbulDateTimeLocal(new Date()),
	);

	// Stale warnings
	const [staleCardWarning, setStaleCardWarning] = useState<string | null>(null);
	const [staleCategoryWarning, setStaleCategoryWarning] = useState<
		string | null
	>(null);

	// Submission state
	const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
	const [errorMessage, setErrorMessage] = useState<string | null>(null);
	const [canRetry, setCanRetry] = useState<boolean>(false);
	const [resultState, setResultState] = useState<
		"IDLE" | "FULL_SUCCESS" | "FINANCIAL_SUCCESS_CATEGORY_UNCONFIRMED"
	>("IDLE");

	// Stable idempotency key and last payload
	const currentIdempotencyKeyRef = useRef<string | null>(null);
	const lastSubmittedPayloadRef = useRef<{
		cardId: string;
		payload: CreditCardPurchasePayload;
		spendingCategoryId?: string | undefined;
	} | null>(null);

	// Initial config prefill
	const initialConfigAppliedRef = useRef<boolean>(false);
	useEffect(() => {
		if (config && !initialConfigAppliedRef.current) {
			if (config.defaultAmount) {
				const amtNum = Number(config.defaultAmount);
				if (!Number.isNaN(amtNum) && amtNum > 0) {
					setAmountCanonical(config.defaultAmount);
					const parts = config.defaultAmount.split(".");
					const w = parts[0] ?? config.defaultAmount;
					const d = parts[1];
					setAmountDisplay(d !== undefined ? `${w},${d}` : w);
					setAmountValid(true);
				}
			}
			if (config.merchant) {
				setMerchant(config.merchant);
			}
			if (config.description) {
				setDescription(config.description);
			}
			if (config.budgetCategoryOverride) {
				setPurchaseCategory(config.budgetCategoryOverride);
			}
			initialConfigAppliedRef.current = true;
		}
	}, [config]);

	// Validate / prefill Card reference
	useEffect(() => {
		if (cardsLoading) return;

		if (config?.cardId) {
			const found = activeCards.some((c) => c.cardId === config.cardId);
			if (found) {
				setSelectedCardId(config.cardId);
				setStaleCardWarning(null);
			} else {
				// Section 45: Stale card reference
				setSelectedCardId("");
				setStaleCardWarning("Şablondaki kart artık kullanılamıyor.");
			}
		} else {
			// No card specified in template
			if (activeCards.length === 1 && activeCards[0]) {
				setSelectedCardId(activeCards[0].cardId);
			}
		}
	}, [config?.cardId, activeCards, cardsLoading]);

	// Validate / prefill Category reference
	useEffect(() => {
		if (categoriesLoading) return;

		if (config?.spendingCategoryId) {
			const found = activeCategories.find(
				(c) => c.id === config.spendingCategoryId,
			);
			if (found) {
				setSpendingCategoryId(found.id);
				setStaleCategoryWarning(null);
				if (!config.budgetCategoryOverride) {
					if (found.defaultBudgetCategory === "ASK") {
						setIsAskCategory(true);
						setPurchaseCategory("MANDATORY_EXPENSE");
					} else {
						setIsAskCategory(false);
						setPurchaseCategory(found.defaultBudgetCategory);
					}
				}
			} else {
				// Section 41: Stale category reference
				setSpendingCategoryId("");
				setStaleCategoryWarning("Şablondaki kategori artık kullanılamıyor.");
			}
		}
	}, [
		config?.spendingCategoryId,
		config?.budgetCategoryOverride,
		activeCategories,
		categoriesLoading,
	]);

	// Category change handler
	const handleCategoryChange = (catId: string) => {
		setSpendingCategoryId(catId);
		setStaleCategoryWarning(null);
		if (!catId) {
			setIsAskCategory(false);
			return;
		}

		const cat = activeCategories.find((c) => c.id === catId);
		if (!cat) return;

		if (cat.defaultBudgetCategory === "ASK") {
			setIsAskCategory(true);
			setPurchaseCategory("MANDATORY_EXPENSE");
		} else {
			setIsAskCategory(false);
			setPurchaseCategory(cat.defaultBudgetCategory);
		}
	};

	// Map domain errors
	const mapDomainError = (err: unknown): string => {
		if (err instanceof ApiError) {
			switch (err.code) {
				case "CREDIT_CARD_INVALID_INPUT":
					return "Girdiğiniz kart harcaması bilgilerini kontrol edin.";
				case "CREDIT_CARD_NOT_FOUND":
					return "Kart bulunamadı.";
				case "CREDIT_CARD_NOT_ACTIVE":
					return "Bu kart aktif değil.";
				case "CREDIT_CARD_IDEMPOTENCY_CONFLICT":
					return "Bu işlem daha önce farklı bilgilerle gönderilmiş. Lütfen formu gözden geçirin.";
				case "CREDIT_CARD_PURCHASE_NOT_ACTIVE":
					return "Kart harcaması aktif değil.";
				case "UNAUTHENTICATED":
					return "Oturum süresi doldu. Lütfen tekrar giriş yapın.";
				case "NETWORK_ERROR":
					return "Kart harcamasının kaydedilip kaydedilmediği doğrulanamadı.";
				default:
					return "Bir hata oluştu. Lütfen tekrar deneyin.";
			}
		}
		return "Kart harcaması kaydedilirken beklenmeyen bir hata oluştu.";
	};

	// Execute Submit
	const executeSubmit = async (
		cardId: string,
		payload: CreditCardPurchasePayload,
		assignedCatId: string | undefined,
		idempotencyKey: string,
	) => {
		setIsSubmitting(true);
		setErrorMessage(null);

		try {
			// 1. Canonical financial purchase
			const res = await createCreditCardPurchase(
				cardId,
				payload,
				idempotencyKey,
			);

			// 2. Invalidate financial queries per Section 51
			await Promise.all([
				queryClient.invalidateQueries({ queryKey: ["transactions"] }),
				queryClient.invalidateQueries({ queryKey: ["spending-summary"] }),
				queryClient.invalidateQueries({ queryKey: ["active-credit-cards"] }),
				queryClient.invalidateQueries({ queryKey: ["spending-categories"] }),
			]);

			// Clear financial idempotency retry state immediately upon financial commit
			setCanRetry(false);
			currentIdempotencyKeyRef.current = null;
			lastSubmittedPayloadRef.current = null;

			// 3. Secondary category assignment per Section 47 & 48
			let categoryAssignmentFailed = false;
			if (assignedCatId) {
				try {
					await assignSpendingCategory({
						subjectType: "CREDIT_CARD_PURCHASE",
						subjectId: res.eventId,
						categoryId: assignedCatId,
					});
					await queryClient.invalidateQueries({
						queryKey: ["spending-summary"],
					});
				} catch {
					categoryAssignmentFailed = true;
				}
			}

			if (categoryAssignmentFailed) {
				setResultState("FINANCIAL_SUCCESS_CATEGORY_UNCONFIRMED");
			} else {
				setResultState("FULL_SUCCESS");
				if (onSuccess) {
					onSuccess();
				}
			}
		} catch (err) {
			const mapped = mapDomainError(err);
			setErrorMessage(mapped);

			if (err instanceof ApiError && err.code === "NETWORK_ERROR") {
				// Section 50: Offer retry with same key and payload
				setCanRetry(true);
			} else {
				// Logical or idempotency conflict: do not auto retry
				setCanRetry(false);
				currentIdempotencyKeyRef.current = null;
				lastSubmittedPayloadRef.current = null;
			}
		} finally {
			setIsSubmitting(false);
		}
	};

	const handleSubmit = (e: React.FormEvent) => {
		e.preventDefault();

		if (staleCardWarning && !selectedCardId) {
			setErrorMessage(
				"Şablondaki kart artık kullanılamıyor. Lütfen yeni bir kart seçin.",
			);
			return;
		}

		if (staleCategoryWarning) {
			setErrorMessage(
				"Şablondaki kategori artık kullanılamıyor. Lütfen yeni bir kategori seçin veya kategoriyi temizleyin.",
			);
			return;
		}

		if (!amountValid || !amountCanonical) {
			setErrorMessage("Lütfen geçerli bir tutar girin.");
			return;
		}

		if (!selectedCardId) {
			setErrorMessage("Lütfen bir kart seçin.");
			return;
		}

		let occurredAtIso: string;
		try {
			occurredAtIso = parseIstanbulDateTimeLocalToIso(occurredAtLocal);
		} catch {
			setErrorMessage("Geçersiz tarih veya saat.");
			return;
		}

		const key = crypto.randomUUID();
		currentIdempotencyKeyRef.current = key;

		const payload: CreditCardPurchasePayload = {
			amount: amountCanonical,
			purchaseCategory,
			merchant: merchant.trim() || undefined,
			description: description.trim() || undefined,
			shortTermGoalId: config?.shortTermGoalId || undefined,
			occurredAt: occurredAtIso,
		};

		lastSubmittedPayloadRef.current = {
			cardId: selectedCardId,
			payload,
			spendingCategoryId: spendingCategoryId || undefined,
		};

		void executeSubmit(
			selectedCardId,
			payload,
			spendingCategoryId || undefined,
			key,
		);
	};

	const handleRetry = () => {
		if (
			canRetry &&
			currentIdempotencyKeyRef.current &&
			lastSubmittedPayloadRef.current
		) {
			void executeSubmit(
				lastSubmittedPayloadRef.current.cardId,
				lastSubmittedPayloadRef.current.payload,
				lastSubmittedPayloadRef.current.spendingCategoryId,
				currentIdempotencyKeyRef.current,
			);
		}
	};

	// Guard: Financial success with unconfirmed category warning per Section 48
	if (resultState === "FINANCIAL_SUCCESS_CATEGORY_UNCONFIRMED") {
		return (
			<div
				className="category-unverified-success card"
				data-testid="success-cc-category-warning-card"
				style={{ padding: "var(--space-6)", textAlign: "center" }}
			>
				<div
					style={{
						fontSize: "var(--font-size-3xl)",
						color: "var(--color-warning-500)",
						marginBottom: "var(--space-2)",
					}}
				>
					✓
				</div>
				<h2
					style={{
						fontSize: "var(--font-size-xl)",
						fontWeight: "bold",
						margin: "0 0 var(--space-3) 0",
					}}
				>
					Kart harcaması kaydedildi
				</h2>
				<p
					style={{
						margin: "0 0 var(--space-2) 0",
						color: "var(--text-primary)",
						fontWeight: "var(--font-weight-medium)",
					}}
				>
					Kategori eşlemesi tamamlanamadı.
				</p>
				<p
					style={{
						margin: "0 0 var(--space-6) 0",
						color: "var(--text-secondary)",
						fontSize: "var(--font-size-sm)",
					}}
				>
					Finansal işlem tekrar gönderilmeyecek.
				</p>
				<button
					type="button"
					onClick={() => {
						if (onSuccess) onSuccess();
					}}
					className="btn btn-primary"
					data-testid="ack-category-warning-btn"
				>
					Tamam
				</button>
			</div>
		);
	}

	return (
		<form
			onSubmit={handleSubmit}
			className="manual-expense-form cc-quick-form"
			data-testid="credit-card-quick-form"
			noValidate
		>
			{/* Error Banner */}
			{errorMessage && (
				<div
					className="form-error-banner"
					role="alert"
					data-testid="cc-form-error-banner"
				>
					<span>{errorMessage}</span>
					{canRetry && (
						<button
							type="button"
							onClick={handleRetry}
							className="btn btn-secondary btn-sm"
							style={{ marginLeft: "12px" }}
							data-testid="cc-form-retry-btn"
						>
							Tekrar Dene
						</button>
					)}
				</div>
			)}

			{/* Stale Card Warning Banner */}
			{staleCardWarning && (
				<div
					className="form-warning-banner"
					role="alert"
					data-testid="stale-card-warning"
				>
					{staleCardWarning}
				</div>
			)}

			{/* Stale Category Warning Banner */}
			{staleCategoryWarning && (
				<div
					className="form-warning-banner"
					role="alert"
					data-testid="stale-category-warning"
				>
					{staleCategoryWarning}
				</div>
			)}

			{/* 1. Tutar * */}
			<div className="form-group">
				<label htmlFor="cc-purchase-amount" className="form-label required">
					Tutar *
				</label>
				<MoneyInput
					id="cc-purchase-amount"
					value={amountDisplay}
					onChange={(canonical, raw, isValid) => {
						setAmountCanonical(canonical);
						setAmountDisplay(raw);
						setAmountValid(isValid);
					}}
					required
					autoFocus={
						!config?.defaultAmount || Number(config.defaultAmount) <= 0
					}
				/>
			</div>

			{/* 2. Kart * */}
			<div className="form-group">
				<label htmlFor="cc-select" className="form-label required">
					Kart *
				</label>
				<select
					id="cc-select"
					value={selectedCardId}
					onChange={(e) => {
						setSelectedCardId(e.target.value);
						setStaleCardWarning(null);
					}}
					disabled={cardsLoading || isSubmitting}
					required
					className="form-select"
					data-testid="cc-select"
				>
					{cardsLoading ? (
						<option value="">Kartlar yükleniyor...</option>
					) : (
						<>
							{!selectedCardId && <option value="">Kart Seçin...</option>}
							{activeCards.map((c) => (
								<option key={c.cardId} value={c.cardId}>
									{c.displayName || c.issuer} ({c.code}
									{c.lastFour ? ` •••• ${c.lastFour}` : ""})
								</option>
							))}
						</>
					)}
				</select>
			</div>

			{/* 3. Kategori */}
			<div className="form-group">
				<label htmlFor="cc-category" className="form-label">
					Kategori
				</label>
				<select
					id="cc-category"
					value={spendingCategoryId}
					onChange={(e) => handleCategoryChange(e.target.value)}
					disabled={categoriesLoading || isSubmitting}
					className="form-select"
					data-testid="cc-category-select"
				>
					<option value="">Kategori Seçin (İsteğe bağlı)</option>
					{activeCategories.map((cat) => (
						<option key={cat.id} value={cat.id}>
							{cat.name}
						</option>
					))}
				</select>
			</div>

			{/* 4. Harcama Türü / Finansal Sınıf * */}
			<div className="form-group">
				<span id="cc-financial-class-label" className="form-label required">
					Harcama Türü / Finansal Sınıf *
				</span>

				{isAskCategory && (
					<p className="form-help-text" data-testid="cc-ask-category-hint">
						Bu harcama bu ay için:
					</p>
				)}

				<div
					className="financial-class-options"
					role="radiogroup"
					aria-labelledby="cc-financial-class-label"
				>
					<label className="radio-option">
						<input
							type="radio"
							name="ccBudgetCategory"
							value="MANDATORY_EXPENSE"
							checked={purchaseCategory === "MANDATORY_EXPENSE"}
							onChange={() => setPurchaseCategory("MANDATORY_EXPENSE")}
							disabled={isSubmitting}
							data-testid="cc-class-mandatory"
						/>
						<span>Zorunlu Temel İhtiyaç</span>
					</label>

					<label className="radio-option">
						<input
							type="radio"
							name="ccBudgetCategory"
							value="DISCRETIONARY_SPEND"
							checked={purchaseCategory === "DISCRETIONARY_SPEND"}
							onChange={() => setPurchaseCategory("DISCRETIONARY_SPEND")}
							disabled={isSubmitting}
							data-testid="cc-class-discretionary"
						/>
						<span>Keyfi / Esnek Harcama</span>
					</label>

					<label className="radio-option">
						<input
							type="radio"
							name="ccBudgetCategory"
							value="SHORT_TERM_PURCHASE"
							checked={purchaseCategory === "SHORT_TERM_PURCHASE"}
							onChange={() => setPurchaseCategory("SHORT_TERM_PURCHASE")}
							disabled={isSubmitting}
							data-testid="cc-class-short-term"
						/>
						<span>Planlı Kısa Vadeli Alım</span>
					</label>
				</div>
			</div>

			{/* 5. İşyeri */}
			<div className="form-group">
				<label htmlFor="cc-merchant" className="form-label">
					İşyeri
				</label>
				<input
					type="text"
					id="cc-merchant"
					value={merchant}
					onChange={(e) => setMerchant(e.target.value)}
					placeholder="Örn: Migros, Starbucks"
					disabled={isSubmitting}
					className="form-input"
					data-testid="cc-merchant-input"
				/>
			</div>

			{/* 6. Açıklama */}
			<div className="form-group">
				<label htmlFor="cc-description" className="form-label">
					Açıklama
				</label>
				<input
					type="text"
					id="cc-description"
					value={description}
					onChange={(e) => setDescription(e.target.value)}
					placeholder="Örn: Kahve molası"
					disabled={isSubmitting}
					className="form-input"
					data-testid="cc-description-input"
				/>
			</div>

			{/* 7. Tarih / Saat */}
			<div className="form-group">
				<label htmlFor="cc-occurred-at" className="form-label">
					Tarih / Saat (Europe/Istanbul)
				</label>
				<input
					type="datetime-local"
					id="cc-occurred-at"
					value={occurredAtLocal}
					onChange={(e) => setOccurredAtLocal(e.target.value)}
					disabled={isSubmitting}
					className="form-input"
					data-testid="cc-date-input"
				/>
			</div>

			{/* Form Actions */}
			<div className="form-actions">
				<button
					type="button"
					onClick={() => {
						if (onCancel) onCancel();
					}}
					disabled={isSubmitting}
					className="btn btn-secondary"
					data-testid="cc-cancel-btn"
				>
					Vazgeç
				</button>
				<button
					type="submit"
					disabled={isSubmitting || !amountValid}
					className="btn btn-primary"
					data-testid="cc-submit-btn"
				>
					{isSubmitting ? "Kaydediliyor..." : "Kart Harcamasını Kaydet"}
				</button>
			</div>
		</form>
	);
}
