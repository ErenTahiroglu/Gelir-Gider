import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, ArrowLeft, RefreshCw, Save } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { ApiError, isNetworkUncertainError } from "../../../api/errors";
import { fetchAllLedgerAccounts } from "../../../api/manual-expenses-api";
import {
	createPersonPayable,
	createPersonReceivable,
	fetchPersonObligation,
	updatePersonObligation,
} from "../../../api/people-api";
import type {
	CreatePayablePayload,
	CreateReceivablePayload,
	ObligationBudgetCategory,
	ObligationProductDto,
	PersonObligationDirection,
	UpdateObligationPayload,
} from "../../../api/people-types";
import { normalizeTurkishMoneyInput } from "../../../lib/money";
import { MoneyInput } from "../../common/MoneyInput";

interface ObligationFormProps {
	mode: "create" | "edit";
	personId: string;
	obligationId?: string | undefined;
	initialDirection?: PersonObligationDirection | undefined;
	initialValues?:
		| {
				amount?: string | undefined;
				description?: string | undefined;
				dueDate?: string | undefined;
		  }
		| undefined;
	onSuccess?: ((obligation: ObligationProductDto) => void) | undefined;
	onCancel?: (() => void) | undefined;
}

export function ObligationForm({
	mode,
	personId,
	obligationId,
	initialDirection = "RECEIVABLE",
	initialValues,
	onSuccess,
	onCancel,
}: ObligationFormProps) {
	const queryClient = useQueryClient();

	// If in edit mode, fetch fresh obligation
	const {
		data: obligationData,
		isLoading: isFetchingObligation,
		error: fetchObligationError,
		refetch: refetchObligation,
	} = useQuery({
		queryKey: ["person-obligation", personId, obligationId],
		queryFn: () =>
			obligationId ? fetchPersonObligation(personId, obligationId) : null,
		enabled: mode === "edit" && Boolean(obligationId),
		staleTime: 0,
	});

	const initialObligation = obligationData?.obligation;

	// Accounts for fundingAssetAccountId (in receivable)
	const { data: accounts, isLoading: accountsLoading } = useQuery({
		queryKey: ["ledger-accounts"],
		queryFn: () => fetchAllLedgerAccounts(100),
		staleTime: 60_000,
	});

	const selectableAccounts = useMemo(
		() =>
			(accounts ?? []).filter(
				(acc) =>
					acc.accountType === "ASSET" &&
					acc.currency === "TRY" &&
					acc.archived === false,
			),
		[accounts],
	);

	const [direction, setDirection] =
		useState<PersonObligationDirection>(initialDirection);
	const [amount, setAmount] = useState(initialValues?.amount ?? "");
	const [fundingAssetAccountId, setFundingAssetAccountId] = useState("");
	const [budgetCategory, setBudgetCategory] =
		useState<ObligationBudgetCategory>("MANDATORY_EXPENSE");
	const [dueDate, setDueDate] = useState(initialValues?.dueDate ?? "");
	const [description, setDescription] = useState(
		initialValues?.description ?? "",
	);

	const [validationError, setValidationError] = useState<string | null>(null);
	const [apiError, setApiError] = useState<string | null>(null);
	const [revisionConflict, setRevisionConflict] = useState(false);
	const [isNetworkUncertain, setIsNetworkUncertain] = useState(false);

	const frozenAttemptRef = useRef<{
		key: string;
		payload:
			| CreateReceivablePayload
			| CreatePayablePayload
			| UpdateObligationPayload;
	} | null>(null);

	// If selectableAccounts loaded and no funding account selected yet, pick first
	useEffect(() => {
		const first = selectableAccounts[0];
		if (!fundingAssetAccountId && first) {
			setFundingAssetAccountId(first.accountId);
		}
	}, [fundingAssetAccountId, selectableAccounts]);

	// Sync edit data
	useEffect(() => {
		if (mode === "edit" && initialObligation) {
			setDirection(initialObligation.direction);
			setAmount(initialObligation.principalAmount);
			if (initialObligation.fundingAssetAccountId) {
				setFundingAssetAccountId(initialObligation.fundingAssetAccountId);
			}
			if (
				initialObligation.budgetCategory &&
				(initialObligation.budgetCategory === "MANDATORY_EXPENSE" ||
					initialObligation.budgetCategory === "DISCRETIONARY_SPEND" ||
					initialObligation.budgetCategory === "SHORT_TERM_PURCHASE")
			) {
				setBudgetCategory(
					initialObligation.budgetCategory as ObligationBudgetCategory,
				);
			}
			setDueDate(initialObligation.dueDate ?? "");
			setDescription(initialObligation.description ?? "");
			setRevisionConflict(false);
		}
	}, [mode, initialObligation]);

	const mutation = useMutation({
		mutationFn: async (attempt: {
			key: string;
			payload:
				| CreateReceivablePayload
				| CreatePayablePayload
				| UpdateObligationPayload;
		}) => {
			if (mode === "create") {
				if (direction === "RECEIVABLE") {
					return createPersonReceivable(
						personId,
						attempt.payload as CreateReceivablePayload,
						attempt.key,
					);
				}
				return createPersonPayable(
					personId,
					attempt.payload as CreatePayablePayload,
					attempt.key,
				);
			}

			// Edit mode
			if (!obligationId || !initialObligation) {
				throw new Error("Kayıt bilgisi bulunamadı.");
			}

			if (initialObligation.isSplitManaged) {
				throw new Error(
					"Bu alacak kart harcaması bölüşümünden oluşturuldu. Tutarı değiştirmek için ilgili ortak harcamayı düzenleyin.",
				);
			}

			return updatePersonObligation(
				personId,
				obligationId,
				attempt.payload as UpdateObligationPayload,
				attempt.key,
			);
		},
		retry: false,
		onSuccess: (data) => {
			// Query invalidation per Section 56
			void queryClient.invalidateQueries({ queryKey: ["people"] });
			void queryClient.invalidateQueries({ queryKey: ["active-people"] });
			void queryClient.invalidateQueries({ queryKey: ["person", personId] });
			void queryClient.invalidateQueries({
				queryKey: ["person-balance-summary", personId],
			});
			void queryClient.invalidateQueries({
				queryKey: ["person-obligations", personId],
			});
			if (obligationId) {
				void queryClient.invalidateQueries({
					queryKey: ["person-obligation", personId, obligationId],
				});
			}
			void queryClient.invalidateQueries({ queryKey: ["transactions"] });
			void queryClient.invalidateQueries({ queryKey: ["ledger-accounts"] });
			void queryClient.invalidateQueries({ queryKey: ["spending-summary"] });

			frozenAttemptRef.current = null;
			setIsNetworkUncertain(false);
			setRevisionConflict(false);
			onSuccess?.(data.obligation);
		},
		onError: (err) => {
			if (isNetworkUncertainError(err)) {
				setIsNetworkUncertain(true);
				setApiError(
					"Kaydın tamamlanıp tamamlanmadığı doğrulanamadı. Aynı işlemi güvenli şekilde tekrar kontrol edebilirsiniz.",
				);
			} else if (err instanceof ApiError) {
				frozenAttemptRef.current = null;
				setIsNetworkUncertain(false);
				if (err.code === "PEOPLE_OBLIGATION_REVISION_CONFLICT") {
					setRevisionConflict(true);
					setApiError(
						"Borç/alacak kaydı başka bir işlem tarafından güncellendi. Lütfen sayfayı yenileyip tekrar deneyin.",
					);
				} else {
					setApiError(err.userMessage);
				}
			} else if (err instanceof Error) {
				frozenAttemptRef.current = null;
				setIsNetworkUncertain(false);
				setApiError(err.message);
			} else {
				frozenAttemptRef.current = null;
				setIsNetworkUncertain(false);
				setApiError("İşlem sırasında bir hata oluştu.");
			}
		},
	});

	const handleSubmit = (e: React.FormEvent) => {
		e.preventDefault();
		if (isNetworkUncertain) return;

		setValidationError(null);
		setApiError(null);

		const norm = normalizeTurkishMoneyInput(amount);
		if (!norm.valid || !norm.canonical || norm.cents === undefined) {
			setValidationError(norm.error ?? "Geçerli bir tutar girin.");
			return;
		}
		if (norm.cents <= 0n) {
			setValidationError("Tutar sıfırdan büyük olmalıdır.");
			return;
		}

		if (description.trim().length > 500) {
			setValidationError("Açıklama en fazla 500 karakter olabilir.");
			return;
		}

		if (direction === "RECEIVABLE" && !fundingAssetAccountId) {
			setValidationError("Lütfen paranın verildiği hesabı seçin.");
			return;
		}

		if (mode === "edit" && initialObligation?.isSplitManaged) {
			setValidationError(
				"Bu alacak kart harcaması bölüşümünden oluşturuldu. Tutarı değiştirmek için ilgili ortak harcamayı düzenleyin.",
			);
			return;
		}

		const key = crypto.randomUUID();
		const occurredAt = new Date().toISOString();
		const trimmedDueDate = dueDate.trim() !== "" ? dueDate.trim() : undefined;
		const trimmedDesc =
			description.trim() !== "" ? description.trim() : undefined;

		let payload:
			| CreateReceivablePayload
			| CreatePayablePayload
			| UpdateObligationPayload;

		if (mode === "create") {
			if (direction === "RECEIVABLE") {
				payload = {
					amount: norm.canonical,
					fundingAssetAccountId,
					dueDate: trimmedDueDate,
					description: trimmedDesc,
					occurredAt,
				};
			} else {
				payload = {
					amount: norm.canonical,
					budgetCategory,
					dueDate: trimmedDueDate,
					description: trimmedDesc,
					occurredAt,
				};
			}
		} else {
			if (!obligationId || !initialObligation) {
				setValidationError("Kayıt bilgisi bulunamadı.");
				return;
			}

			payload = {
				expectedRevisionNo: initialObligation.revisionNo,
				amount: norm.canonical,
				fundingAssetAccountId:
					direction === "RECEIVABLE" ? fundingAssetAccountId : undefined,
				budgetCategory: direction === "PAYABLE" ? budgetCategory : undefined,
				dueDate: trimmedDueDate,
				description: trimmedDesc,
				occurredAt,
			};
		}

		frozenAttemptRef.current = { key, payload };
		mutation.mutate(frozenAttemptRef.current);
	};

	const handleRetryUncertain = () => {
		if (frozenAttemptRef.current) {
			setApiError(null);
			mutation.mutate(frozenAttemptRef.current);
		}
	};

	const handleReloadConflict = async () => {
		frozenAttemptRef.current = null;
		setIsNetworkUncertain(false);
		setRevisionConflict(false);
		setApiError(null);
		await refetchObligation();
	};

	if (mode === "edit" && isFetchingObligation) {
		return (
			<div className="obligation-form-loading">
				<p>Borç/alacak kaydı yükleniyor...</p>
			</div>
		);
	}

	if (mode === "edit" && fetchObligationError) {
		return (
			<div className="alert alert-danger">
				<AlertCircle size={18} aria-hidden="true" />
				<span>Kayıt bilgileri yüklenemedi. Lütfen tekrar deneyin.</span>
			</div>
		);
	}

	if (mode === "edit" && initialObligation?.isSplitManaged) {
		return (
			<div
				className="split-managed-notice-card card"
				data-testid="split-managed-notice"
			>
				<span className="badge badge-info">Kart bölüşümünden</span>
				<p>
					Bu alacak kart harcaması bölüşümünden oluşturuldu. Tutarı değiştirmek
					için ilgili ortak harcamayı düzenleyin.
				</p>
				{onCancel && (
					<button
						type="button"
						className="btn btn-secondary"
						onClick={onCancel}
					>
						Geri Dön
					</button>
				)}
			</div>
		);
	}

	return (
		<form
			onSubmit={handleSubmit}
			className="obligation-form"
			data-testid="obligation-form"
			noValidate
		>
			{validationError && (
				<div
					className="alert alert-danger"
					role="alert"
					data-testid="obligation-validation-error"
				>
					<AlertCircle size={18} aria-hidden="true" />
					<span>{validationError}</span>
				</div>
			)}

			{apiError && (
				<div
					className="alert alert-danger"
					role="alert"
					data-testid="obligation-api-error"
				>
					<AlertCircle size={18} aria-hidden="true" />
					<span>{apiError}</span>
				</div>
			)}

			{revisionConflict && (
				<div
					className="obligation-conflict-box alert alert-warning"
					data-testid="obligation-conflict-box"
				>
					<div className="conflict-message">
						<strong>Güncelleme Çakışması</strong>
						<p>
							Bu kayıt başka bir işlem tarafından güncellendi. Devam etmeden
							önce güncel bilgileri yükleyin.
						</p>
					</div>
					<button
						type="button"
						className="btn btn-secondary btn-sm"
						onClick={handleReloadConflict}
						data-testid="reload-obligation-conflict-btn"
					>
						<RefreshCw size={14} aria-hidden="true" />
						<span>Güncel Veriyi Yükle</span>
					</button>
				</div>
			)}

			{isNetworkUncertain && (
				<div
					className="obligation-uncertain-box alert alert-warning"
					role="alert"
					data-testid="obligation-uncertain-alert"
				>
					<AlertCircle size={18} aria-hidden="true" />
					<div className="uncertain-message">
						<strong>Doğrulanamayan İşlem Durumu</strong>
						<p>
							Kaydın tamamlanıp tamamlanmadığı doğrulanamadı. Aynı işlemi
							güvenli şekilde tekrar kontrol edebilirsiniz.
						</p>
						<button
							type="button"
							className="btn btn-secondary btn-sm mt-2"
							onClick={handleRetryUncertain}
							disabled={mutation.isPending}
							data-testid="retry-uncertain-btn"
						>
							<RefreshCw size={14} aria-hidden="true" />
							<span>Aynı İşlemi Tekrar Dene</span>
						</button>
					</div>
				</div>
			)}

			{/* Direction toggle only in create mode */}
			{mode === "create" && (
				<div className="form-group">
					<span className="form-label">İşlem Türü</span>
					<div
						className="direction-toggle-grid"
						role="radiogroup"
						aria-label="İşlem Türü"
					>
						<button
							type="button"
							className={`direction-btn ${direction === "RECEIVABLE" ? "selected receivable" : ""}`}
							onClick={() => setDirection("RECEIVABLE")}
							disabled={mutation.isPending || isNetworkUncertain}
							data-testid="direction-receivable-btn"
						>
							<span className="direction-title">Borç Verdim</span>
							<span className="direction-subtitle">Bana Ödeyecek</span>
						</button>

						<button
							type="button"
							className={`direction-btn ${direction === "PAYABLE" ? "selected payable" : ""}`}
							onClick={() => setDirection("PAYABLE")}
							disabled={mutation.isPending || isNetworkUncertain}
							data-testid="direction-payable-btn"
						>
							<span className="direction-title">Borçlandım</span>
							<span className="direction-subtitle">Ben Ödeyeceğim</span>
						</button>
					</div>
				</div>
			)}

			{/* Tutar */}
			<div className="form-group">
				<label htmlFor="obligation-amount" className="form-label">
					Tutar <span className="required-star">*</span>
				</label>
				<MoneyInput
					id="obligation-amount"
					value={amount}
					onChange={(val) => setAmount(val)}
					disabled={
						mutation.isPending || revisionConflict || isNetworkUncertain
					}
					data-testid="obligation-amount-input"
					required
				/>
			</div>

			{/* Paranın Çıktığı Hesap (Only for RECEIVABLE) */}
			{direction === "RECEIVABLE" && (
				<div className="form-group">
					<label htmlFor="obligation-funding-account" className="form-label">
						Paranın Verildiği Hesap <span className="required-star">*</span>
					</label>
					{accountsLoading ? (
						<p className="text-secondary">Hesaplar yükleniyor...</p>
					) : (
						<select
							id="obligation-funding-account"
							className="form-control"
							value={fundingAssetAccountId}
							onChange={(e) => setFundingAssetAccountId(e.target.value)}
							disabled={
								mutation.isPending || revisionConflict || isNetworkUncertain
							}
							data-testid="obligation-funding-account-select"
							required
						>
							{selectableAccounts.map((acc) => (
								<option key={acc.accountId} value={acc.accountId}>
									{acc.name}
								</option>
							))}
						</select>
					)}
					<span className="form-hint">
						Verilen borç bakiyesinin düşüleceği varlık hesabınız.
					</span>
				</div>
			)}

			{/* Harcama Sınıfı (Only for PAYABLE) */}
			{direction === "PAYABLE" && (
				<div className="form-group">
					<span className="form-label">
						Harcama Sınıfı <span className="required-star">*</span>
					</span>
					<div
						className="budget-category-options-grid"
						role="radiogroup"
						aria-label="Harcama Sınıfı"
					>
						<label
							className={`budget-category-card ${budgetCategory === "MANDATORY_EXPENSE" ? "selected" : ""}`}
						>
							<input
								type="radio"
								name="budgetCategory"
								value="MANDATORY_EXPENSE"
								checked={budgetCategory === "MANDATORY_EXPENSE"}
								onChange={() => setBudgetCategory("MANDATORY_EXPENSE")}
								disabled={
									mutation.isPending || revisionConflict || isNetworkUncertain
								}
								data-testid="budget-mandatory"
							/>
							<span className="category-title">Zorunlu Temel İhtiyaç</span>
						</label>

						<label
							className={`budget-category-card ${budgetCategory === "DISCRETIONARY_SPEND" ? "selected" : ""}`}
						>
							<input
								type="radio"
								name="budgetCategory"
								value="DISCRETIONARY_SPEND"
								checked={budgetCategory === "DISCRETIONARY_SPEND"}
								onChange={() => setBudgetCategory("DISCRETIONARY_SPEND")}
								disabled={
									mutation.isPending || revisionConflict || isNetworkUncertain
								}
								data-testid="budget-discretionary"
							/>
							<span className="category-title">Keyfi / Esnek Harcama</span>
						</label>

						<label
							className={`budget-category-card ${budgetCategory === "SHORT_TERM_PURCHASE" ? "selected" : ""}`}
						>
							<input
								type="radio"
								name="budgetCategory"
								value="SHORT_TERM_PURCHASE"
								checked={budgetCategory === "SHORT_TERM_PURCHASE"}
								onChange={() => setBudgetCategory("SHORT_TERM_PURCHASE")}
								disabled={
									mutation.isPending || revisionConflict || isNetworkUncertain
								}
								data-testid="budget-short-term"
							/>
							<span className="category-title">Planlı Kısa Vadeli Alım</span>
						</label>
					</div>
				</div>
			)}

			{/* Vade Tarihi */}
			<div className="form-group">
				<label htmlFor="obligation-dueDate" className="form-label">
					Vade Tarihi (İsteğe Bağlı)
				</label>
				<input
					id="obligation-dueDate"
					type="date"
					className="form-control"
					value={dueDate}
					onChange={(e) => setDueDate(e.target.value)}
					disabled={
						mutation.isPending || revisionConflict || isNetworkUncertain
					}
					data-testid="obligation-duedate-input"
				/>
			</div>

			{/* Açıklama */}
			<div className="form-group">
				<label htmlFor="obligation-description" className="form-label">
					Açıklama (İsteğe Bağlı)
				</label>
				<input
					id="obligation-description"
					type="text"
					className="form-control"
					value={description}
					onChange={(e) => setDescription(e.target.value)}
					maxLength={500}
					placeholder="Örn: Yemek masrafı ortaklığı"
					disabled={
						mutation.isPending || revisionConflict || isNetworkUncertain
					}
					data-testid="obligation-description-input"
				/>
				<span className="form-hint">{description.length}/500 karakter</span>
			</div>

			{/* Form Actions */}
			<div className="form-actions">
				{onCancel && (
					<button
						type="button"
						className="btn btn-secondary"
						onClick={onCancel}
						disabled={mutation.isPending}
						data-testid="obligation-cancel-btn"
					>
						<ArrowLeft size={16} aria-hidden="true" />
						<span>İptal</span>
					</button>
				)}

				<button
					type="submit"
					className="btn btn-primary"
					disabled={
						mutation.isPending || revisionConflict || isNetworkUncertain
					}
					data-testid="obligation-submit-btn"
				>
					<Save size={16} aria-hidden="true" />
					<span>
						{mutation.isPending
							? "Kaydediliyor..."
							: mode === "create"
								? direction === "RECEIVABLE"
									? "Borç Verme Kaydet"
									: "Borçlanma Kaydet"
								: "Kaydı Güncelle"}
					</span>
				</button>
			</div>
		</form>
	);
}
