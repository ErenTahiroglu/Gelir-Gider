import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { AlertCircle, RefreshCw, Save, Wallet } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ApiError, isNetworkUncertainError } from "../../api/errors";
import {
	createShortTermGoal,
	fetchMidasLiquidity,
	fetchShortTermGoal,
	updateShortTermGoal,
} from "../../api/f7-api";
import type {
	CreateShortTermGoalPayload,
	ShortTermGoalProductDto,
	UpdateShortTermGoalPayload,
} from "../../api/f7-types";
import { classifyMidasLiquidityState } from "../../lib/midas-state";
import { normalizeTurkishMoneyInput } from "../../lib/money";
import { MoneyInput } from "../common/MoneyInput";

interface GoalFormProps {
	mode: "create" | "edit";
	goalId?: string | undefined;
	onSuccess?: ((goal: ShortTermGoalProductDto) => void) | undefined;
	onCancel?: (() => void) | undefined;
}

export function GoalForm({ mode, goalId, onSuccess, onCancel }: GoalFormProps) {
	const queryClient = useQueryClient();
	const navigate = useNavigate();

	// Fetch Midas liquidity for MidasAccountId in create mode
	const {
		data: liquidityData,
		isLoading: liquidityLoading,
		error: liquidityError,
		refetch: refetchLiquidity,
	} = useQuery({
		queryKey: ["midas-liquidity"],
		queryFn: () => fetchMidasLiquidity(),
		enabled: mode === "create",
		retry: false,
	});

	// Fetch existing goal for edit mode
	const {
		data: existingGoalData,
		isLoading: goalLoading,
		refetch: refetchGoal,
	} = useQuery({
		queryKey: ["short-term-goal", goalId],
		queryFn: () => fetchShortTermGoal(goalId as string),
		enabled: mode === "edit" && Boolean(goalId),
		staleTime: 0,
	});

	const existingGoal = existingGoalData?.goal;

	// Form states
	const [name, setName] = useState("");
	const [fundingTarget, setFundingTarget] = useState("");
	const [targetDate, setTargetDate] = useState("");
	const [maxBudget, setMaxBudget] = useState("");
	const [targetPrice, setTargetPrice] = useState("");
	const [productUrl, setProductUrl] = useState("");
	const [note, setNote] = useState("");
	const [changeReason, setChangeReason] = useState("");

	const [validationError, setValidationError] = useState<string | null>(null);
	const [errorMessage, setErrorMessage] = useState<string | null>(null);
	const [isNetworkUncertain, setIsNetworkUncertain] = useState(false);
	const [hasRevisionConflict, setHasRevisionConflict] = useState(false);

	// Frozen attempt ref for stable idempotent retry (Section 60, 61)
	const frozenAttemptRef = useRef<{
		key: string;
		payload: CreateShortTermGoalPayload | UpdateShortTermGoalPayload;
	} | null>(null);

	// Section 35: Initialize form in edit mode
	// CRITICAL RULE: editable funding target uses initialGoal.fundingTarget, NEVER remainingToTarget!
	useEffect(() => {
		if (mode === "edit" && existingGoal) {
			setName(existingGoal.name);
			setFundingTarget(existingGoal.fundingTarget); // Exact principal target!
			setTargetDate(existingGoal.targetDate ?? "");
			setMaxBudget(existingGoal.maxBudget ?? "");
			setTargetPrice(existingGoal.targetPrice ?? "");
			setProductUrl(existingGoal.productUrl ?? "");
			setNote(existingGoal.note ?? "");
		}
	}, [mode, existingGoal]);

	const midasClassification = classifyMidasLiquidityState(
		liquidityLoading,
		liquidityData,
		liquidityError,
	);

	const midasAccountId =
		midasClassification.status === "CONFIGURED"
			? midasClassification.liquidity.midasAccountId
			: undefined;

	const createMutation = useMutation({
		mutationFn: async (attempt: {
			key: string;
			payload: CreateShortTermGoalPayload;
		}) => {
			return createShortTermGoal(attempt.payload, attempt.key);
		},
		onSuccess: (data) => {
			frozenAttemptRef.current = null;
			setIsNetworkUncertain(false);
			setErrorMessage(null);
			void queryClient.invalidateQueries({ queryKey: ["short-term-goals"] });
			void queryClient.invalidateQueries({ queryKey: ["midas-liquidity"] });
			if (onSuccess) {
				onSuccess(data.goal);
			} else {
				void navigate({
					to: "/goals/$goalId",
					params: { goalId: data.goal.goalId },
				});
			}
		},
		onError: (err: unknown) => {
			if (isNetworkUncertainError(err)) {
				setIsNetworkUncertain(true);
				setErrorMessage(
					"Hedef kaydının tamamlanıp tamamlanmadığı doğrulanamadı. Aynı işlemi güvenli şekilde tekrar deneyebilirsiniz.",
				);
				return;
			}
			setIsNetworkUncertain(false);
			frozenAttemptRef.current = null;
			if (err instanceof ApiError) {
				setErrorMessage(err.userMessage);
			} else {
				setErrorMessage(
					err instanceof Error ? err.message : "Hedef oluşturulamadı.",
				);
			}
		},
	});

	const updateMutation = useMutation({
		mutationFn: async (attempt: {
			key: string;
			payload: UpdateShortTermGoalPayload;
		}) => {
			return updateShortTermGoal(
				goalId as string,
				attempt.payload,
				attempt.key,
			);
		},
		onSuccess: (data) => {
			frozenAttemptRef.current = null;
			setIsNetworkUncertain(false);
			setErrorMessage(null);
			setHasRevisionConflict(false);
			void queryClient.invalidateQueries({ queryKey: ["short-term-goals"] });
			void queryClient.invalidateQueries({
				queryKey: ["short-term-goal", goalId],
			});
			void queryClient.invalidateQueries({ queryKey: ["midas-liquidity"] });
			if (onSuccess) {
				onSuccess(data.goal);
			} else {
				void navigate({
					to: "/goals/$goalId",
					params: { goalId: data.goal.goalId },
				});
			}
		},
		onError: async (err: unknown) => {
			if (isNetworkUncertainError(err)) {
				setIsNetworkUncertain(true);
				setErrorMessage(
					"Güncelleme kaydının tamamlanıp tamamlanmadığı doğrulanamadı. Aynı işlemi güvenli şekilde tekrar deneyebilirsiniz.",
				);
				return;
			}
			setIsNetworkUncertain(false);
			frozenAttemptRef.current = null;
			if (
				err instanceof ApiError &&
				err.code === "SHORT_TERM_GOAL_REVISION_CONFLICT"
			) {
				// Section 34: Refetch latest on revision conflict
				setHasRevisionConflict(true);
				setErrorMessage(err.userMessage);
				await refetchGoal();
				return;
			}
			if (err instanceof ApiError) {
				setErrorMessage(err.userMessage);
			} else {
				setErrorMessage(
					err instanceof Error ? err.message : "Hedef güncellenemedi.",
				);
			}
		},
	});

	const isPending = createMutation.isPending || updateMutation.isPending;

	const handleSubmit = (e: React.FormEvent) => {
		e.preventDefault();
		if (isNetworkUncertain || isPending) return;

		setValidationError(null);
		setErrorMessage(null);

		const trimmedName = name.trim();
		if (!trimmedName) {
			setValidationError("Hedef adı zorunludur.");
			return;
		}

		const normTarget = normalizeTurkishMoneyInput(fundingTarget);
		if (
			!normTarget.valid ||
			!normTarget.canonical ||
			normTarget.cents === undefined
		) {
			setValidationError(
				normTarget.error ?? "Hedef tutar geçerli bir sayı olmalıdır.",
			);
			return;
		}
		if (normTarget.cents <= 0n) {
			setValidationError("Hedef tutar sıfırdan büyük olmalıdır.");
			return;
		}

		let canonicalMaxBudget: string | null = null;
		if (maxBudget.trim() !== "") {
			const normMax = normalizeTurkishMoneyInput(maxBudget);
			if (!normMax.valid || !normMax.canonical || normMax.cents === undefined) {
				setValidationError(
					normMax.error ?? "Azami bütçe geçerli bir sayı olmalıdır.",
				);
				return;
			}
			if (normMax.cents <= 0n) {
				setValidationError("Azami bütçe sıfırdan büyük olmalıdır.");
				return;
			}
			if (normMax.cents < normTarget.cents) {
				setValidationError("Azami bütçe hedef tutardan küçük olamaz.");
				return;
			}
			canonicalMaxBudget = normMax.canonical;
		}

		let canonicalTargetPrice: string | null = null;
		if (targetPrice.trim() !== "") {
			const normPrice = normalizeTurkishMoneyInput(targetPrice);
			if (
				!normPrice.valid ||
				!normPrice.canonical ||
				normPrice.cents === undefined
			) {
				setValidationError(
					normPrice.error ?? "Hedef fiyat geçerli bir sayı olmalıdır.",
				);
				return;
			}
			if (normPrice.cents <= 0n) {
				setValidationError("Hedef fiyat sıfırdan büyük olmalıdır.");
				return;
			}
			canonicalTargetPrice = normPrice.canonical;
		}

		const key = crypto.randomUUID();
		const occurredAt = new Date().toISOString();

		if (mode === "create") {
			if (!midasAccountId) {
				setValidationError(
					"Kısa vadeli hedef oluşturmak için önce Midas likidite hesabını bağlayın.",
				);
				return;
			}

			const payload: CreateShortTermGoalPayload = {
				midasAccountId,
				name: trimmedName,
				fundingTarget: normTarget.canonical,
				targetDate: targetDate.trim() || null,
				maxBudget: canonicalMaxBudget,
				targetPrice: canonicalTargetPrice,
				productUrl: productUrl.trim() || null,
				note: note.trim() || null,
				occurredAt,
			};

			const attempt = { key, payload };
			frozenAttemptRef.current = attempt;
			createMutation.mutate(attempt);
		} else {
			if (!existingGoal) {
				setErrorMessage("Hedef kaydı henüz yüklenmedi.");
				return;
			}

			const payload: UpdateShortTermGoalPayload = {
				expectedRevisionNo: existingGoal.latestRevisionNo,
				name: trimmedName,
				fundingTarget: normTarget.canonical,
				targetDate: targetDate.trim() || null,
				maxBudget: canonicalMaxBudget,
				targetPrice: canonicalTargetPrice,
				productUrl: productUrl.trim() || null,
				note: note.trim() || null,
				changeReason: changeReason.trim() || null,
				occurredAt,
			};

			const attempt = { key, payload };
			frozenAttemptRef.current = attempt;
			updateMutation.mutate(attempt);
		}
	};

	const handleRetry = () => {
		if (mode === "create" && frozenAttemptRef.current) {
			createMutation.mutate(
				frozenAttemptRef.current as {
					key: string;
					payload: CreateShortTermGoalPayload;
				},
			);
		} else if (mode === "edit" && frozenAttemptRef.current) {
			updateMutation.mutate(
				frozenAttemptRef.current as {
					key: string;
					payload: UpdateShortTermGoalPayload;
				},
			);
		}
	};

	const handleCancel = () => {
		if (onCancel) {
			onCancel();
		} else if (mode === "edit" && goalId) {
			void navigate({ to: "/goals/$goalId", params: { goalId } });
		} else {
			void navigate({ to: "/goals" });
		}
	};

	// Guard: Midas states in create mode (Section 31 & R1)
	if (mode === "create") {
		if (midasClassification.status === "LOADING") {
			return (
				<div className="loading-state p-8">
					<RefreshCw size={24} className="spin" aria-hidden="true" />
					<span>Bilgiler yükleniyor...</span>
				</div>
			);
		}

		if (midasClassification.status === "NOT_CONFIGURED") {
			return (
				<div
					className="card text-center p-6"
					data-testid="midas-not-configured-guard"
				>
					<div className="header-icon-badge mx-auto mb-4 bg-warning-subtle text-warning">
						<Wallet size={32} aria-hidden="true" />
					</div>
					<h2 className="text-lg font-bold mb-2">Midas Hesabı Bulunamadı</h2>
					<p className="text-muted mb-4 max-w-md mx-auto">
						Kısa vadeli hedef oluşturmak için önce Midas likidite hesabını
						bağlayın.
					</p>
					<Link
						to="/midas"
						className="btn btn-primary"
						data-testid="link-to-setup-midas"
					>
						<span>Midas'ı Kur</span>
					</Link>
				</div>
			);
		}

		if (midasClassification.status === "ERROR") {
			return (
				<div
					className="card text-center p-6"
					data-testid="midas-authority-error-guard"
				>
					<div className="header-icon-badge mx-auto mb-4 bg-danger-subtle text-danger">
						<AlertCircle size={32} aria-hidden="true" />
					</div>
					<h2 className="text-lg font-bold mb-2">Midas Durumu Doğrulanamadı</h2>
					<p className="text-muted mb-4 max-w-md mx-auto">
						Yeni hedef oluşturulmadan önce Midas likidite durumu
						doğrulanmalıdır.
					</p>
					<button
						type="button"
						className="btn btn-secondary inline-flex items-center gap-2"
						onClick={() => void refetchLiquidity()}
						data-testid="retry-liquidity-btn"
					>
						<RefreshCw size={16} aria-hidden="true" />
						<span>Yeniden Dene</span>
					</button>
				</div>
			);
		}
	}

	if (goalLoading) {
		return (
			<div className="loading-state p-8">
				<RefreshCw size={24} className="spin" aria-hidden="true" />
				<span>Bilgiler yükleniyor...</span>
			</div>
		);
	}

	return (
		<form onSubmit={handleSubmit} className="goal-form" data-testid="goal-form">
			{/* Conflict warning */}
			{hasRevisionConflict && (
				<div
					className="alert alert-warning mb-4"
					role="alert"
					data-testid="goal-conflict-alert"
				>
					<AlertCircle size={18} aria-hidden="true" />
					<div className="alert-content">
						<span>
							Hedef bilgileri başka bir işlem tarafından güncellendi. En güncel
							bilgiler getirildi, lütfen değişikliklerinizi kontrol edip tekrar
							kaydedin.
						</span>
					</div>
				</div>
			)}

			{/* Network uncertainty alert */}
			{isNetworkUncertain && errorMessage && (
				<div
					className="alert alert-warning mb-4"
					role="alert"
					data-testid="goal-uncertain-alert"
				>
					<AlertCircle size={18} aria-hidden="true" />
					<div className="alert-content">
						<span>{errorMessage}</span>
						<div className="alert-actions mt-2">
							<button
								type="button"
								className="btn btn-sm btn-primary"
								onClick={handleRetry}
								disabled={isPending}
								data-testid="retry-uncertain-btn"
							>
								<RefreshCw
									size={14}
									className={isPending ? "spin" : ""}
									aria-hidden="true"
								/>
								<span>Aynı İşlemi Tekrar Dene</span>
							</button>
						</div>
					</div>
				</div>
			)}

			{/* General error / validation */}
			{(validationError || (!isNetworkUncertain && errorMessage)) && (
				<div
					className="alert alert-danger mb-4"
					role="alert"
					data-testid="goal-error-alert"
				>
					<AlertCircle size={18} aria-hidden="true" />
					<div className="alert-content">
						<span>{validationError || errorMessage}</span>
					</div>
				</div>
			)}

			<div className="form-group">
				<label htmlFor="goal-name-input" className="form-label">
					Hedef Adı <span className="text-danger">*</span>
				</label>
				<input
					id="goal-name-input"
					type="text"
					className="form-input"
					value={name}
					onChange={(e) => {
						setName(e.target.value);
						setValidationError(null);
					}}
					disabled={isPending || isNetworkUncertain}
					placeholder="Örn: Yeni Bilgisayar, Tatil Fonu"
					maxLength={100}
					data-testid="goal-name-input"
					required
				/>
			</div>

			<div className="form-group">
				<label htmlFor="goal-funding-target-input" className="form-label">
					Hedef Tutar (TL) <span className="text-danger">*</span>
				</label>
				<MoneyInput
					id="goal-funding-target-input"
					value={fundingTarget}
					onChange={(canonical, raw) => {
						setFundingTarget(canonical || raw);
						setValidationError(null);
					}}
					disabled={isPending || isNetworkUncertain}
					placeholder="0,00"
					required
				/>
				<span className="form-hint">Ulaşmak istediğiniz birikim tutarı</span>
			</div>

			<div className="form-row">
				<div className="form-group">
					<label htmlFor="goal-target-date-input" className="form-label">
						Hedef Tarihi (İsteğe bağlı)
					</label>
					<input
						id="goal-target-date-input"
						type="date"
						className="form-input"
						value={targetDate}
						onChange={(e) => setTargetDate(e.target.value)}
						disabled={isPending || isNetworkUncertain}
						data-testid="goal-target-date-input"
					/>
				</div>

				<div className="form-group">
					<label htmlFor="goal-max-budget-input" className="form-label">
						Azami Bütçe (TL) (İsteğe bağlı)
					</label>
					<MoneyInput
						id="goal-max-budget-input"
						value={maxBudget}
						onChange={(canonical, raw) => {
							setMaxBudget(canonical || raw);
							setValidationError(null);
						}}
						disabled={isPending || isNetworkUncertain}
						placeholder="0,00"
					/>
					<span className="form-hint">
						Hedefin üzerine çıkılabilecek tavan sınır
					</span>
				</div>
			</div>

			<div className="form-row">
				<div className="form-group">
					<label htmlFor="goal-target-price-input" className="form-label">
						Ürün Satış Fiyatı (İsteğe bağlı)
					</label>
					<MoneyInput
						id="goal-target-price-input"
						value={targetPrice}
						onChange={(canonical, raw) => {
							setTargetPrice(canonical || raw);
							setValidationError(null);
						}}
						disabled={isPending || isNetworkUncertain}
						placeholder="0,00"
					/>
				</div>

				<div className="form-group">
					<label htmlFor="goal-product-url-input" className="form-label">
						Ürün Bağlantısı (URL) (İsteğe bağlı)
					</label>
					<input
						id="goal-product-url-input"
						type="url"
						className="form-input"
						value={productUrl}
						onChange={(e) => setProductUrl(e.target.value)}
						disabled={isPending || isNetworkUncertain}
						placeholder="https://..."
						data-testid="goal-product-url-input"
					/>
				</div>
			</div>

			<div className="form-group">
				<label htmlFor="goal-note-input" className="form-label">
					Not (İsteğe bağlı)
				</label>
				<textarea
					id="goal-note-input"
					className="form-textarea"
					value={note}
					onChange={(e) => setNote(e.target.value)}
					disabled={isPending || isNetworkUncertain}
					placeholder="Hedef hakkında ek notlar..."
					rows={3}
					data-testid="goal-note-input"
				/>
			</div>

			{mode === "edit" && (
				<div className="form-group">
					<label htmlFor="goal-change-reason-input" className="form-label">
						Değişiklik Nedeni (İsteğe bağlı)
					</label>
					<input
						id="goal-change-reason-input"
						type="text"
						className="form-input"
						value={changeReason}
						onChange={(e) => setChangeReason(e.target.value)}
						disabled={isPending || isNetworkUncertain}
						placeholder="Örn: Bütçe artırıldı"
						maxLength={200}
						data-testid="goal-change-reason-input"
					/>
				</div>
			)}

			<div className="form-actions mt-6 flex gap-3">
				<button
					type="button"
					className="btn btn-secondary"
					onClick={handleCancel}
					disabled={isPending}
					data-testid="goal-cancel-btn"
				>
					Vazgeç
				</button>

				<button
					type="submit"
					className="btn btn-primary"
					disabled={isPending || isNetworkUncertain}
					data-testid="goal-submit-btn"
				>
					{isPending ? (
						<>
							<RefreshCw size={16} className="spin" aria-hidden="true" />
							<span>Kaydediliyor...</span>
						</>
					) : (
						<>
							<Save size={16} aria-hidden="true" />
							<span>
								{mode === "create" ? "Hedefi Oluştur" : "Değişiklikleri Kaydet"}
							</span>
						</>
					)}
				</button>
			</div>
		</form>
	);
}
