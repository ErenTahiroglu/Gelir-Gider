import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import {
	AlertCircle,
	ArrowLeft,
	CheckCircle,
	Coins,
	Info,
	Landmark,
	RefreshCw,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { ApiError } from "../../../api/errors";
import { fetchAllLedgerAccounts } from "../../../api/manual-expenses-api";
import {
	fetchMidasLiquidity,
	fetchPerson,
	fetchPersonBalanceSummary,
	settlePersonReceivables,
} from "../../../api/people-api";
import type {
	SettlePersonReceivablesPayload,
	SettlePersonReceivablesResult,
} from "../../../api/people-types";
import {
	formatCentsToTry,
	formatMoneyToTry,
	normalizeTurkishMoneyInput,
	parseMoneyToCents,
} from "../../../lib/money";
import { MoneyInput } from "../../common/MoneyInput";

interface PersonSettleReceivablesPageProps {
	personId: string;
}

export function PersonSettleReceivablesPage({
	personId,
}: PersonSettleReceivablesPageProps) {
	const navigate = useNavigate();
	const queryClient = useQueryClient();

	// 1. Fetch Person & Balance Summary
	const { isLoading: isPersonLoading } = useQuery({
		queryKey: ["person", personId],
		queryFn: () => fetchPerson(personId),
	});

	const {
		data: balanceSummary,
		isLoading: isSummaryLoading,
		error: summaryError,
	} = useQuery({
		queryKey: ["person-balance-summary", personId],
		queryFn: () => fetchPersonBalanceSummary(personId),
	});

	// 2. Fetch Accounts & Midas Liquidity
	const { data: accounts, isLoading: isAccountsLoading } = useQuery({
		queryKey: ["ledger-accounts"],
		queryFn: () => fetchAllLedgerAccounts(100),
		staleTime: 60_000,
	});

	const { data: midasData } = useQuery({
		queryKey: ["midas-liquidity"],
		queryFn: fetchMidasLiquidity,
		staleTime: 60_000,
	});

	const midasLiquidity = midasData?.liquidity;
	const isMidasAvailable = Boolean(midasLiquidity?.ledgerAccountId);

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

	// Form State
	const [amount, setAmount] = useState("");
	const [isCash, setIsCash] = useState(true);
	const [destinationAssetAccountId, setDestinationAssetAccountId] =
		useState("");
	const [initialPrefillDone, setInitialPrefillDone] = useState(false);

	// Feedback & Result State
	const [validationError, setValidationError] = useState<string | null>(null);
	const [apiError, setApiError] = useState<string | null>(null);
	const [settlementResult, setSettlementResult] =
		useState<SettlePersonReceivablesResult | null>(null);

	// Retry & Idempotency state
	const [isNetworkUncertain, setIsNetworkUncertain] = useState(false);
	const idempotencyKeyRef = useRef<string>(crypto.randomUUID());
	const lastSubmittedPayloadRef = useRef<SettlePersonReceivablesPayload | null>(
		null,
	);

	// Prefill logic per Section 46
	useEffect(() => {
		if (balanceSummary && !initialPrefillDone) {
			const isFriend = balanceSummary.relationship === "FRIEND";
			const prefillValue =
				isFriend && balanceSummary.collectionTarget
					? balanceSummary.collectionTarget
					: balanceSummary.exactReceivableBalance;

			setAmount(prefillValue);
			setInitialPrefillDone(true);
		}
	}, [balanceSummary, initialPrefillDone]);

	// Set default destination account for cash
	useEffect(() => {
		const first = selectableAccounts[0];
		if (!destinationAssetAccountId && first) {
			setDestinationAssetAccountId(first.accountId);
		}
	}, [destinationAssetAccountId, selectableAccounts]);

	// Calculate estimated excess with BigInt
	const estimatedExcess = useMemo(() => {
		if (!balanceSummary) return 0n;
		const norm = normalizeTurkishMoneyInput(amount);
		if (!norm.valid || norm.cents === undefined) return 0n;

		const receivableCents = parseMoneyToCents(
			balanceSummary.exactReceivableBalance,
		);
		const diff = norm.cents - receivableCents;
		return diff > 0n ? diff : 0n;
	}, [amount, balanceSummary]);

	const receivableCents = balanceSummary
		? parseMoneyToCents(balanceSummary.exactReceivableBalance)
		: 0n;
	const hasZeroReceivable = receivableCents <= 0n;

	// Settle mutation
	const mutation = useMutation({
		mutationFn: async (payload: SettlePersonReceivablesPayload) => {
			return settlePersonReceivables(
				personId,
				payload,
				idempotencyKeyRef.current,
			);
		},
		retry: false,
		onSuccess: (result) => {
			// Query invalidation per Section 57
			void queryClient.invalidateQueries({ queryKey: ["people"] });
			void queryClient.invalidateQueries({ queryKey: ["active-people"] });
			void queryClient.invalidateQueries({ queryKey: ["person", personId] });
			void queryClient.invalidateQueries({
				queryKey: ["person-balance-summary", personId],
			});
			void queryClient.invalidateQueries({
				queryKey: ["person-obligations", personId],
			});
			void queryClient.invalidateQueries({ queryKey: ["person-settlements"] });
			void queryClient.invalidateQueries({ queryKey: ["transactions"] });
			void queryClient.invalidateQueries({ queryKey: ["ledger-accounts"] });
			void queryClient.invalidateQueries({ queryKey: ["midas-liquidity"] });
			void queryClient.invalidateQueries({
				queryKey: ["active-credit-cards"],
			});
			void queryClient.invalidateQueries({ queryKey: ["card-statements"] });
			void queryClient.invalidateQueries({ queryKey: ["short-term-goals"] });
			void queryClient.invalidateQueries({ queryKey: ["long-term-tasks"] });

			setIsNetworkUncertain(false);
			lastSubmittedPayloadRef.current = null;
			setSettlementResult(result);
		},
		onError: (err) => {
			if (err instanceof ApiError) {
				if (err.status === 0 || err.code === "NETWORK_ERROR") {
					setIsNetworkUncertain(true);
					setApiError(
						"Ödemenin kaydedilip kaydedilmediği doğrulanamadı. Lütfen aynı bilgilerle tekrar deneyin.",
					);
				} else {
					setApiError(err.userMessage);
				}
			} else if (err instanceof Error) {
				setApiError(err.message);
			} else {
				setApiError("Ödeme kaydedilirken bir hata oluştu.");
			}
		},
	});

	const handleSubmit = (e: React.FormEvent) => {
		e.preventDefault();
		setValidationError(null);
		setApiError(null);

		const norm = normalizeTurkishMoneyInput(amount);
		if (!norm.valid || !norm.canonical || norm.cents === undefined) {
			setValidationError(
				norm.error ?? "Lütfen geçerli bir ödeme tutarı girin.",
			);
			return;
		}

		if (norm.cents <= 0n) {
			setValidationError("Ödeme tutarı sıfırdan büyük olmalıdır.");
			return;
		}

		if (hasZeroReceivable) {
			setValidationError("Bu kişinin tahsil edilecek açık alacağı bulunmuyor.");
			return;
		}

		let targetAccountId = "";
		if (isCash) {
			if (!destinationAssetAccountId) {
				setValidationError("Lütfen paranın yatırılacağı hesabı seçin.");
				return;
			}
			targetAccountId = destinationAssetAccountId;
		} else {
			if (!midasLiquidity?.ledgerAccountId) {
				setValidationError(
					"Midas hesabına gelen ödeme için önce likidite hesabı yapılandırılmalı.",
				);
				return;
			}
			targetAccountId = midasLiquidity.ledgerAccountId;
		}

		const payload: SettlePersonReceivablesPayload = {
			cashAmount: norm.canonical,
			destinationAssetAccountId: targetAccountId,
			isCash,
			occurredAt: new Date().toISOString(),
		};

		lastSubmittedPayloadRef.current = payload;
		mutation.mutate(payload);
	};

	const handleRetryUncertain = () => {
		if (lastSubmittedPayloadRef.current) {
			setApiError(null);
			mutation.mutate(lastSubmittedPayloadRef.current);
		}
	};

	if (isPersonLoading || isSummaryLoading) {
		return (
			<div className="settle-receivables-page">
				<div className="card loading-card">
					<p>Kişi ve bakiye bilgileri yükleniyor...</p>
				</div>
			</div>
		);
	}

	if (summaryError || !balanceSummary) {
		return (
			<div className="settle-receivables-page">
				<div className="alert alert-danger">
					<AlertCircle size={18} aria-hidden="true" />
					<span>Kişi bakiye bilgisi alınamadı.</span>
				</div>
				<Link to="/people" className="btn btn-secondary mt-3">
					<ArrowLeft size={16} aria-hidden="true" />
					<span>Kişilere Dön</span>
				</Link>
			</div>
		);
	}

	// Success View (Authoritative Server Result) per Section 36 & 44
	if (settlementResult) {
		const excessCents = parseMoneyToCents(settlementResult.excess);
		const hasExcess = excessCents > 0n;

		return (
			<div
				className="settle-receivables-page"
				data-testid="settle-receivables-success-view"
			>
				<div className="page-nav-header">
					<Link
						to="/people/$personId"
						params={{ personId }}
						className="back-link"
					>
						<ArrowLeft size={18} aria-hidden="true" />
						<span>Kişi Detayına Dön</span>
					</Link>
				</div>

				<div className="settlement-result-card card">
					<div className="result-header">
						<div className="success-icon-badge">
							<CheckCircle size={32} aria-hidden="true" />
						</div>
						<h1 className="result-title">Ödeme Başarıyla Alındı</h1>
						<p className="result-subtitle">
							{balanceSummary.displayName} kişisinden tahsilat kaydedildi.
						</p>
					</div>

					<div className="result-breakdown-grid">
						<div className="result-item">
							<span className="result-label">Tahsil Edilen Toplam Tutar</span>
							<span className="result-value" data-testid="result-cash-received">
								{formatMoneyToTry(settlementResult.cashReceived)}
							</span>
						</div>

						<div className="result-item">
							<span className="result-label">Alacağa Uygulanan</span>
							<span
								className="result-value"
								data-testid="result-receivable-applied"
							>
								{formatMoneyToTry(settlementResult.receivableApplied)}
							</span>
						</div>

						<div className="result-item">
							<span className="result-label">Kalan Alacak Tutarı</span>
							<span
								className="result-value"
								data-testid="result-remaining-receivable"
							>
								{formatMoneyToTry(settlementResult.remainingReceivable)}
							</span>
						</div>

						<div className="result-item">
							<span className="result-label">Fazla Ödeme Tutarı</span>
							<span className="result-value" data-testid="result-excess">
								{formatMoneyToTry(settlementResult.excess)}
							</span>
						</div>
					</div>

					{/* Routing / Waterfall section */}
					{hasExcess && (
						<div
							className="waterfall-routing-section"
							data-testid="waterfall-routing-section"
						>
							<h3 className="waterfall-title">Fazla Ödeme Dağılımı</h3>

							{settlementResult.routing.length > 0 ? (
								<ul className="waterfall-routing-list">
									{settlementResult.routing.map((item) => (
										<li
											key={item.destination}
											className="waterfall-routing-item"
											data-testid={`routing-item-${item.destination}`}
										>
											<span className="routing-destination">
												{item.destination === "CREDIT_CARD_RESERVE"
													? "Kart Rezervi"
													: item.destination === "SHORT_TERM_GOAL"
														? "Kısa Vadeli Hedef"
														: item.destination === "LONG_TERM"
															? "Uzun Vadeli"
															: item.destination}
											</span>
											<span className="routing-amount">
												{formatMoneyToTry(item.amount)}
											</span>
										</li>
									))}
								</ul>
							) : (
								<div
									className="cash-retained-notice alert alert-info"
									data-testid="cash-retained-notice"
								>
									<Info size={16} aria-hidden="true" />
									<span>
										Fazla alınan tutar seçtiğiniz hesapta kaldı. Otomatik Kart
										Rezervi / hedef yönlendirmesi uygulanmadı.
									</span>
								</div>
							)}
						</div>
					)}

					<div className="result-actions">
						<button
							type="button"
							className="btn btn-primary"
							onClick={() =>
								void navigate({
									to: "/people/$personId",
									params: { personId },
								})
							}
							data-testid="settle-finish-btn"
						>
							Tamamla ve Kişi Detayına Dön
						</button>
					</div>
				</div>
			</div>
		);
	}

	return (
		<div
			className="settle-receivables-page"
			data-testid="settle-receivables-page"
		>
			<div className="page-nav-header">
				<Link
					to="/people/$personId"
					params={{ personId }}
					className="back-link"
				>
					<ArrowLeft size={18} aria-hidden="true" />
					<span>Kişi Detayına Dön</span>
				</Link>
			</div>

			<div className="settle-card card">
				<div className="settle-header">
					<Coins size={24} aria-hidden="true" className="header-icon" />
					<div>
						<h1 className="page-title">Kişiden Ödeme Al</h1>
						<p className="page-subtitle">
							<strong>{balanceSummary.displayName}</strong> adına tahsilat kaydı
							oluşturun.
						</p>
					</div>
				</div>

				{hasZeroReceivable && (
					<div
						className="alert alert-warning"
						role="alert"
						data-testid="no-open-receivables-warning"
					>
						<AlertCircle size={18} aria-hidden="true" />
						<span>Bu kişinin tahsil edilecek açık alacağı bulunmuyor.</span>
					</div>
				)}

				{validationError && (
					<div
						className="alert alert-danger"
						role="alert"
						data-testid="settle-validation-error"
					>
						<AlertCircle size={18} aria-hidden="true" />
						<span>{validationError}</span>
					</div>
				)}

				{apiError && (
					<div
						className="alert alert-danger"
						role="alert"
						data-testid="settle-api-error"
					>
						<AlertCircle size={18} aria-hidden="true" />
						<span>{apiError}</span>
					</div>
				)}

				{isNetworkUncertain && (
					<div
						className="alert alert-warning network-uncertain-box"
						data-testid="network-uncertain-box"
					>
						<p>
							Ödemenin kaydedilip kaydedilmediği doğrulanamadı. İnternet
							bağlantınızı kontrol edip aynı bilgilerle tekrar deneyin.
						</p>
						<button
							type="button"
							className="btn btn-warning btn-sm"
							onClick={handleRetryUncertain}
							disabled={mutation.isPending}
							data-testid="retry-settle-btn"
						>
							<RefreshCw size={14} aria-hidden="true" />
							<span>Tekrar Dene</span>
						</button>
					</div>
				)}

				{/* Balance Info Banner */}
				<div className="balance-info-strip">
					<div className="strip-item">
						<span className="strip-label">Gerçek Alacak:</span>
						<span
							className="strip-value"
							data-testid="exact-receivable-balance"
						>
							{formatMoneyToTry(balanceSummary.exactReceivableBalance)}
						</span>
					</div>

					{balanceSummary.relationship === "FRIEND" &&
						balanceSummary.collectionTarget && (
							<div className="strip-item highlight-target">
								<span className="strip-label">Önerilen Tahsilat:</span>
								<span
									className="strip-value"
									data-testid="friend-collection-target"
								>
									{formatMoneyToTry(balanceSummary.collectionTarget)}
								</span>
							</div>
						)}

					{estimatedExcess > 0n && (
						<div className="strip-item excess-item">
							<span className="strip-label">Tahmini Fazla Ödeme:</span>
							<span className="strip-value" data-testid="estimated-excess">
								{formatCentsToTry(estimatedExcess)}
							</span>
						</div>
					)}
				</div>

				<form onSubmit={handleSubmit} noValidate>
					{/* Tutar */}
					<div className="form-group">
						<label htmlFor="settle-amount" className="form-label">
							Alınan Tutar <span className="required-star">*</span>
						</label>
						<MoneyInput
							id="settle-amount"
							value={amount}
							onChange={(val) => setAmount(val)}
							disabled={mutation.isPending || hasZeroReceivable}
							data-testid="settle-amount-input"
							required
						/>
					</div>

					{/* Nasıl Aldın? Radio options */}
					<div className="form-group">
						<span className="form-label">Ödeme Yöntemi</span>
						<div
							className="settle-method-grid"
							role="radiogroup"
							aria-label="Ödeme Yöntemi"
						>
							{/* Option 1: Nakit olarak */}
							<label
								className={`method-option-card ${isCash ? "selected" : ""}`}
							>
								<input
									type="radio"
									name="settleMethod"
									checked={isCash}
									onChange={() => setIsCash(true)}
									disabled={mutation.isPending || hasZeroReceivable}
									data-testid="method-cash-radio"
								/>
								<div className="option-title-row">
									<Coins size={18} aria-hidden="true" />
									<span className="option-name">Nakit olarak</span>
								</div>
								<span className="option-desc">
									Seçeceğiniz varlık hesabına yansır.
								</span>
							</label>

							{/* Option 2: Midas hesabıma geldi */}
							<label
								className={`method-option-card ${!isCash ? "selected" : ""} ${!isMidasAvailable ? "disabled" : ""}`}
							>
								<input
									type="radio"
									name="settleMethod"
									checked={!isCash}
									onChange={() => setIsCash(false)}
									disabled={
										mutation.isPending || !isMidasAvailable || hasZeroReceivable
									}
									data-testid="method-midas-radio"
								/>
								<div className="option-title-row">
									<Landmark size={18} aria-hidden="true" />
									<span className="option-name">Midas hesabıma geldi</span>
								</div>
								<span className="option-desc">
									{isMidasAvailable
										? "Likidite hesabına aktarılır, fazla ödeme otomatik yönlendirilir."
										: "Midas likidite hesabı yapılandırılmamış."}
								</span>
							</label>
						</div>

						{!isMidasAvailable && (
							<div
								className="midas-unavailable-hint text-secondary"
								data-testid="midas-unavailable-hint"
							>
								Midas hesabına gelen ödeme için önce likidite hesabı
								yapılandırılmalı. Bu ayar F7 Likidite ekranında yönetilecek.
							</div>
						)}
					</div>

					{/* Destination Account Selection for Cash */}
					{isCash && (
						<div className="form-group">
							<label htmlFor="destination-account" className="form-label">
								Paranın Eklendiği Hesap <span className="required-star">*</span>
							</label>
							{isAccountsLoading ? (
								<p className="text-secondary">Hesaplar yükleniyor...</p>
							) : (
								<select
									id="destination-account"
									className="form-control"
									value={destinationAssetAccountId}
									onChange={(e) => setDestinationAssetAccountId(e.target.value)}
									disabled={mutation.isPending || hasZeroReceivable}
									data-testid="settle-destination-account-select"
									required
								>
									{selectableAccounts.map((acc) => (
										<option key={acc.accountId} value={acc.accountId}>
											{acc.name} ({formatMoneyToTry(acc.balance)})
										</option>
									))}
								</select>
							)}
						</div>
					)}

					{/* Destination display for Midas */}
					{!isCash && isMidasAvailable && (
						<div className="form-group">
							<span className="form-label">Yatırılacak Hesap</span>
							<div
								className="locked-field card"
								data-testid="midas-locked-account"
							>
								<Landmark size={16} aria-hidden="true" />
								<span>Midas Likidite Hesabı</span>
							</div>
							<span className="form-hint">
								Midas ödemeleri otomatik olarak Midas likidite hesabına
								aktarılır.
							</span>
						</div>
					)}

					<div className="form-actions">
						<Link
							to="/people/$personId"
							params={{ personId }}
							className="btn btn-secondary"
						>
							<ArrowLeft size={16} aria-hidden="true" />
							<span>Vazgeç</span>
						</Link>

						<button
							type="submit"
							className="btn btn-primary"
							disabled={
								mutation.isPending || hasZeroReceivable || isNetworkUncertain
							}
							data-testid="settle-submit-btn"
						>
							<CheckCircle size={16} aria-hidden="true" />
							<span>
								{mutation.isPending ? "Kaydediliyor..." : "Ödemeyi Kaydet"}
							</span>
						</button>
					</div>
				</form>
			</div>
		</div>
	);
}
