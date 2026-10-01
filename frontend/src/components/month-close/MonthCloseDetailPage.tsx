import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import { fetchMonthClose } from "../../api/month-close-api";
import {
	formatIstanbulDateTimeTurkish,
	formatPeriodMonthTurkish,
} from "../../lib/istanbul-date";
import { formatMoneyToTry } from "../../lib/money";
import { formatDecisionLabel, formatRouteLabel } from "./MonthClosePage";

interface MonthCloseDetailPageProps {
	periodMonth: string;
}

export function MonthCloseDetailPage({
	periodMonth,
}: MonthCloseDetailPageProps) {
	const navigate = useNavigate();

	const {
		data: monthClose,
		isLoading,
		isError,
	} = useQuery({
		queryKey: ["month-close", periodMonth],
		queryFn: () => fetchMonthClose(periodMonth),
		staleTime: 60_000,
	});

	if (isLoading) {
		return (
			<div className="detail-page-container">
				<div className="card p-8 text-center text-secondary">
					Dönem kapanış özeti yükleniyor...
				</div>
			</div>
		);
	}

	if (isError || !monthClose) {
		return (
			<div className="detail-page-container">
				<div className="card p-8 text-center text-danger">
					<p className="mb-3">
						{periodMonth} dönemi için tamamlanmış bir kapanış kaydı bulunamadı.
					</p>
					<button
						type="button"
						className="btn btn-secondary inline-flex items-center gap-1"
						onClick={() => void navigate({ to: "/month-close" })}
					>
						<ArrowLeft size={16} aria-hidden="true" />
						<span>Kapanış Geçmişine Dön</span>
					</button>
				</div>
			</div>
		);
	}

	return (
		<div
			className="detail-page-container"
			data-testid="month-close-detail-page"
		>
			<div className="flex items-center justify-between gap-3 mb-6">
				<div className="flex items-center gap-3">
					<button
						type="button"
						className="btn btn-icon btn-secondary"
						onClick={() => void navigate({ to: "/month-close" })}
						aria-label="Geri Dön"
					>
						<ArrowLeft size={18} aria-hidden="true" />
					</button>
					<div>
						<h1 className="page-title mb-0 flex items-center gap-2">
							<span>
								{formatPeriodMonthTurkish(monthClose.periodMonth)} Kapanış Özeti
							</span>
							<span className="badge badge-success text-xs">Tamamlandı</span>
						</h1>
						<span className="text-xs text-secondary">
							Kapanış Tarihi:{" "}
							{formatIstanbulDateTimeTurkish(monthClose.occurredAt)}
						</span>
					</div>
				</div>
			</div>

			<div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
				<div className="card p-4">
					<span className="text-xs text-secondary block mb-1">
						Referans Gelir
					</span>
					<span className="text-2xl font-bold block">
						{formatMoneyToTry(monthClose.referenceIncome)}
					</span>
					<span className="text-xs text-secondary mt-1 block">
						Bütçe politika baz geliri
					</span>
				</div>

				<div className="card p-4">
					<span className="text-xs text-secondary block mb-1">
						Kapanış Fazlası
					</span>
					<span className="text-2xl font-bold text-primary block">
						{formatMoneyToTry(monthClose.closeSurplus)}
					</span>
					<span className="text-xs text-secondary mt-1 block">
						Düzeltmelerle toplam:{" "}
						{formatMoneyToTry(monthClose.adjustedRoutableSurplus)}
					</span>
				</div>

				<div className="card p-4">
					<span className="text-xs text-secondary block mb-1">
						Aktarılan / Kalan
					</span>
					<span className="text-2xl font-bold text-success block">
						{formatMoneyToTry(monthClose.appliedAmount)}
					</span>
					<span className="text-xs text-secondary mt-1 block">
						Dağıtılmayan: {formatMoneyToTry(monthClose.unroutedAmount)}
					</span>
				</div>
			</div>

			{/* Harcama Gerçekleşmeleri */}
			<div className="card p-6 mb-6">
				<h3 className="font-semibold text-lg mb-4">
					Harcama Gerçekleşmeleri & Tasarruf
				</h3>
				<div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
					<div className="p-4 bg-secondary/10 rounded">
						<span className="font-medium text-sm block mb-2">
							Zorunlu Harcamalar
						</span>
						<div className="space-y-1 text-sm">
							<div className="flex justify-between">
								<span className="text-secondary">Bütçe Tavanı:</span>
								<span>{formatMoneyToTry(monthClose.mandatory.ceiling)}</span>
							</div>
							<div className="flex justify-between">
								<span className="text-secondary">Gerçekleşen Harcama:</span>
								<span>
									{formatMoneyToTry(monthClose.mandatory.actualExpense)}
								</span>
							</div>
							<div className="flex justify-between font-semibold border-t pt-1 text-success">
								<span>Kullanılmayan Tasarruf:</span>
								<span>{formatMoneyToTry(monthClose.mandatory.unused)}</span>
							</div>
						</div>
					</div>

					<div className="p-4 bg-secondary/10 rounded">
						<span className="font-medium text-sm block mb-2">
							Esnek Harcamalar
						</span>
						<div className="space-y-1 text-sm">
							<div className="flex justify-between">
								<span className="text-secondary">Bütçe Tavanı:</span>
								<span>
									{formatMoneyToTry(monthClose.discretionary.ceiling)}
								</span>
							</div>
							<div className="flex justify-between">
								<span className="text-secondary">Gerçekleşen Harcama:</span>
								<span>
									{formatMoneyToTry(monthClose.discretionary.actualExpense)}
								</span>
							</div>
							<div className="flex justify-between font-semibold border-t pt-1 text-success">
								<span>Kullanılmayan Tasarruf:</span>
								<span>{formatMoneyToTry(monthClose.discretionary.unused)}</span>
							</div>
						</div>
					</div>
				</div>
			</div>

			{/* Karar ve Dağıtım */}
			<div className="card p-6 mb-6">
				<h3 className="font-semibold text-lg mb-3">
					Fazlalık Yönlendirme ve Karar
				</h3>
				<dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-3 text-sm">
					<div>
						<dt className="text-secondary">Sistem Yönlendirmesi (Route)</dt>
						<dd className="font-semibold">
							{formatRouteLabel(monthClose.route)}
						</dd>
					</div>
					<div>
						<dt className="text-secondary">Uygulanan Karar (Decision)</dt>
						<dd className="font-semibold">
							{formatDecisionLabel(monthClose.decision)}
						</dd>
					</div>
					<div>
						<dt className="text-secondary">Aktarılan Tutar</dt>
						<dd className="font-bold text-success">
							{formatMoneyToTry(monthClose.appliedAmount)}
						</dd>
					</div>
					<div>
						<dt className="text-secondary">Dağıtılmadan Kalan Tutar</dt>
						<dd className="font-medium text-secondary">
							{formatMoneyToTry(monthClose.unroutedAmount)}
						</dd>
					</div>
				</dl>
			</div>
		</div>
	);
}
