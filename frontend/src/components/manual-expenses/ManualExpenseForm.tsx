/**
 * Manual Expense Form Component (Create & Edit Modes)
 *
 * Adheres strictly to Section 22-24, 27-31, 32-40, 44-46, 58-59:
 *   - Fields: Tutar *, Ödeme Kaynağı *, Kategori, Harcama Türü / Finansal Sınıf *, İşyeri, Açıklama, Tarih / Saat
 *   - Asset account selector loads all pages (after=<cursor>), shows only ACTIVE TRY ASSET accounts
 *   - Categories: only status === "ACTIVE" selectable
 *   - ASK default resolved explicitly: never sends ASK to backend
 *   - Category clear limitation: cannot delete category from existing assigned expense
 *   - Secondary verification: GET /spending/category-assignments verification warning without failing financial mutation
 *   - OCC: fresh revisionNo used as expectedRevisionNo on edit. On conflict, refetches latest detail.
 *   - Idempotency: single stable idempotency key per logical submission. Retry reuses exact key.
 *   - No float arithmetic. MoneyInput used.
 *   - Europe/Istanbul datetime-local parsing and formatting.
 */

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { ApiError } from "../../api/errors";
import {
	createManualExpense,
	fetchAllLedgerAccounts,
	fetchCategoryAssignment,
	fetchManualExpense,
	fetchSpendingCategories,
	updateManualExpense,
} from "../../api/manual-expenses-api";
import type {
	BudgetCategorySelection,
	CreateManualExpensePayload,
	LedgerAccountItem,
	UpdateManualExpensePayload,
} from "../../api/manual-expenses-types";
import {
	formatIstanbulDateTimeLocal,
	parseIstanbulDateTimeLocalToIso,
} from "../../lib/istanbul-date";
import { formatMoneyToTry } from "../../lib/money";
import { MoneyInput } from "../common/MoneyInput";

export interface ManualExpenseFormProps {
	mode: "create" | "edit";
	expenseId?: string | undefined;
	onSuccess?: ((transactionId: string) => void) | undefined;
	onCancel?: (() => void) | undefined;
}

