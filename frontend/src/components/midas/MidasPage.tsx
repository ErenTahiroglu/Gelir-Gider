import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
	AlertCircle,
	ArrowRight,
	CreditCard,
	Layers,
	MinusCircle,
	PieChart,
	PlusCircle,
	RefreshCw,
	ShieldAlert,
	Target,
	TrendingUp,
	Wallet,
} from "lucide-react";
import { useMemo, useState } from "react";
import { fetchMidasLiquidity } from "../../api/f7-api";
import type { MidasBucketProductDto } from "../../api/f7-types";
import { classifyMidasLiquidityState } from "../../lib/midas-state";
import { formatMoneyToTry } from "../../lib/money";
import { MidasSetupCard } from "./MidasSetupCard";
import { MidasTransferHistory } from "./MidasTransferHistory";
import { ReserveTransferModal } from "./ReserveTransferModal";

export function MidasPage() {
	const [activeModalBucket, setActiveModalBucket] =
		useState<MidasBucketProductDto | null>(null);
	const [modalMode, setModalMode] = useState<"allocate" | "release">(
		"allocate",
	);

	const {
		data: liquidityData,
		isLoading,
		error,
		refetch,
		isFetching,
	} = useQuery({
		queryKey: ["midas-liquidity"],
		queryFn: () => fetchMidasLiquidity(),
		retry: false,
	});

	const classification = classifyMidasLiquidityState(
		isLoading,
		liquidityData,
		error,
	);

	const liquidity =
		classification.status === "CONFIGURED" ? classification.liquidity : null;

	// Categorize buckets
	const cardReserveBuckets = useMemo(
		() =>
			(liquidity?.buckets ?? []).filter(
				(b) => b.bucketType === "CREDIT_CARD_RESERVE",
			),
		[liquidity?.buckets],
	);

	const goalBuckets = useMemo(
		() =>
			(liquidity?.buckets ?? []).filter(
				(b) => b.bucketType === "SHORT_TERM_GOAL",
			),
		[liquidity?.buckets],
	);

	const pendingLongTermBuckets = useMemo(
		() =>
			(liquidity?.buckets ?? []).filter(
				(b) => b.bucketType === "PENDING_LONG_TERM",
			),
		[liquidity?.buckets],
	);

	const otherBuckets = useMemo(
		() =>
			(liquidity?.buckets ?? []).filter(
				(b) =>
					b.bucketType !== "CREDIT_CARD_RESERVE" &&
					b.bucketType !== "SHORT_TERM_GOAL" &&
					b.bucketType !== "PENDING_LONG_TERM",
			),
		[liquidity?.buckets],
	);

	const handleOpenAllocate = (bucket: MidasBucketProductDto) => {
		setActiveModalBucket(bucket);
		setModalMode("allocate");
	};

	const handleOpenRelease = (bucket: MidasBucketProductDto) => {
		setActiveModalBucket(bucket);
		setModalMode("release");
	};

	if (classification.status === "LOADING") {
		return (
			<div
				className="page-container midas-page"
				data-testid="midas-page-loading"
			>
				<div className="loading-state">
					<RefreshCw size={24} className="spin" aria-hidden="true" />
					<span>Midas likidite durumu yükleniyor...</span>
				</div>
			</div>
		);
	}

	// Section 5, 11: NOT_CONFIGURED state (exact 404 MIDAS_ACCOUNT_NOT_FOUND only)
	if (classification.status === "NOT_CONFIGURED") {
		return (
			<div className="page-container midas-page" data-testid="midas-page-setup">
				<div className="page-header">
					<h1 className="page-title">Midas Likidite Yönetimi</h1>
					<p className="page-subtitle">
						Kart rezervleri ve hedef fonlaması için Midas hesabını bağlayın
					</p>
				</div>
				<MidasSetupCard onSetupSuccess={() => void refetch()} />
			</div>
		);
	}

	// Generic error / authority unavailable / malformed liquidity
	if (classification.status === "ERROR") {
		return (
			<div className="page-container midas-page" data-testid="midas-page-error">
				<div className="alert alert-danger" role="alert">
					<AlertCircle size={20} aria-hidden="true" />
					<div className="alert-content">
						<span>{classification.message}</span>
						<button
							type="button"
							className="btn btn-sm btn-secondary mt-2"
							onClick={() => void refetch()}
							data-testid="midas-retry-btn"
						>
							Yeniden Dene
						</button>
					</div>
				</div>
			</div>
		);
	}

	if (!liquidity) {
		return null;
	}

	return (
		<div className="page-container midas-page" data-testid="midas-page">
			{/* Page Header */}
			<div className="page-header flex justify-between items-center">
				<div>
					<h1 className="page-title">Midas Likidite & Rezerv Yönetimi</h1>
					<p className="page-subtitle">
						Kart rezervleri, birikim havuzları ve serbest nakit bakiyesi
					</p>
				</div>
				<button
					type="button"
					className="btn btn-secondary btn-sm"
					onClick={() => void refetch()}
					disabled={isFetching}
					aria-label="Yenile"
					data-testid="refresh-liquidity-btn"
				>
					<RefreshCw
						size={16}
						className={isFetching ? "spin" : ""}
						aria-hidden="true"
					/>
					<span className="hidden-mobile">Yenile</span>
				</button>
			</div>

			{/* Primary Authoritative Metrics (Section 15 & 16) */}
			<div className="metrics-grid" data-testid="midas-top-metrics">
				<div className="metric-card card">
					<div className="metric-icon-badge bg-primary-subtle text-primary">
						<Wallet size={20} aria-hidden="true" />
					</div>
					<div className="metric-details">
						<span className="metric-label">Fiziksel Midas Bakiyesi</span>
						<span
							className="metric-value font-mono"
							data-testid="metric-physical-balance"
						>
							{formatMoneyToTry(liquidity.physicalBalance)}
						</span>
						<span className="metric-hint text-muted">
							Bağlı hesaptaki toplam bakiye
						</span>
					</div>
				</div>

				<div className="metric-card card">
					<div className="metric-icon-badge bg-warning-subtle text-warning">
						<Layers size={20} aria-hidden="true" />
					</div>
					<div className="metric-details">
						<span className="metric-label">Ayrılmış Toplam</span>
						<span
							className="metric-value font-mono"
							data-testid="metric-total-earmarked"
						>
							{formatMoneyToTry(liquidity.totalEarmarked)}
						</span>
						<span className="metric-hint text-muted">
							Havuzlara ve rezervlere tahsis edilen
						</span>
					</div>
				</div>

				<div className="metric-card card highlight">
					<div className="metric-icon-badge bg-success-subtle text-success">
						<PieChart size={20} aria-hidden="true" />
					</div>
					<div className="metric-details">
						<span className="metric-label">Serbest / Dağıtılmamış Bakiye</span>
						<span
							className="metric-value font-mono text-success"
							data-testid="metric-unallocated-balance"
						>
							{formatMoneyToTry(liquidity.unallocatedBalance)}
						</span>
						<span className="metric-hint text-muted">
							Yeni hedeflere veya rezervlere aktarılabilir
						</span>
					</div>
				</div>
			</div>

			{/* Bucket Pillars Grouping (Section 17 & 18) */}
			<div className="midas-sections-grid mt-6">
				{/* Pillar 1: Kart Rezervleri */}
				<div
					className="card bucket-section-card"
					data-testid="card-reserves-section"
				>
					<div className="card-header flex justify-between items-center">
						<div className="flex items-center gap-2">
							<div className="header-icon-badge">
								<CreditCard size={18} aria-hidden="true" />
							</div>
							<div>
								<h2 className="card-title text-base">Kart Rezervleri</h2>
								<p className="card-subtitle text-xs">
									Kredi kartı ekstreleri için kenara ayrılan güvence bakiyeleri
								</p>
							</div>
						</div>
					</div>

					<div className="card-body">
						{cardReserveBuckets.length === 0 ? (
							<div className="text-muted text-sm py-2">
								Tanımlı kredi kartı rezerv havuzu bulunmuyor.
							</div>
						) : (
							<div className="bucket-list">
								{cardReserveBuckets.map((bucket) => (
									<div
										key={bucket.bucketId}
										className="bucket-item card-subtle flex justify-between items-center"
										data-testid={`reserve-bucket-${bucket.bucketId}`}
									>
										<div className="bucket-info">
											<span className="bucket-name font-medium">
												{bucket.name}
											</span>
											<span className="bucket-type-label text-xs text-muted block">
												Kart Rezervi
											</span>
										</div>

										<div className="bucket-balance-actions flex items-center gap-3">
											<span className="bucket-balance font-mono font-semibold">
												{formatMoneyToTry(bucket.balance)}
											</span>
											<div className="btn-group">
												<button
													type="button"
													className="btn btn-sm btn-secondary"
													onClick={() => handleOpenAllocate(bucket)}
													title="Rezervi Artır"
													aria-label={`${bucket.name} rezervini artır`}
													data-testid={`btn-allocate-${bucket.bucketId}`}
												>
													<PlusCircle size={14} aria-hidden="true" />
													<span>Artır</span>
												</button>
												<button
													type="button"
													className="btn btn-sm btn-secondary"
													onClick={() => handleOpenRelease(bucket)}
													title="Rezervden Serbeste Aktar"
													aria-label={`${bucket.name} rezervinden serbeste aktar`}
													data-testid={`btn-release-${bucket.bucketId}`}
												>
													<MinusCircle size={14} aria-hidden="true" />
													<span>Çek</span>
												</button>
											</div>
										</div>
									</div>
								))}
							</div>
						)}
					</div>
				</div>

				{/* Pillar 2: Kısa Vadeli Hedef Fonları */}
				<div
					className="card bucket-section-card"
					data-testid="goal-reserves-section"
				>
					<div className="card-header flex justify-between items-center">
						<div className="flex items-center gap-2">
							<div className="header-icon-badge">
								<Target size={18} aria-hidden="true" />
							</div>
							<div>
								<h2 className="card-title text-base">
									Kısa Vadeli Hedef Fonları
								</h2>
								<p className="card-subtitle text-xs">
									Aktif birikim hedeflerine ayrılan tutarlar
								</p>
							</div>
						</div>
						<Link
							to="/goals"
							className="btn btn-sm btn-secondary"
							data-testid="link-to-goals"
						>
							<span>Hedeflere Git</span>
							<ArrowRight size={14} aria-hidden="true" />
						</Link>
					</div>

					<div className="card-body">
						{goalBuckets.length === 0 ? (
							<div className="text-muted text-sm py-2">
								Ayrılmış hedef fonu bulunmuyor.
							</div>
						) : (
							<div className="bucket-list">
								{goalBuckets.map((bucket) => (
									<div
										key={bucket.bucketId}
										className="bucket-item card-subtle flex justify-between items-center"
										data-testid={`goal-bucket-${bucket.bucketId}`}
									>
										<div className="bucket-info">
											<span className="bucket-name font-medium">
												{bucket.name}
											</span>
											<span className="bucket-type-label text-xs text-muted block">
												Kısa Vadeli Hedef
											</span>
										</div>
										<span className="bucket-balance font-mono font-semibold">
											{formatMoneyToTry(bucket.balance)}
										</span>
									</div>
								))}
							</div>
						)}
						<p className="text-xs text-muted mt-2">
							* Hedef fonlama ve bakiye iadesi Hedefler sayfası üzerinden
							yönetilir.
						</p>
					</div>
				</div>

				{/* Pillar 3: Uzun Vadeliye Gönderilecek (Section 18 & 19) */}
				<div
					className="card bucket-section-card"
					data-testid="long-term-reserves-section"
				>
					<div className="card-header flex justify-between items-center">
						<div className="flex items-center gap-2">
							<div className="header-icon-badge">
								<TrendingUp size={18} aria-hidden="true" />
							</div>
							<div>
								<h2 className="card-title text-base">
									Uzun Vadeliye Gönderilecek
								</h2>
								<p className="card-subtitle text-xs">
									Dış yatırıma aktarılmak üzere Midas içinde bekletilen geçici
									fonlar
								</p>
							</div>
						</div>
						<Link
							to="/long-term"
							className="btn btn-sm btn-secondary"
							data-testid="link-to-long-term"
						>
							<span>Yatırımlara Git</span>
							<ArrowRight size={14} aria-hidden="true" />
						</Link>
					</div>

					<div className="card-body">
						{pendingLongTermBuckets.length === 0 ? (
							<div className="text-muted text-sm py-2">
								Bekleyen uzun vadeli yatırım transferi yok.
							</div>
						) : (
							<div className="bucket-list">
								{pendingLongTermBuckets.map((bucket) => (
									<div
										key={bucket.bucketId}
										className="bucket-item card-subtle flex justify-between items-center"
										data-testid={`pending-long-term-bucket-${bucket.bucketId}`}
									>
										<div className="bucket-info">
											<span className="bucket-name font-medium">
												{bucket.name}
											</span>
											<span className="bucket-type-label text-xs text-muted block">
												Bekleyen Transfer Earmark
											</span>
										</div>
										<span className="bucket-balance font-mono font-semibold">
											{formatMoneyToTry(bucket.balance)}
										</span>
									</div>
								))}
							</div>
						)}
						<p className="text-xs text-muted mt-2">
							* Bu havuz fiziki yatırım bakiyesi değildir; dışarı gönderilmeyi
							bekleyen görevler için Midas içinde ayrılmış geçici rezervdir.
						</p>
					</div>
				</div>

				{/* Pillar 4: Diğer Rezervler */}
				{otherBuckets.length > 0 && (
					<div
						className="card bucket-section-card"
						data-testid="other-reserves-section"
					>
						<div className="card-header">
							<div className="flex items-center gap-2">
								<div className="header-icon-badge">
									<ShieldAlert size={18} aria-hidden="true" />
								</div>
								<div>
									<h2 className="card-title text-base">Diğer Rezervler</h2>
									<p className="card-subtitle text-xs">
										Acil durum ve gelir tamponu havuzları
									</p>
								</div>
							</div>
						</div>

						<div className="card-body">
							<div className="bucket-list">
								{otherBuckets.map((bucket) => (
									<div
										key={bucket.bucketId}
										className="bucket-item card-subtle flex justify-between items-center"
										data-testid={`other-bucket-${bucket.bucketId}`}
									>
										<div className="bucket-info">
											<span className="bucket-name font-medium">
												{bucket.name}
											</span>
											<span className="bucket-type-label text-xs text-muted block">
												{bucket.bucketType === "CORE_EMERGENCY_FUND"
													? "Acil Durum Fonu"
													: bucket.bucketType === "INCOME_BUFFER"
														? "Gelir Tamponu"
														: "Orta Vadeli Rezerv"}
											</span>
										</div>
										<span className="bucket-balance font-mono font-semibold">
											{formatMoneyToTry(bucket.balance)}
										</span>
									</div>
								))}
							</div>
						</div>
					</div>
				)}
			</div>

			{/* Midas Transfer History */}
			<div className="mt-6">
				<MidasTransferHistory
					midasAccountId={liquidity.midasAccountId}
					buckets={liquidity.buckets}
				/>
			</div>

			{/* Reserve Transfer Modal */}
			{activeModalBucket && (
				<ReserveTransferModal
					isOpen={Boolean(activeModalBucket)}
					onClose={() => setActiveModalBucket(null)}
					midasAccountId={liquidity.midasAccountId}
					reserveBucket={activeModalBucket}
					unallocatedBalance={liquidity.unallocatedBalance}
					mode={modalMode}
				/>
			)}
		</div>
	);
}
