import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { AlertCircle, RefreshCw, Send, Wallet } from "lucide-react";
import { useRef, useState } from "react";
import { ApiError, isNetworkUncertainError } from "../../api/errors";
import { createLongTermTask, fetchMidasLiquidity } from "../../api/f7-api";
import type {
	CreateLongTermTaskPayload,
	LongTermTaskProductDto,
} from "../../api/f7-types";
import { classifyMidasLiquidityState } from "../../lib/midas-state";
import {
	formatCentsToTry,
	formatMoneyToTry,
	normalizeTurkishMoneyInput,
	parseMoneyToCents,
} from "../../lib/money";
import { MoneyInput } from "../common/MoneyInput";

interface LongTermTaskFormProps {
	onSuccess?: ((task: LongTermTaskProductDto) => void) | undefined;
	onCancel?: (() => void) | undefined;
}

export function LongTermTaskForm({
	onSuccess,
	onCancel,
}: LongTermTaskFormProps) {
	const queryClient = useQueryClient();
	const navigate = useNavigate();

	const [amount, setAmount] = useState("");
	const [destinationLabel, setDestinationLabel] = useState("");
	const [note, setNote] = useState("");

	const [validationError, setValidationError] = useState<string | null>(null);
	const [errorMessage, setErrorMessage] = useState<string | null>(null);
	const [isNetworkUncertain, setIsNetworkUncertain] = useState(false);

	const frozenAttemptRef = useRef<{
		key: string;
		payload: CreateLongTermTaskPayload;
	} | null>(null);

	// Load Midas liquidity to check account and unallocated balance (R1)
	const {
		data: liquidityData,
		isLoading: liquidityLoading,
		error: liquidityError,
		refetch: refetchLiquidity,
	} = useQuery({
		queryKey: ["midas-liquidity"],
		queryFn: () => fetchMidasLiquidity(),
		staleTime: 30_000,
		retry: false,
	});

	const midasClassification = classifyMidasLiquidityState(
		liquidityLoading,
		liquidityData,
		liquidityError,
	);

	const liquidity =
		midasClassification.status === "CONFIGURED"
			? midasClassification.liquidity
			: null;
	const midasAccountId = liquidity?.midasAccountId;
	const unallocatedBalance = liquidity?.unallocatedBalance;

	const createMutation = useMutation({
		mutationFn: async (attempt: {
			key: string;
			payload: CreateLongTermTaskPayload;
		}) => {
			return createLongTermTask(attempt.payload, attempt.key);
		},
		onSuccess: (data) => {
			frozenAttemptRef.current = null;
			setIsNetworkUncertain(false);
			setErrorMessage(null);
			void queryClient.invalidateQueries({ queryKey: ["long-term-tasks"] });
			void queryClient.invalidateQueries({ queryKey: ["midas-liquidity"] });
			void queryClient.invalidateQueries({ queryKey: ["midas-transfers"] });
			if (onSuccess) {
				onSuccess(data.task);
			} else {
				void navigate({
					to: "/long-term/$taskId",
					params: { taskId: data.task.taskId },
				});
			}
		},
		onError: (err: unknown) => {
			if (isNetworkUncertainError(err)) {
				setIsNetworkUncertain(true);
				setErrorMessage(
					"Görev kaydının tamamlanıp tamamlanmadığı doğrulanamadı. Aynı işlemi güvenli şekilde tekrar deneyebilirsiniz.",
				);
				return;
			}
			setIsNetworkUncertain(false);
			frozenAttemptRef.current = null;
			if (err instanceof ApiError) {
				setErrorMessage(err.userMessage);
			} else {
				setErrorMessage(
					err instanceof Error ? err.message : "Görev oluşturulamadı.",
				);
			}
		},
	});

	const handleSubmit = (e: React.FormEvent) => {
		e.preventDefault();
		if (isNetworkUncertain || createMutation.isPending) return;

		setValidationError(null);
		setErrorMessage(null);

		if (!midasAccountId || unallocatedBalance === undefined) {
			setValidationError(
				"Serbest Midas bakiyesi doğrulanamadı. Yeni uzun vadeli görev oluşturulamaz.",
			);
			return;
		}

		const norm = normalizeTurkishMoneyInput(amount);
		if (!norm.valid || !norm.canonical || norm.cents === undefined) {
			setValidationError(norm.error ?? "Geçerli bir tutar girin.");
			return;
		}

		if (norm.cents <= 0n) {
			setValidationError("Tutar sıfırdan büyük olmalıdır.");
			return;
		}

		// Section 52: amount <= liquidity.unallocatedBalance using BigInt cents
		const unallocatedCents = parseMoneyToCents(unallocatedBalance);
		if (norm.cents > unallocatedCents) {
			setValidationError(
				`Tutar Midas serbest bakiyesini (${formatCentsToTry(unallocatedCents)}) aşamaz.`,
			);
			return;
		}

		const key = crypto.randomUUID();
		const occurredAt = new Date().toISOString();
		const payload: CreateLongTermTaskPayload = {
			midasAccountId,
			amount: norm.canonical,
			destinationLabel: destinationLabel.trim() || null,
			note: note.trim() || null,
			occurredAt,
		};

		const attempt = { key, payload };
		frozenAttemptRef.current = attempt;
		createMutation.mutate(attempt);
	};

	const handleRetry = () => {
		if (frozenAttemptRef.current) {
			createMutation.mutate(frozenAttemptRef.current);
		}
	};

	const handleCancel = () => {
		if (onCancel) {
			onCancel();
		} else {
			void navigate({ to: "/long-term" });
		}
	};

	// Section 8: State machine (LOADING, NOT_CONFIGURED, ERROR, CONFIGURED)
	if (midasClassification.status === "LOADING") {
		return (
			<div className="loading-state p-8">
				<RefreshCw size={24} className="spin" aria-hidden="true" />
				<span>Midas bilgileri yükleniyor...</span>
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
					Uzun vadeli yatırım görevi oluşturmak için önce Midas likidite
					hesabını bağlayın.
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
					Serbest Midas bakiyesi doğrulanamadı. Yeni uzun vadeli görev
					oluşturulamaz.
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

	return (
		<form
			onSubmit={handleSubmit}
			className="long-term-task-form card"
			data-testid="long-term-task-form"
		>
			<div className="card-header">
				<h2 className="card-title text-lg">Yeni Uzun Vadeli Yatırım Görevi</h2>
				<p className="card-subtitle text-xs">
					Midas serbest bakiyesinden dış yatırıma aktarılacak transfer kaydı
				</p>
			</div>

			<div className="card-body">
				{/* Section 51 Conceptual explanation */}
				<div className="alert alert-info mb-4" role="note">
					<span>
						Bu işlem tutarı Midas serbest bakiyesinden PENDING_LONG_TERM
						havuzuna sanal olarak ayırır. Paranın Midas'tan fiilen çıkışı henüz
						gerçekleşmez.
					</span>
				</div>

				<div className="transfer-summary-banner mb-4">
					<div className="summary-item">
						<span className="summary-label">
							Kullanılabilir Serbest Midas Bakiye:
						</span>
						<span
							className="summary-value font-mono font-bold"
							data-testid="form-unallocated-balance"
						>
							{/* unallocatedBalance is guaranteed string — CONFIGURED branch rendered above early returns */}
							{formatMoneyToTry(unallocatedBalance as string)}
						</span>
					</div>
				</div>

				{/* Network uncertainty alert */}
				{isNetworkUncertain && errorMessage && (
					<div
						className="alert alert-warning mb-4"
						role="alert"
						data-testid="task-uncertain-alert"
					>
						<AlertCircle size={18} aria-hidden="true" />
						<div className="alert-content">
							<span>{errorMessage}</span>
							<div className="alert-actions mt-2">
								<button
									type="button"
									className="btn btn-sm btn-primary"
									onClick={handleRetry}
									disabled={createMutation.isPending}
									data-testid="retry-uncertain-btn"
								>
									<RefreshCw
										size={14}
										className={createMutation.isPending ? "spin" : ""}
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
						data-testid="task-error-alert"
					>
						<AlertCircle size={18} aria-hidden="true" />
						<div className="alert-content">
							<span>{validationError || errorMessage}</span>
						</div>
					</div>
				)}

				<div className="form-group mb-4">
					<label htmlFor="long-term-amount-input" className="form-label">
						Transfer Tutarı (TL) <span className="text-danger">*</span>
					</label>
					<MoneyInput
						id="long-term-amount-input"
						value={amount}
						onChange={(canonical, raw) => {
							setAmount(canonical || raw);
							setValidationError(null);
						}}
						disabled={createMutation.isPending || isNetworkUncertain}
						placeholder="0,00"
						required
					/>
					<span className="form-hint">
						{/* unallocatedBalance is guaranteed string — CONFIGURED branch rendered above early returns */}
						Azami: {formatMoneyToTry(unallocatedBalance as string)}
					</span>
				</div>

				<div className="form-group mb-4">
					<label htmlFor="destination-label-input" className="form-label">
						Hedef Kurum / Platform (İsteğe bağlı)
					</label>
					<input
						id="destination-label-input"
						type="text"
						className="form-input"
						value={destinationLabel}
						onChange={(e) => setDestinationLabel(e.target.value)}
						disabled={createMutation.isPending || isNetworkUncertain}
						placeholder="Örn: Interactive Brokers, BIST Portföyü, TEFAS Fonu"
						maxLength={100}
						data-testid="destination-label-input"
					/>
				</div>

				<div className="form-group mb-4">
					<label htmlFor="long-term-note-input" className="form-label">
						Not (İsteğe bağlı)
					</label>
					<textarea
						id="long-term-note-input"
						className="form-textarea"
						value={note}
						onChange={(e) => setNote(e.target.value)}
						disabled={createMutation.isPending || isNetworkUncertain}
						placeholder="Transfer hakkında ek açıklama..."
						rows={3}
						maxLength={500}
						data-testid="long-term-note-input"
					/>
				</div>

				<div className="form-actions flex justify-end gap-3 mt-6">
					<button
						type="button"
						className="btn btn-secondary"
						onClick={handleCancel}
						disabled={createMutation.isPending}
					>
						Vazgeç
					</button>

					<button
						type="submit"
						className="btn btn-primary"
						disabled={createMutation.isPending || isNetworkUncertain}
						data-testid="task-submit-btn"
					>
						{createMutation.isPending ? (
							<>
								<RefreshCw size={16} className="spin" aria-hidden="true" />
								<span>Oluşturuluyor...</span>
							</>
						) : (
							<>
								<Send size={16} aria-hidden="true" />
								<span>Görevi Oluştur</span>
							</>
						)}
					</button>
				</div>
			</div>
		</form>
	);
}
