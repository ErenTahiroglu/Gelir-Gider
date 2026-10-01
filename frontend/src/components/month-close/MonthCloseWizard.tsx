import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import {
	AlertCircle,
	ArrowLeft,
	CalendarCheck,
	CheckCircle,
	ChevronRight,
	Info,
	RefreshCw,
	Sparkles,
} from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { ApiError, isNetworkUncertainError } from "../../api/errors";
import {
	commitMonthClose,
	fetchMonthClose,
	fetchMonthClosePreview,
} from "../../api/month-close-api";
import type { MonthCloseCommitPayload } from "../../api/month-close-types";
import { fetchAllActiveCreditCards } from "../../api/quick-entry-api";
import {
	formatPeriodMonthTurkish,
	getPreviousIstanbulPeriodMonth,
	isIstanbulPeriodEnded,
} from "../../lib/istanbul-date";
import {
	formatCentsToCanonical,
	formatMoneyToTry,
	parseMoneyToCents,
} from "../../lib/money";
import { MoneyInput } from "../common/MoneyInput";
import { formatDecisionLabel, formatRouteLabel } from "./MonthClosePage";

export function MonthCloseWizard() {
	const navigate = useNavigate();
	const queryClient = useQueryClient();

	// Read optional periodMonth from search or default to previous completed month
	const search = useSearch({ strict: false }) as
		| { periodMonth?: string }
		| undefined;
	const defaultPeriod =
		search?.periodMonth && /^\d{4}-\d{2}$/.test(search.periodMonth)
			? search.periodMonth
			: getPreviousIstanbulPeriodMonth();
	const [selectedPeriod, setSelectedPeriod] = useState<string>(defaultPeriod);

	// Wizard step state (1 to 5)
	const [currentStep, setCurrentStep] = useState<1 | 2 | 3 | 4 | 5>(1);

	// Step 4 decisions (only for route === SHORT_TERM_GOAL)
	const [shortTermDecision, setShortTermDecision] = useState<
		"FULL" | "PARTIAL" | "SKIP"
	>("FULL");
	const [partialAmount, setPartialAmount] = useState<string>("");

	// Submission state
	const [submitting, setSubmitting] = useState(false);
	const [submitError, setSubmitError] = useState<string | null>(null);
	const [uncertainWarning, setUncertainWarning] = useState<string | null>(null);
	const [staleProposalWarning, setStaleProposalWarning] = useState<
		string | null
	>(null);
	const [isClosedSuccess, setIsClosedSuccess] = useState(false);

	const frozenCommitAttemptRef = useRef<{
		key: string;
		payload: MonthCloseCommitPayload;
	} | null>(null);

	// 1. Fetch Month Close Preview
	const {
		data: proposal,
		isLoading: previewLoading,
		isError: previewError,
		error: previewErr,
		refetch: refetchPreview,
	} = useQuery({
		queryKey: ["month-close-preview", selectedPeriod],
		queryFn: () => fetchMonthClosePreview(selectedPeriod),
		staleTime: 10_000,
	});

	// 2. Check if period is already closed
	const { data: existingClose } = useQuery({
		queryKey: ["month-close", selectedPeriod],
		queryFn: () => fetchMonthClose(selectedPeriod),
		staleTime: 30_000,
	});

	// 3. Informational card query for Step 3
	const {
		data: cards,
		isLoading: cardsLoading,
		isError: cardsError,
	} = useQuery({
		queryKey: ["active-credit-cards"],
		queryFn: () => fetchAllActiveCreditCards(100),
		staleTime: 30_000,
	});

	// Calendar check in Europe/Istanbul
	const isPeriodEnded = isIstanbulPeriodEnded(selectedPeriod);
	const isAlreadyClosed = Boolean(existingClose);

	// Step 2 blocked reason
	const blockedReason = proposal?.blockedReason ?? null;
	const isUnclassifiedBlocked =
		blockedReason === "MONTH_CLOSE_UNCLASSIFIED_EXPENSES";
	const isMidasMissing = blockedReason === "MONTH_CLOSE_MIDAS_NOT_FOUND";
	const isBudgetPlanMissing =
		blockedReason === "MONTH_CLOSE_BUDGET_PLAN_NOT_FOUND" ||
		blockedReason === "MONTH_CLOSE_BUDGET_PLAN_NOT_ACTIVE";

	// Route & Liquidity checks for Step 4
	const route = proposal?.route ?? "NONE";
	const fullOfferAmount = proposal?.fullOfferAmount ?? "0.00";
	const midasUnallocatedBalance = proposal?.midasUnallocatedBalance ?? "0.00";

	// BigInt checks for partial amount and liquidity
	const fullOfferCents = useMemo(
		() => (fullOfferAmount ? parseMoneyToCents(fullOfferAmount) : 0n),
		[fullOfferAmount],
	);

	const midasUnallocatedCents = useMemo(
		() =>
			midasUnallocatedBalance ? parseMoneyToCents(midasUnallocatedBalance) : 0n,
		[midasUnallocatedBalance],
	);

	const partialAmountCents = useMemo(() => {
		if (!partialAmount?.trim()) return 0n;
		try {
			return parseMoneyToCents(partialAmount);
		} catch {
			return 0n;
		}
	}, [partialAmount]);

	// Planned applied amount
	const plannedAppliedCents = useMemo(() => {
		if (route === "NONE") return 0n;
		if (route !== "SHORT_TERM_GOAL") {
			return fullOfferCents;
		}
		if (shortTermDecision === "FULL") return fullOfferCents;
		if (shortTermDecision === "PARTIAL") return partialAmountCents;
		return 0n; // SKIP
	}, [route, shortTermDecision, fullOfferCents, partialAmountCents]);

	const isLiquidityShortfall =
		plannedAppliedCents > 0n && plannedAppliedCents > midasUnallocatedCents;

	const isMediumShortfall =
		route === "MEDIUM_TERM_RESERVE" && fullOfferCents > midasUnallocatedCents;

	// Execute commit
	const executeCommit = async (isRetry: boolean) => {
		if (!proposal) return;
		setSubmitError(null);
		setUncertainWarning(null);
		setStaleProposalWarning(null);

		let key: string;
		let payload: MonthCloseCommitPayload;

		if (isRetry && frozenCommitAttemptRef.current) {
			key = frozenCommitAttemptRef.current.key;
			payload = frozenCommitAttemptRef.current.payload;
		} else {
			key = crypto.randomUUID();
			const nowUtcIso = new Date().toISOString();

			payload = {
				periodMonth: selectedPeriod,
				expectedProposalFingerprint: proposal.proposalFingerprint,
				occurredAt: nowUtcIso,
			};

			if (route === "SHORT_TERM_GOAL") {
				payload.decision = shortTermDecision;
				if (shortTermDecision === "PARTIAL") {
					payload.partialAmount = partialAmount;
				}
			}

			frozenCommitAttemptRef.current = { key, payload };
		}

		setSubmitting(true);
		try {
			const _res = await commitMonthClose(payload, key);

			// Haptic celebration if browser supports
			if (typeof navigator !== "undefined" && "vibrate" in navigator) {
				try {
					navigator.vibrate([40, 60, 100]);
				} catch {
					// Ignore
				}
			}

			// Invalidate all related query keys
			await queryClient.invalidateQueries({ queryKey: ["month-closes"] });
			await queryClient.invalidateQueries({
				queryKey: ["month-close", selectedPeriod],
			});
			await queryClient.invalidateQueries({
				queryKey: ["month-close-preview", selectedPeriod],
			});
			await queryClient.invalidateQueries({ queryKey: ["midas-liquidity"] });
			await queryClient.invalidateQueries({ queryKey: ["midas-transfers"] });
			await queryClient.invalidateQueries({ queryKey: ["short-term-goals"] });
			if (proposal.recommendedGoal?.goalId) {
				await queryClient.invalidateQueries({
					queryKey: ["short-term-goal", proposal.recommendedGoal.goalId],
				});
			}

			setIsClosedSuccess(true);
		} catch (err) {
			if (isNetworkUncertainError(err)) {
				setUncertainWarning(
					"Ağ bağlantısı belirsiz. İstek sunucuya ulaşmış olabilir. Lütfen 'Aynı Bilgilerle Tekrar Dene' ile yeniden deneyin.",
				);
			} else if (err instanceof ApiError) {
				if (err.code === "MONTH_CLOSE_STALE_PROPOSAL") {
					frozenCommitAttemptRef.current = null;
					await refetchPreview();
					setCurrentStep(4);
					setStaleProposalWarning(
						"Kapanış verileri siz incelerken değişti. Güncel öneri yeniden yüklendi; lütfen tekrar kontrol edin.",
					);
				} else if (err.code === "MONTH_CLOSE_ALREADY_CLOSED") {
					void navigate({
						to: "/month-close/$periodMonth",
						params: { periodMonth: selectedPeriod },
					});
				} else {
					setSubmitError(err.userMessage);
				}
			} else {
				setSubmitError("Dönem kapatılırken beklenmeyen bir hata oluştu.");
			}
		} finally {
			setSubmitting(false);
		}
	};

	// Celebration Screen
	if (isClosedSuccess) {
		return (
			<div className="wizard-celebration-container container mx-auto px-4 py-12 max-w-xl text-center">
				<div className="card p-8 bg-surface shadow-lg border border-success/30">
					<div className="flex justify-center mb-4">
						<div className="rounded-full bg-success/20 p-4 text-success">
							<Sparkles size={48} aria-hidden="true" />
						</div>
					</div>

					<h1 className="text-2xl font-bold mb-2">
						✓ {formatPeriodMonthTurkish(selectedPeriod)} Dönemi Başarıyla
						Tamamlandı!
					</h1>
					<p className="text-secondary text-sm mb-6">
						Ay kapanış kayıtları kesinleşti ve bütçe fazlası yönlendirme işlemi
						uygulandı.
					</p>

					<div className="flex justify-center gap-3">
						<Link
							to="/month-close/$periodMonth"
							params={{ periodMonth: selectedPeriod }}
							className="btn btn-primary"
						>
							Kapanış Özetini İncele
						</Link>
						<Link to="/month-close" className="btn btn-secondary">
							Kapanış Geçmişi
						</Link>
					</div>
				</div>
			</div>
		);
	}

	return (
		<div
			className="month-close-wizard container mx-auto px-4 py-6 max-w-3xl"
			data-testid="month-close-wizard"
		>
			{/* Wizard Header */}
			<div className="flex items-center gap-3 mb-6">
				<button
					type="button"
					className="btn btn-icon btn-secondary"
					onClick={() => void navigate({ to: "/month-close" })}
					aria-label="Kapanış Geçmişine Dön"
				>
					<ArrowLeft size={18} aria-hidden="true" />
				</button>
				<div>
					<h1 className="page-title text-2xl font-bold mb-0 flex items-center gap-2">
						<CalendarCheck
							size={24}
							className="text-primary"
							aria-hidden="true"
						/>
						<span>
							Ayı Tamamla — {formatPeriodMonthTurkish(selectedPeriod)}
						</span>
					</h1>
					<p className="text-secondary text-xs">
						5 Adımlı Dönem Sonu Kapanış ve Fazlalık Yönlendirme Sihirbazı
					</p>
				</div>
			</div>

			{/* Wizard Step Indicator */}
			<div className="wizard-steps-indicator mb-6 overflow-x-auto">
				<div className="flex items-center gap-2 min-w-max p-2 bg-secondary/10 rounded-lg text-sm">
					{[
						{ num: 1, label: "1. Kontrol" },
						{ num: 2, label: "2. Eksikler" },
						{ num: 3, label: "3. Kartlar" },
						{ num: 4, label: "4. Fazlalık" },
						{ num: 5, label: "5. Onay" },
					].map((s) => (
						<div
							key={s.num}
							className={`flex items-center gap-1.5 px-3 py-1.5 rounded font-medium transition-colors ${
								currentStep === s.num
									? "bg-primary text-white font-semibold"
									: currentStep > s.num
										? "text-success bg-success/15"
										: "text-secondary"
							}`}
						>
							<span>{s.label}</span>
						</div>
					))}
				</div>
			</div>

			{staleProposalWarning && (
				<div className="alert alert-warning mb-4" role="alert">
					{staleProposalWarning}
				</div>
			)}

			{/* ==================================================================== */}
			{/* ADIM 1: DÖNEM KONTROLÜ */}
			{/* ==================================================================== */}
			{currentStep === 1 && (
				<div className="step-panel card p-6" data-testid="wizard-step-1">
					<h2 className="text-xl font-bold mb-2">Adım 1: Dönem Kontrolü</h2>
					<p className="text-sm text-secondary mb-4">
						Kapatmak istediğiniz ayı seçin. Sistem dönem sonu mutabakat
						verilerini kontrol eder.
					</p>

					<div className="form-group mb-4 max-w-xs">
						<label
							htmlFor="wizard-period-select"
							className="form-label font-medium"
						>
							Dönem Ayı (YYYY-MM)
						</label>
						<input
							id="wizard-period-select"
							type="month"
							className="form-control"
							value={selectedPeriod}
							onChange={(e) => setSelectedPeriod(e.target.value)}
							required
						/>
					</div>

					{isAlreadyClosed && (
						<div className="alert alert-info mb-4" role="status">
							<p className="font-semibold">Bu dönem daha önce tamamlandı.</p>
							<p className="text-sm mt-1">
								{selectedPeriod} dönemi için kapanış işlemi zaten yapılmış ve
								kaydedilmiştir.
							</p>
							<Link
								to="/month-close/$periodMonth"
								params={{ periodMonth: selectedPeriod }}
								className="btn btn-sm btn-outline-primary mt-2 inline-block"
							>
								Mevcut Kapanış Özetini Gör
							</Link>
						</div>
					)}

					{!isPeriodEnded && (
						<div className="alert alert-warning mb-4" role="status">
							<p className="font-semibold">Dönem henüz tamamlanmadı.</p>
							<p className="text-sm mt-1">
								{selectedPeriod} dönemi halen devam ettiği için kesin kapanış
								yapılamaz. Ancak mevcut durumu görmek için önizlemeyi
								inceleyebilirsiniz.
							</p>
						</div>
					)}

					{previewLoading ? (
						<div className="p-6 text-center text-secondary">
							Kapanış önizleme verileri yükleniyor...
						</div>
					) : previewError || !proposal ? (
						<div className="alert alert-danger mb-4">
							Önizleme verileri alınamadı:{" "}
							{previewErr instanceof ApiError
								? previewErr.userMessage
								: "Bilinmeyen hata"}
						</div>
					) : (
						<div className="bg-secondary/10 p-4 rounded mb-6 text-sm">
							<span className="font-semibold block mb-2">Önizleme Özeti:</span>
							<div className="grid grid-cols-2 gap-3">
								<div>
									<span className="text-secondary block">Referans Gelir:</span>
									<span className="font-medium">
										{formatMoneyToTry(proposal.referenceIncome ?? "0.00")}
									</span>
								</div>
								<div>
									<span className="text-secondary block">Kapanış Fazlası:</span>
									<span className="font-semibold text-primary">
										{formatMoneyToTry(proposal.closeSurplus ?? "0.00")}
									</span>
								</div>
							</div>
						</div>
					)}

					<div className="wizard-nav-actions flex justify-end gap-2 mt-6">
						<button
							type="button"
							className="btn btn-primary flex items-center gap-1"
							onClick={() => setCurrentStep(2)}
							disabled={isAlreadyClosed || !isPeriodEnded || !proposal}
							data-testid="btn-wizard-next"
						>
							<span>Devam Et: Eksikler ve Kontroller</span>
							<ChevronRight size={18} aria-hidden="true" />
						</button>
					</div>
				</div>
			)}

			{/* ==================================================================== */}
			{/* ADIM 2: EKSİKLER VE SINIFLANDIRMA */}
			{/* ==================================================================== */}
			{currentStep === 2 && (
				<div className="step-panel card p-6" data-testid="wizard-step-2">
					<h2 className="text-xl font-bold mb-2">
						Adım 2: Eksikler ve Sınıflandırma
					</h2>
					<p className="text-sm text-secondary mb-4">
						Bu dönemde sınıflandırılmamış hareketler veya eksik bütçe planları
						kontrol edilir.
					</p>

					{isUnclassifiedBlocked ? (
						<div
							className="alert alert-danger mb-4"
							role="alert"
							data-testid="unclassified-block-alert"
						>
							<div className="flex items-start gap-2">
								<AlertCircle
									size={20}
									className="flex-shrink-0 mt-0.5"
									aria-hidden="true"
								/>
								<div>
									<p className="font-bold text-base">
										Sınıflandırılmamış Harcama:{" "}
										{formatMoneyToTry(proposal?.unclassifiedExpense ?? "0.00")}
									</p>
									<p className="text-sm mt-1">
										Bu dönemde sınıflandırılmamış harcamalar var. Bütçe
										kapanışının yapılabilmesi için tüm harcamaların kategorize
										edilmesi zorunludur.
									</p>
									<p className="text-xs mt-2 text-secondary">
										Lütfen aşağıdaki bağlantılardan ilgili harcamaları
										kategorize edin ve ardından "Tekrar Kontrol Et" butonuna
										basın.
									</p>
								</div>
							</div>

							<div className="flex flex-wrap gap-2 mt-4 pt-3 border-t border-danger/20">
								<Link
									to="/transactions"
									className="btn btn-sm btn-outline-danger"
									data-testid="btn-goto-transactions"
								>
									Hareketlere Git
								</Link>
								<Link
									to="/cards"
									className="btn btn-sm btn-outline-danger"
									data-testid="btn-goto-cards"
								>
									Kartlara Git
								</Link>
								<button
									type="button"
									className="btn btn-sm btn-secondary flex items-center gap-1"
									onClick={() => void refetchPreview()}
									data-testid="btn-recheck-preview"
								>
									<RefreshCw size={14} aria-hidden="true" />
									<span>Tekrar Kontrol Et</span>
								</button>
							</div>
						</div>
					) : isMidasMissing ? (
						<div className="alert alert-danger mb-4" role="alert">
							<p className="font-bold">Midas Likidite Hesabı Bulunamadı</p>
							<p className="text-sm mt-1">
								Kapanış fazlasının yönlendirilebilmesi için bir Midas likidite
								hesabının kurulu olması gerekir.
							</p>
							<div className="flex gap-2 mt-3">
								<Link to="/midas" className="btn btn-sm btn-primary">
									Midas'ı Kur
								</Link>
								<button
									type="button"
									className="btn btn-sm btn-secondary flex items-center gap-1"
									onClick={() => void refetchPreview()}
								>
									<RefreshCw size={14} aria-hidden="true" />
									<span>Tekrar Kontrol Et</span>
								</button>
							</div>
						</div>
					) : isBudgetPlanMissing ? (
						<div className="alert alert-danger mb-4" role="alert">
							<p className="font-bold">Bütçe Planı Bulunamadı / Aktif Değil</p>
							<p className="text-sm mt-1">
								Bu döneme ait geçerli ve aktif bir bütçe planı bulunmadığından
								dönem kapatılamaz.
							</p>
						</div>
					) : (
						<div
							className="alert alert-success flex items-center gap-2 mb-4"
							role="status"
						>
							<CheckCircle
								size={20}
								className="text-success flex-shrink-0"
								aria-hidden="true"
							/>
							<span className="text-sm font-medium">
								Tebrikler! Bu dönemde sınıflandırılmamış herhangi bir harcama
								bulunmuyor.
							</span>
						</div>
					)}

					<div className="wizard-nav-actions flex justify-between gap-2 mt-6">
						<button
							type="button"
							className="btn btn-secondary flex items-center gap-1"
							onClick={() => setCurrentStep(1)}
						>
							<ArrowLeft size={16} aria-hidden="true" />
							<span>Geri</span>
						</button>
						<button
							type="button"
							className="btn btn-primary flex items-center gap-1"
							onClick={() => setCurrentStep(3)}
							disabled={Boolean(proposal?.blockedReason)}
							data-testid="btn-wizard-next"
						>
							<span>Devam Et: Kartlar ve Yükümlülükler</span>
							<ChevronRight size={18} aria-hidden="true" />
						</button>
					</div>
				</div>
			)}

			{/* ==================================================================== */}
			{/* ADIM 3: KARTLAR & YÜKÜMLÜLÜKLER BİLGİLENDİRME KONTROLÜ */}
			{/* ==================================================================== */}
			{currentStep === 3 && (
				<div className="step-panel card p-6" data-testid="wizard-step-3">
					<h2 className="text-xl font-bold mb-2">
						Adım 3: Kartlar & Yükümlülükler Bilgilendirme Kontrolü
					</h2>
					<p className="text-sm text-secondary mb-4">
						Bu adım bilgilendirme amaçlıdır. Kapanış öncesinde kredi kartı
						yükümlülüklerinizi gözden geçirebilirsiniz.
					</p>

					<div
						className="alert alert-info flex items-start gap-2 mb-4"
						role="note"
					>
						<Info
							size={18}
							className="flex-shrink-0 mt-0.5"
							aria-hidden="true"
						/>
						<div className="text-sm">
							<strong>Bilgilendirme Notu:</strong> Açık veya henüz ödenmemiş
							kart ekstreleri bulunması dönem kapanışına engel teşkil etmez;
							sistem gerçek hesap mutabakat verilerini esas alır.
						</div>
					</div>

					{cardsLoading ? (
						<div className="p-4 text-center text-secondary">
							Kart bilgileri kontrol ediliyor...
						</div>
					) : cardsError ? (
						<div className="alert alert-warning mb-4">
							Kart yükümlülükleri şu anda doğrulanamadı. (Bu durum kapanışı
							engellemez).
						</div>
					) : (cards ?? []).length === 0 ? (
						<div className="p-4 bg-secondary/10 rounded text-center text-sm text-secondary mb-4">
							Tanımlı aktif kredi kartı bulunmuyor.
						</div>
					) : (
						<div className="cards-review-list flex flex-col gap-3 mb-4">
							{(cards ?? []).map((card) => (
								<div
									key={card.cardId}
									className="p-3 border rounded flex justify-between items-center text-sm"
								>
									<div>
										<span className="font-semibold block">
											{card.displayName}
										</span>
										<span className="text-xs text-secondary font-mono">
											{card.lastFour
												? `Son 4 Hane: **** ${card.lastFour}`
												: "Son 4 hane mevcut değil"}
										</span>
									</div>
									<Link
										to="/cards/$cardId"
										params={{ cardId: card.cardId }}
										className="btn btn-sm btn-ghost"
									>
										Kartı İncele
									</Link>
								</div>
							))}
						</div>
					)}

					<div className="wizard-nav-actions flex justify-between gap-2 mt-6">
						<button
							type="button"
							className="btn btn-secondary flex items-center gap-1"
							onClick={() => setCurrentStep(2)}
						>
							<ArrowLeft size={16} aria-hidden="true" />
							<span>Geri</span>
						</button>
						<button
							type="button"
							className="btn btn-primary flex items-center gap-1"
							onClick={() => setCurrentStep(4)}
							data-testid="btn-wizard-next"
						>
							<span>Devam Et: Fazlalık Yönlendirme</span>
							<ChevronRight size={18} aria-hidden="true" />
						</button>
					</div>
				</div>
			)}

			{/* ==================================================================== */}
			{/* ADIM 4: FAZLALIK DAĞITIM KARARI */}
			{/* ==================================================================== */}
			{currentStep === 4 && (
				<div className="step-panel card p-6" data-testid="wizard-step-4">
					<h2 className="text-xl font-bold mb-2">
						Adım 4: Fazlalık Dağıtım Kararı
					</h2>
					<p className="text-sm text-secondary mb-4">
						Kapanış fazlasının nereye ve nasıl aktarılacağına ilişkin sistem
						önerisi.
					</p>

					{/* Route presentation */}
					{route === "SHORT_TERM_GOAL" && proposal?.recommendedGoal ? (
						<div className="short-term-routing-box mb-6">
							<div className="p-4 bg-primary/10 border border-primary/20 rounded mb-4">
								<div className="flex justify-between items-start mb-2">
									<div>
										<span className="text-xs font-semibold uppercase text-primary tracking-wider block">
											Önerilen Kısa Vadeli Hedef
										</span>
										<h3 className="font-bold text-lg text-foreground">
											{proposal.recommendedGoal.name}
										</h3>
									</div>
									<span className="badge badge-primary">
										Öncelik #{proposal.recommendedGoal.priority}
									</span>
								</div>

								<div className="grid grid-cols-2 gap-2 text-sm mt-3 pt-2 border-t border-primary/15">
									<div>
										<span className="text-secondary text-xs block">
											Hedefe Kalan Açık:
										</span>
										<span className="font-semibold">
											{formatMoneyToTry(
												proposal.recommendedGoal.remainingToTarget,
											)}
										</span>
									</div>
									<div>
										<span className="text-secondary text-xs block">
											Önerilen Aktarım Tutarı:
										</span>
										<span className="font-bold text-success">
											{formatMoneyToTry(fullOfferAmount)}
										</span>
									</div>
								</div>
							</div>

							{isLiquidityShortfall && (
								<div className="alert alert-warning mb-4" role="alert">
									Midas Serbest Bakiye (
									{formatMoneyToTry(midasUnallocatedBalance)}) önerilen aktarım
									için şu anda yeterli değil.
								</div>
							)}

							<div className="decisions-options flex flex-col gap-3">
								<label
									className={`decision-card p-3 border rounded cursor-pointer transition-colors ${
										shortTermDecision === "FULL"
											? "border-primary bg-primary/5"
											: ""
									}`}
								>
									<div className="flex items-center gap-3">
										<input
											type="radio"
											name="short-term-decision"
											checked={shortTermDecision === "FULL"}
											onChange={() => setShortTermDecision("FULL")}
											data-testid="decision-FULL"
										/>
										<div>
											<span className="font-bold text-sm block">
												Tamamını Aktar (FULL)
											</span>
											<span className="text-xs text-secondary">
												Önerilen tutarın tamamı (
												{formatMoneyToTry(fullOfferAmount)}) hedefe aktarılır.
											</span>
										</div>
									</div>
								</label>

								<label
									className={`decision-card p-3 border rounded cursor-pointer transition-colors ${
										shortTermDecision === "PARTIAL"
											? "border-primary bg-primary/5"
											: ""
									}`}
								>
									<div className="flex items-start gap-3">
										<input
											type="radio"
											name="short-term-decision"
											checked={shortTermDecision === "PARTIAL"}
											onChange={() => setShortTermDecision("PARTIAL")}
											data-testid="decision-PARTIAL"
											className="mt-1"
										/>
										<div className="flex-1">
											<span className="font-bold text-sm block">
												Kısmi Aktar (PARTIAL)
											</span>
											<span className="text-xs text-secondary block mb-2">
												Belirleyeceğiniz kısmi tutar hedefe aktarılır, kalan
												serbest bakiyede kalır.
											</span>

											{shortTermDecision === "PARTIAL" && (
												<div className="mt-2 max-w-xs">
													<MoneyInput
														id="partial-amount-input"
														value={partialAmount}
														onChange={setPartialAmount}
														placeholder="0,00"
														required
													/>
													<small className="text-xs text-secondary mt-1 block">
														0'dan büyük ve {formatMoneyToTry(fullOfferAmount)}{" "}
														tutarından küçük olmalıdır.
													</small>
												</div>
											)}
										</div>
									</div>
								</label>

								<label
									className={`decision-card p-3 border rounded cursor-pointer transition-colors ${
										shortTermDecision === "SKIP"
											? "border-primary bg-primary/5"
											: ""
									}`}
								>
									<div className="flex items-center gap-3">
										<input
											type="radio"
											name="short-term-decision"
											checked={shortTermDecision === "SKIP"}
											onChange={() => setShortTermDecision("SKIP")}
											data-testid="decision-SKIP"
										/>
										<div>
											<span className="font-bold text-sm block">
												Bu Ay Pas Geç (SKIP)
											</span>
											<span className="text-xs text-secondary">
												Bu dönem fazlalık otomatik olarak hedefe aktarılmayacak;
												Midas serbest likiditesinde kalır.
											</span>
										</div>
									</div>
								</label>
							</div>
						</div>
					) : route === "MEDIUM_TERM_RESERVE" ? (
						<div className="medium-routing-box mb-6">
							<div className="p-4 bg-secondary/10 rounded mb-4">
								<h3 className="font-bold text-base mb-1">
									Orta Vadeli Rezerv (AUTO_MEDIUM)
								</h3>
								<p className="text-sm text-secondary mb-2">
									Öncelikli aktif bir kısa vadeli hedef bulunmadığı için kapanış
									fazlası otomatik olarak orta vadeli acil durum rezervine
									aktarılacaktır.
								</p>
								<div className="font-semibold text-lg text-primary">
									Aktarılacak Tutar: {formatMoneyToTry(fullOfferAmount)}
								</div>
							</div>

							{isMediumShortfall && (
								<div className="alert alert-danger mb-4">
									<p className="font-bold">Midas Serbest Bakiye yetersiz</p>
									<p className="text-sm mt-1">
										Midas Serbest Bakiye (
										{formatMoneyToTry(midasUnallocatedBalance)}) kapanış
										aktarımı ({formatMoneyToTry(fullOfferAmount)}) için yeterli
										değil.
									</p>
									<div className="flex gap-2 mt-3">
										<Link
											to="/midas"
											className="btn btn-sm btn-outline-primary"
										>
											Likiditeyi Gör
										</Link>
										<button
											type="button"
											className="btn btn-sm btn-secondary flex items-center gap-1"
											onClick={() => void refetchPreview()}
										>
											<RefreshCw size={14} aria-hidden="true" />
											<span>Tekrar Kontrol Et</span>
										</button>
									</div>
								</div>
							)}
						</div>
					) : (
						<div className="none-routing-box mb-6 p-4 bg-secondary/10 rounded text-sm text-secondary">
							Bu dönem için aktarılacak kapanış fazlası bulunmuyor (İşlem Yok).
						</div>
					)}

					<div className="wizard-nav-actions flex justify-between gap-2 mt-6">
						<button
							type="button"
							className="btn btn-secondary flex items-center gap-1"
							onClick={() => setCurrentStep(3)}
						>
							<ArrowLeft size={16} aria-hidden="true" />
							<span>Geri</span>
						</button>
						<button
							type="button"
							className="btn btn-primary flex items-center gap-1"
							onClick={() => setCurrentStep(5)}
							disabled={
								isMediumShortfall ||
								(route === "SHORT_TERM_GOAL" &&
									shortTermDecision === "PARTIAL" &&
									(partialAmountCents <= 0n ||
										partialAmountCents >= fullOfferCents))
							}
							data-testid="btn-wizard-next"
						>
							<span>Devam Et: Onay ve Tamamla</span>
							<ChevronRight size={18} aria-hidden="true" />
						</button>
					</div>
				</div>
			)}

			{/* ==================================================================== */}
			{/* ADIM 5: ONAY VE AYI TAMAMLA */}
			{/* ==================================================================== */}
			{currentStep === 5 && (
				<div className="step-panel card p-6" data-testid="wizard-step-5">
					<h2 className="text-xl font-bold mb-2">
						Adım 5: Özeti Gör ve Ayı Tamamla
					</h2>
					<p className="text-sm text-secondary mb-4">
						Aşağıdaki verileri inceleyip dönemi kesin olarak kapatın.
					</p>

					{submitError && (
						<div className="alert alert-danger mb-4" role="alert">
							{submitError}
						</div>
					)}

					{uncertainWarning && (
						<div className="alert alert-warning mb-4" role="alert">
							{uncertainWarning}
						</div>
					)}

					{!isPeriodEnded && (
						<div className="alert alert-warning mb-4" role="alert">
							Dönem henüz tamamlanmadığı için kesin kapanış yapılamaz.
						</div>
					)}

					{/* Authoritative Confirmation Summary */}
					<div className="confirmation-summary p-4 bg-secondary/10 rounded mb-6 text-sm">
						<dl className="grid grid-cols-1 sm:grid-cols-2 gap-y-2 gap-x-4">
							<div>
								<dt className="text-secondary text-xs">Dönem</dt>
								<dd className="font-bold">
									{formatPeriodMonthTurkish(selectedPeriod)}
								</dd>
							</div>
							<div>
								<dt className="text-secondary text-xs">Referans Gelir</dt>
								<dd className="font-bold">
									{formatMoneyToTry(proposal?.referenceIncome ?? "0.00")}
								</dd>
							</div>
							<div>
								<dt className="text-secondary text-xs">
									Zorunlu Harcama / Kullanılmayan
								</dt>
								<dd className="font-medium text-success">
									{formatMoneyToTry(proposal?.mandatory?.unused ?? "0.00")}
								</dd>
							</div>
							<div>
								<dt className="text-secondary text-xs">
									Esnek Harcama / Kullanılmayan
								</dt>
								<dd className="font-medium text-success">
									{formatMoneyToTry(proposal?.discretionary?.unused ?? "0.00")}
								</dd>
							</div>
							<div>
								<dt className="text-secondary text-xs">Kapanış Fazlası</dt>
								<dd className="font-bold text-primary">
									{formatMoneyToTry(proposal?.closeSurplus ?? "0.00")}
								</dd>
							</div>
							<div>
								<dt className="text-secondary text-xs">Dağıtılabilir Tutar</dt>
								<dd className="font-bold">
									{formatMoneyToTry(
										proposal?.adjustedRoutableSurplus ?? "0.00",
									)}
								</dd>
							</div>
							<div>
								<dt className="text-secondary text-xs">Yönlendirme & Karar</dt>
								<dd className="font-semibold">
									{formatRouteLabel(
										route as "SHORT_TERM_GOAL" | "MEDIUM_TERM_RESERVE" | "NONE",
									)}
									{route === "SHORT_TERM_GOAL" &&
										` — ${formatDecisionLabel(shortTermDecision)}`}
								</dd>
							</div>
							<div>
								<dt className="text-secondary text-xs">
									Aktarılması Beklenen Tutar
								</dt>
								<dd className="font-bold text-success">
									{formatMoneyToTry(
										formatCentsToCanonical(plannedAppliedCents),
									)}
								</dd>
							</div>
						</dl>
					</div>

					<div className="wizard-nav-actions flex justify-between gap-2 mt-6">
						<button
							type="button"
							className="btn btn-secondary flex items-center gap-1"
							onClick={() => setCurrentStep(4)}
							disabled={submitting}
						>
							<ArrowLeft size={16} aria-hidden="true" />
							<span>Geri</span>
						</button>

						<div className="flex gap-2">
							{uncertainWarning && (
								<button
									type="button"
									className="btn btn-warning"
									onClick={() => void executeCommit(true)}
									disabled={submitting}
								>
									Aynı Bilgilerle Tekrar Dene
								</button>
							)}

							<button
								type="button"
								className="btn btn-primary font-bold px-6"
								onClick={() => void executeCommit(false)}
								disabled={submitting || !isPeriodEnded || isAlreadyClosed}
								data-testid="btn-commit-month-close"
							>
								{submitting
									? "Kapanış Uygulanıyor..."
									: `${selectedPeriod} Dönemini Tamamla`}
							</button>
						</div>
					</div>
				</div>
			)}
		</div>
	);
}