export function ManualExpenseForm({
	mode,
	expenseId,
	onSuccess,
	onCancel,
}: ManualExpenseFormProps) {
	const queryClient = useQueryClient();
	const navigate = useNavigate();

	// 1. Fetch reference data: Asset accounts & Spending categories
	const { data: accounts, isLoading: accountsLoading } = useQuery<
		LedgerAccountItem[]
	>({
		queryKey: ["ledger-accounts"],
		queryFn: () => fetchAllLedgerAccounts(100),
		staleTime: 60_000,
	});

	const { data: categoriesData, isLoading: categoriesLoading } = useQuery({
		queryKey: ["spending-categories"],
		queryFn: fetchSpendingCategories,
		staleTime: 60_000,
	});

	// Filter usable source asset accounts: ASSET, TRY, not archived
	const selectableAccounts = (accounts ?? []).filter(
		(acc) =>
			acc.accountType === "ASSET" &&
			acc.currency === "TRY" &&
			acc.archived === false,
	);

	// Filter selectable categories: ACTIVE only
	const activeCategories = (categoriesData?.categories ?? []).filter(
		(c) => c.status === "ACTIVE",
	);

	// 2. Fetch existing expense detail for Edit mode
	const {
		data: expenseData,
		isLoading: expenseLoading,
		error: expenseFetchError,
		refetch: refetchExpense,
	} = useQuery({
		queryKey: ["manual-expense", expenseId],
		queryFn: () => fetchManualExpense(expenseId!),
		enabled: mode === "edit" && !!expenseId,
	});

	const existingExpense = expenseData?.expense;

	// Form State
	const [amountCanonical, setAmountCanonical] = useState<string>("");
	const [amountDisplay, setAmountDisplay] = useState<string>("");
	const [amountValid, setAmountValid] = useState<boolean>(false);
	const [sourceAssetAccountId, setSourceAssetAccountId] = useState<string>("");
	const [spendingCategoryId, setSpendingCategoryId] = useState<string>("");
	const [budgetCategory, setBudgetCategory] =
		useState<BudgetCategorySelection>("MANDATORY_EXPENSE");
	const [isAskCategory, setIsAskCategory] = useState<boolean>(false);
	const [merchant, setMerchant] = useState<string>("");
	const [description, setDescription] = useState<string>("");
	const [occurredAtLocal, setOccurredAtLocal] = useState<string>(() =>
		formatIstanbulDateTimeLocal(new Date()),
	);
	const [reasonNote, setReasonNote] = useState<string>("");

	// Submission state
	const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
	const [errorMessage, setErrorMessage] = useState<string | null>(null);
	const [secondaryWarning, setSecondaryWarning] = useState<string | null>(null);
	const [canRetry, setCanRetry] = useState<boolean>(false);

	// Stable idempotency key for the current logical submission attempt
	const currentIdempotencyKeyRef = useRef<string | null>(null);
	const lastSubmittedPayloadRef = useRef<
		CreateManualExpensePayload | UpdateManualExpensePayload | null
	>(null);

	// Pre-fill form when editing
	useEffect(() => {
		if (mode === "edit" && existingExpense) {
			const payload = existingExpense.payload ?? {};

			const amt =
				typeof payload.amount === "string"
					? payload.amount
					: existingExpense.amount;
			setAmountCanonical(amt);
			const parts = amt.split(".");
			const w = parts[0] ?? amt;
			const d = parts[1];
			setAmountDisplay(d !== undefined ? `${w},${d}` : w);
			setAmountValid(true);

			if (typeof payload.sourceAssetAccountId === "string") {
				setSourceAssetAccountId(payload.sourceAssetAccountId);
			}

			if (typeof payload.spendingCategoryId === "string") {
				setSpendingCategoryId(payload.spendingCategoryId);
			}

			if (
				payload.budgetCategory === "MANDATORY_EXPENSE" ||
				payload.budgetCategory === "DISCRETIONARY_SPEND" ||
				payload.budgetCategory === "SHORT_TERM_PURCHASE"
			) {
				setBudgetCategory(payload.budgetCategory as BudgetCategorySelection);
			}

			if (typeof payload.merchant === "string") {
				setMerchant(payload.merchant);
			}

			if (typeof payload.description === "string") {
				setDescription(payload.description);
			}

			if (existingExpense.occurredAt) {
				setOccurredAtLocal(
					formatIstanbulDateTimeLocal(new Date(existingExpense.occurredAt)),
				);
			}
		}
	}, [mode, existingExpense]);

	// Auto-select first available asset account if creating and none selected
	useEffect(() => {
		const first = selectableAccounts[0];
		if (mode === "create" && !sourceAssetAccountId && first) {
			setSourceAssetAccountId(first.accountId);
		}
	}, [mode, sourceAssetAccountId, selectableAccounts]);

	// When user changes category, apply category default budgetCategory
	const handleCategoryChange = (catId: string) => {
		setSpendingCategoryId(catId);
		if (!catId) {
			setIsAskCategory(false);
			return;
		}

		const category = activeCategories.find((c) => c.id === catId);
		if (!category) return;

		if (category.defaultBudgetCategory === "ASK") {
			setIsAskCategory(true);
			// Section 37: "default MANDATORY_EXPENSE but the user can switch before save. Never send ASK."
			setBudgetCategory("MANDATORY_EXPENSE");
		} else {
			setIsAskCategory(false);
			setBudgetCategory(category.defaultBudgetCategory);
		}
	};

	// Map domain errors to natural Turkish
	const mapFormError = (err: unknown): string => {
		if (err instanceof ApiError) {
			switch (err.code) {
				case "MANUAL_EXPENSE_INVALID_INPUT":
					return "Girdiğiniz bilgileri kontrol edin.";
				case "MANUAL_EXPENSE_NOT_FOUND":
					return "Harcama kaydı bulunamadı.";
				case "MANUAL_EXPENSE_REVISION_CONFLICT":
					return "Bu harcama başka bir işlemle güncellendi. Son hali yüklendi.";
				case "MANUAL_EXPENSE_IDEMPOTENCY_CONFLICT":
					return "Bu işlem daha önce farklı bilgilerle gönderilmiş. Lütfen formu gözden geçirin.";
				case "MANUAL_EXPENSE_ALREADY_VOID":
					return "Bu harcama zaten iptal edilmiş.";
				case "MANUAL_EXPENSE_CONFLICT":
					return "Çakışma oluştu. Lütfen tekrar deneyin.";
				case "UNAUTHENTICATED":
					return "Oturum süresi doldu. Lütfen tekrar giriş yapın.";
				case "NETWORK_ERROR":
					return "Harcamanın kaydedilip kaydedilmediği doğrulanamadı.";
				default:
					return "Bir hata oluştu. Lütfen tekrar deneyin.";
			}
		}
		return "Harcama kaydedilirken beklenmeyen bir hata oluştu.";
	};

	// Execute submission
	const executeSubmit = async (
		payload: CreateManualExpensePayload | UpdateManualExpensePayload,
		idempotencyKey: string,
	) => {
		setIsSubmitting(true);
		setErrorMessage(null);
		setSecondaryWarning(null);

		try {
			let resultTransactionId: string;

			if (mode === "create") {
				const res = await createManualExpense(
					payload as CreateManualExpensePayload,
					idempotencyKey,
				);
				resultTransactionId = res.transactionId;
			} else {
				const res = await updateManualExpense(
					expenseId!,
					payload as UpdateManualExpensePayload,
					idempotencyKey,
				);
				resultTransactionId = res.transactionId;
			}

			// Financial mutation succeeded!
			// Check secondary category assignment if spendingCategoryId was supplied
			if (payload.spendingCategoryId) {
				try {
					const assignRes = await fetchCategoryAssignment(resultTransactionId);
					const confirmedCatId =
						assignRes.assignments?.[resultTransactionId] ??
						assignRes.assignment?.categoryId;

					if (confirmedCatId !== payload.spendingCategoryId) {
						setSecondaryWarning(
							"Harcama kaydedildi ancak kategori eşlemesi doğrulanamadı.",
						);
					}
				} catch {
					setSecondaryWarning(
						"Harcama kaydedildi ancak kategori eşlemesi doğrulanamadı.",
					);
				}
			}

			// Invalidate all relevant queries per Section 49
			await Promise.all([
				queryClient.invalidateQueries({ queryKey: ["transactions"] }),
				queryClient.invalidateQueries({
					queryKey: ["transaction", resultTransactionId],
				}),
				queryClient.invalidateQueries({
					queryKey: ["transaction-revisions", resultTransactionId],
				}),
				queryClient.invalidateQueries({
					queryKey: ["manual-expense", resultTransactionId],
				}),
				queryClient.invalidateQueries({ queryKey: ["ledger-accounts"] }),
				queryClient.invalidateQueries({ queryKey: ["spending-summary"] }),
			]);

			setCanRetry(false);
			currentIdempotencyKeyRef.current = null;
			lastSubmittedPayloadRef.current = null;

			if (onSuccess) {
				onSuccess(resultTransactionId);
			} else {
				void navigate({ to: "/transactions" });
			}
		} catch (err) {
			const mapped = mapFormError(err);
			setErrorMessage(mapped);

			if (err instanceof ApiError) {
				if (err.code === "NETWORK_ERROR") {
					// Network failure: offer retry with SAME key and payload
					setCanRetry(true);
				} else if (err.code === "MANUAL_EXPENSE_REVISION_CONFLICT") {
					// Section 30: stop mutation, refetch latest expense detail
					setCanRetry(false);
					currentIdempotencyKeyRef.current = null;
					if (mode === "edit") {
						void refetchExpense();
					}
				} else {
					// Logical/input/idempotency conflict: do not auto-retry
					setCanRetry(false);
					currentIdempotencyKeyRef.current = null;
				}
			} else {
				setCanRetry(false);
			}
		} finally {
			setIsSubmitting(false);
		}
	};

	const handleSubmit = (e: React.FormEvent) => {
		e.preventDefault();

		if (!amountValid || !amountCanonical) {
			setErrorMessage("Lütfen geçerli bir tutar girin.");
			return;
		}

		if (!sourceAssetAccountId) {
			setErrorMessage("Lütfen bir ödeme kaynağı seçin.");
			return;
		}

		let occurredAtIso: string;
		try {
			occurredAtIso = parseIstanbulDateTimeLocalToIso(occurredAtLocal);
		} catch {
			setErrorMessage("Geçersiz tarih veya saat.");
			return;
		}

		// New logical submission attempt: generate fresh idempotency key
		const key = crypto.randomUUID();
		currentIdempotencyKeyRef.current = key;

		if (mode === "create") {
			const payload: CreateManualExpensePayload = {
				amount: amountCanonical,
				sourceAssetAccountId,
				budgetCategory,
				spendingCategoryId: spendingCategoryId || undefined,
				merchant: merchant.trim() || undefined,
				description: description.trim() || undefined,
				occurredAt: occurredAtIso,
			};
			lastSubmittedPayloadRef.current = payload;
			void executeSubmit(payload, key);
		} else {
			// Edit mode: fetch latest expectedRevisionNo
			if (!existingExpense) {
				setErrorMessage("Harcama bilgisi yüklenemedi.");
				return;
			}

			const payload: UpdateManualExpensePayload = {
				expectedRevisionNo: existingExpense.revisionNo,
				amount: amountCanonical,
				sourceAssetAccountId,
				budgetCategory,
				spendingCategoryId: spendingCategoryId || undefined,
				merchant: merchant.trim() || undefined,
				description: description.trim() || undefined,
				occurredAt: occurredAtIso,
				reasonNote: reasonNote.trim() || undefined,
			};
			lastSubmittedPayloadRef.current = payload;
			void executeSubmit(payload, key);
		}
	};

	const handleRetry = () => {
		if (
			canRetry &&
			currentIdempotencyKeyRef.current &&
			lastSubmittedPayloadRef.current
		) {
			void executeSubmit(
				lastSubmittedPayloadRef.current,
				currentIdempotencyKeyRef.current,
			);
		}
	};

	// Guard: If editing a VOIDED expense
	if (mode === "edit" && existingExpense?.status === "VOIDED") {
		return (
			<div
				className="voided-expense-warning card"
				data-testid="voided-expense-card"
			>
				<h3>Bu harcama iptal edilmiş.</h3>
				<p>İptal edilen bir harcama üzerinde değişiklik yapılamaz.</p>
				<button
					type="button"
					onClick={() => {
						if (onCancel) onCancel();
						else void navigate({ to: "/transactions" });
					}}
					className="btn btn-secondary"
				>
					Hareketlere Dön
				</button>
			</div>
		);
	}

	if (mode === "edit" && expenseLoading) {
		return (
			<div className="form-loading-state" data-testid="form-loading">
				<div
					className="skeleton"
					style={{ height: "40px", marginBottom: "16px" }}
				/>
				<div
					className="skeleton"
					style={{ height: "40px", marginBottom: "16px" }}
				/>
				<div className="skeleton" style={{ height: "40px" }} />
			</div>
		);
	}

	if (mode === "edit" && expenseFetchError) {
		return (
			<div className="form-error-banner" data-testid="form-fetch-error">
				<p>Harcama ayrıntıları alınamadı.</p>
				<button
					type="button"
					onClick={() => refetchExpense()}
					className="btn btn-secondary btn-sm"
				>
					Tekrar Dene
				</button>
			</div>
		);
	}

	return (
		<form
			onSubmit={handleSubmit}
			className="manual-expense-form"
			data-testid="manual-expense-form"
			noValidate
		>
			{/* Error Banner */}
			{errorMessage && (
				<div
					className="form-error-banner"
					role="alert"
					data-testid="form-error-banner"
				>
					<span>{errorMessage}</span>
					{canRetry && (
						<button
							type="button"
							onClick={handleRetry}
							className="btn btn-secondary btn-sm"
							style={{ marginLeft: "12px" }}
							data-testid="form-retry-btn"
						>
							Tekrar Dene
						</button>
					)}
				</div>
			)}

			{/* Secondary Warning Banner (Category assignment failure) */}
			{secondaryWarning && (
				<div
					className="form-warning-banner"
					role="alert"
					data-testid="form-secondary-warning"
				>
					{secondaryWarning}
				</div>
			)}

			{/* 1. Tutar * */}
			<div className="form-group">
				<label htmlFor="expense-amount" className="form-label required">
					Tutar *
				</label>
				<MoneyInput
					id="expense-amount"
					value={amountDisplay}
					onChange={(canonical, raw, isValid) => {
						setAmountCanonical(canonical);
						setAmountDisplay(raw);
						setAmountValid(isValid);
					}}
					required
					autoFocus={mode === "create"}
				/>
			</div>

			{/* 2. Ödeme Kaynağı * */}
			<div className="form-group">
				<label htmlFor="expense-account" className="form-label required">
					Ödeme Kaynağı *
				</label>
				<select
					id="expense-account"
					value={sourceAssetAccountId}
					onChange={(e) => setSourceAssetAccountId(e.target.value)}
					disabled={accountsLoading || isSubmitting}
					required
					className="form-select"
					data-testid="expense-account-select"
				>
					{accountsLoading ? (
						<option value="">Hesaplar yükleniyor...</option>
					) : (
						selectableAccounts.map((acc) => (
							<option key={acc.accountId} value={acc.accountId}>
								{acc.name} ({formatMoneyToTry(acc.balance.balance)})
							</option>
						))
					)}
				</select>
			</div>

			{/* 3. Kategori */}
			<div className="form-group">
				<label htmlFor="expense-category" className="form-label">
					Kategori
				</label>
				<select
					id="expense-category"
					value={spendingCategoryId}
					onChange={(e) => handleCategoryChange(e.target.value)}
					disabled={categoriesLoading || isSubmitting}
					className="form-select"
					data-testid="expense-category-select"
				>
					{/* Section 39: If editing and already had a category, do not offer clearing it */}
					{mode === "create" ||
					!existingExpense?.payload?.spendingCategoryId ? (
						<option value="">Kategori Seçin (İsteğe bağlı)</option>
					) : null}
					{activeCategories.map((cat) => (
						<option key={cat.id} value={cat.id}>
							{cat.name}
						</option>
					))}
				</select>
			</div>

			{/* 4. Harcama Türü / Finansal Sınıf * */}
			<div className="form-group">
				<span id="financial-class-label" className="form-label required">
					Harcama Türü / Finansal Sınıf *
				</span>

				{isAskCategory && (
					<p className="form-help-text" data-testid="ask-category-hint">
						Bu harcama bu ay için:
					</p>
				)}

				<div
					className="financial-class-options"
					role="radiogroup"
					aria-labelledby="financial-class-label"
				>
					<label className="radio-option">
						<input
							type="radio"
							name="budgetCategory"
							value="MANDATORY_EXPENSE"
							checked={budgetCategory === "MANDATORY_EXPENSE"}
							onChange={() => setBudgetCategory("MANDATORY_EXPENSE")}
							disabled={isSubmitting}
							data-testid="class-mandatory"
						/>
						<span>Zorunlu Temel İhtiyaç</span>
					</label>

					<label className="radio-option">
						<input
							type="radio"
							name="budgetCategory"
							value="DISCRETIONARY_SPEND"
							checked={budgetCategory === "DISCRETIONARY_SPEND"}
							onChange={() => setBudgetCategory("DISCRETIONARY_SPEND")}
							disabled={isSubmitting}
							data-testid="class-discretionary"
						/>
						<span>Keyfi / Esnek Harcama</span>
					</label>

					<label className="radio-option">
						<input
							type="radio"
							name="budgetCategory"
							value="SHORT_TERM_PURCHASE"
							checked={budgetCategory === "SHORT_TERM_PURCHASE"}
							onChange={() => setBudgetCategory("SHORT_TERM_PURCHASE")}
							disabled={isSubmitting}
							data-testid="class-short-term"
						/>
						<span>Planlı Kısa Vadeli Alım</span>
					</label>
				</div>
			</div>

			{/* 5. İşyeri */}
			<div className="form-group">
				<label htmlFor="expense-merchant" className="form-label">
					İşyeri
				</label>
				<input
					type="text"
					id="expense-merchant"
					value={merchant}
					onChange={(e) => setMerchant(e.target.value)}
					placeholder="Örn: Migros, Starbucks"
					disabled={isSubmitting}
					className="form-input"
					data-testid="expense-merchant-input"
				/>
			</div>

			{/* 6. Açıklama */}
			<div className="form-group">
				<label htmlFor="expense-description" className="form-label">
					Açıklama
				</label>
				<input
					type="text"
					id="expense-description"
					value={description}
					onChange={(e) => setDescription(e.target.value)}
					placeholder="Örn: Haftalık market alışverişi"
					disabled={isSubmitting}
					className="form-input"
					data-testid="expense-description-input"
				/>
			</div>

			{/* 7. Tarih / Saat */}
			<div className="form-group">
				<label htmlFor="expense-occurred-at" className="form-label">
					Tarih / Saat (Europe/Istanbul)
				</label>
				<input
					type="datetime-local"
					id="expense-occurred-at"
					value={occurredAtLocal}
					onChange={(e) => setOccurredAtLocal(e.target.value)}
					disabled={isSubmitting}
					className="form-input"
					data-testid="expense-date-input"
				/>
			</div>

			{/* 8. Değişiklik Notu (Edit mode only) */}
			{mode === "edit" && (
				<div className="form-group">
					<label htmlFor="expense-reason-note" className="form-label">
						Değişiklik Notu (İsteğe bağlı)
					</label>
					<input
						type="text"
						id="expense-reason-note"
						value={reasonNote}
						onChange={(e) => setReasonNote(e.target.value)}
						placeholder="Örn: Fiş tutarı düzeltildi"
						disabled={isSubmitting}
						className="form-input"
						data-testid="expense-reason-note-input"
					/>
				</div>
			)}

			{/* Form Actions */}
			<div className="form-actions">
				<button
					type="button"
					onClick={() => {
						if (onCancel) onCancel();
						else void navigate({ to: "/transactions" });
					}}
					disabled={isSubmitting}
					className="btn btn-secondary"
					data-testid="expense-cancel-btn"
				>
					Vazgeç
				</button>
				<button
					type="submit"
					disabled={isSubmitting || !amountValid}
					className="btn btn-primary"
					data-testid="expense-submit-btn"
				>
					{isSubmitting
						? "Kaydediliyor..."
						: mode === "create"
							? "Harcamayı Kaydet"
							: "Değişiklikleri Kaydet"}
				</button>
			</div>
		</form>
	);
}
