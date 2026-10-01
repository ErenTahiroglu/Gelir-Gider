import {
	useInfiniteQuery,
	useMutation,
	useQueryClient,
} from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Archive, Plus, RefreshCw } from "lucide-react";
import { useState } from "react";
import { ApiError } from "../../api/errors";
import { archiveIncomeSource, fetchIncomeSources } from "../../api/income-api";
import type {
	IncomeReferenceMethod,
	IncomeSourceNature,
	ProductIncomeSourceItem,
} from "../../api/income-types";
import { formatMoneyToTry } from "../../lib/money";

export function formatNatureLabel(nature: IncomeSourceNature): string {
	switch (nature) {
		case "REGULAR":
			return "Düzenli Gelir";
		case "EXTRA":
			return "Ek Gelir";
		case "SUPPORT":
			return "Destek";
		default:
			return nature;
	}
}

export function formatReferenceMethodLabel(
	method: IncomeReferenceMethod,
): string {
	switch (method) {
		case "FIXED_MONTHLY":
			return "Sabit Aylık";
		case "SEASONAL_ANNUALIZED":
			return "Dönemsel / Yıllığa Yayılmış";
		case "ROLLING_MEDIAN":
			return "Son Ayların Medyanı";
		case "EXCLUDED":
			return "Referans Gelire Dahil Değil";
		default:
			return method;
	}
}

export function IncomeSourcesPanel() {
	const queryClient = useQueryClient();
	const [includeArchived, setIncludeArchived] = useState(false);
	const [actionError, setActionError] = useState<string | null>(null);

	const {
		data,
		isLoading,
		isError,
		fetchNextPage,
		hasNextPage,
		isFetchingNextPage,
		refetch,
	} = useInfiniteQuery({
		queryKey: ["income-sources", { includeArchived }],
		queryFn: ({ pageParam }) =>
			fetchIncomeSources({
				limit: 20,
				includeArchived,
				...(pageParam
					? {
							beforeCreatedAt: pageParam.beforeCreatedAt,
							beforeSourceId: pageParam.beforeSourceId,
						}
					: {}),
			}),
		initialPageParam: undefined as
			| { beforeCreatedAt: string; beforeSourceId: string }
			| undefined,
		getNextPageParam: (lastPage) => {
			if (lastPage.hasMore && lastPage.nextCursor) {
				return lastPage.nextCursor;
			}
			return undefined;
		},
	});

	const archiveMutation = useMutation({
		mutationFn: (sourceId: string) => archiveIncomeSource(sourceId),
		onSuccess: async () => {
			await queryClient.invalidateQueries({ queryKey: ["income-sources"] });
			await queryClient.invalidateQueries({ queryKey: ["income-reference"] });
		},
		onError: (err) => {
			if (err instanceof ApiError) {
				setActionError(err.userMessage);
			} else {
				setActionError("Kaynak arşivlenirken hata oluştu.");
			}
		},
	});

	const allSources: ProductIncomeSourceItem[] =
		data?.pages.flatMap((p) => p.sources) ?? [];

	const handleArchive = (source: ProductIncomeSourceItem) => {
		if (
			window.confirm(
				`"${source.name}" gelir kaynağını arşivlemek istediğinize emin misiniz? Arşivlenen kaynaklar için yeni beklenen gelir oluşturulamaz.`,
			)
		) {
			setActionError(null);
			archiveMutation.mutate(source.sourceId);
		}
	};

	return (
		<div className="income-sources-panel" data-testid="income-sources-panel">
			<div className="flex flex-wrap justify-between items-center gap-3 mb-4">
				<div>
					<h2 className="text-xl font-semibold">Gelir Kaynakları</h2>
					<p className="text-sm text-secondary">
						Maaş, burs, aile desteği veya ek gelirlerinizi tanımlayın.
					</p>
				</div>
				<div className="flex items-center gap-3">
					<label className="flex items-center gap-2 text-sm cursor-pointer">
						<input
							type="checkbox"
							checked={includeArchived}
							onChange={(e) => setIncludeArchived(e.target.checked)}
							data-testid="toggle-archived-sources"
						/>
						<span>Arşivlenenleri Göster</span>
					</label>
					<Link
						to="/income/sources/new"
						className="btn btn-primary flex items-center gap-1"
						data-testid="btn-new-income-source"
					>
						<Plus size={16} aria-hidden="true" />
						<span>Yeni Kaynak Ekle</span>
					</Link>
				</div>
			</div>

			{actionError && (
				<div className="alert alert-danger mb-4" role="alert">
					{actionError}
				</div>
			)}

			{isLoading ? (
				<div className="card p-6 text-center text-secondary">
					Gelir kaynakları yükleniyor...
				</div>
			) : isError ? (
				<div className="card p-6 text-center text-danger">
					<p>Kaynaklar yüklenirken bir hata oluştu.</p>
					<button
						type="button"
						className="btn btn-secondary mt-2 inline-flex items-center gap-1"
						onClick={() => void refetch()}
					>
						<RefreshCw size={14} aria-hidden="true" />
						<span>Tekrar Dene</span>
					</button>
				</div>
			) : allSources.length === 0 ? (
				<div className="card p-8 text-center text-secondary">
					<p className="mb-3">Tanımlı gelir kaynağı bulunamadı.</p>
					<Link to="/income/sources/new" className="btn btn-outline-primary">
						İlk Gelir Kaynağınızı Ekleyin
					</Link>
				</div>
			) : (
				<>
					{/* Desktop table */}
					<div className="desktop-only table-responsive card mb-4">
						<table className="table" data-testid="sources-desktop-table">
							<thead>
								<tr>
									<th>Kod</th>
									<th>Kaynak Adı</th>
									<th>Tür</th>
									<th>Referans Yöntemi</th>
									<th>Beklenen Tutar</th>
									<th>Aktif Dönem</th>
									<th>Durum</th>
									<th className="text-right">İşlem</th>
								</tr>
							</thead>
							<tbody>
								{allSources.map((source) => {
									const isArchived = source.archivedAt !== null;
									return (
										<tr
											key={source.sourceId}
											className={isArchived ? "opacity-60" : ""}
											data-testid={`source-row-${source.sourceId}`}
										>
											<td className="font-mono text-sm">{source.code}</td>
											<td className="font-medium">{source.name}</td>
											<td>
												<span className="badge badge-secondary">
													{formatNatureLabel(source.nature)}
												</span>
											</td>
											<td className="text-sm">
												{formatReferenceMethodLabel(source.referenceMethod)}
												{source.referenceMethod === "SEASONAL_ANNUALIZED" &&
													source.seasonalMonthsPerYear && (
														<span className="text-xs text-secondary block">
															({source.seasonalMonthsPerYear} ay / yıl)
														</span>
													)}
												{source.referenceMethod === "ROLLING_MEDIAN" &&
													source.rollingMedianMonths && (
														<span className="text-xs text-secondary block">
															({source.rollingMedianMonths} aylık medyan)
														</span>
													)}
											</td>
											<td className="font-medium">
												{source.expectedMonthlyAmount
													? formatMoneyToTry(source.expectedMonthlyAmount)
													: "—"}
											</td>
											<td className="text-xs text-secondary">
												{source.activeFrom}
												{source.activeUntil
													? ` — ${source.activeUntil}`
													: " — Süresiz"}
											</td>
											<td>
												{isArchived ? (
													<span className="badge badge-secondary">
														Arşivlendi
													</span>
												) : (
													<span className="badge badge-success">Aktif</span>
												)}
											</td>
											<td className="text-right">
												{!isArchived && (
													<button
														type="button"
														className="btn btn-sm btn-ghost text-danger"
														onClick={() => handleArchive(source)}
														disabled={archiveMutation.isPending}
														title="Gelir Kaynağını Arşivle"
														data-testid={`btn-archive-source-${source.sourceId}`}
													>
														<Archive size={14} aria-hidden="true" />
														<span className="ml-1">Arşivle</span>
													</button>
												)}
											</td>
										</tr>
									);
								})}
							</tbody>
						</table>
					</div>

					{/* Mobile cards */}
					<div className="mobile-only flex flex-col gap-3 mb-4">
						{allSources.map((source) => {
							const isArchived = source.archivedAt !== null;
							return (
								<div
									key={source.sourceId}
									className={`card p-4 ${isArchived ? "opacity-60" : ""}`}
									data-testid={`source-card-${source.sourceId}`}
								>
									<div className="flex justify-between items-start gap-2 mb-2">
										<div>
											<span className="font-mono text-xs text-secondary block">
												{source.code}
											</span>
											<h3 className="font-semibold text-base">{source.name}</h3>
										</div>
										<span
											className={`badge ${isArchived ? "badge-secondary" : "badge-success"}`}
										>
											{isArchived ? "Arşivlendi" : "Aktif"}
										</span>
									</div>

									<div className="text-sm text-secondary mb-3 flex flex-wrap gap-2">
										<span className="badge badge-secondary">
											{formatNatureLabel(source.nature)}
										</span>
										<span>
											{formatReferenceMethodLabel(source.referenceMethod)}
										</span>
									</div>

									<div className="flex justify-between items-end border-t pt-2 mt-2">
										<div>
											<span className="text-xs text-secondary block">
												Beklenen Tutar
											</span>
											<span className="font-semibold">
												{source.expectedMonthlyAmount
													? formatMoneyToTry(source.expectedMonthlyAmount)
													: "—"}
											</span>
										</div>

										{!isArchived && (
											<button
												type="button"
												className="btn btn-sm btn-outline-danger"
												onClick={() => handleArchive(source)}
												disabled={archiveMutation.isPending}
											>
												<Archive size={14} aria-hidden="true" />
												<span className="ml-1">Arşivle</span>
											</button>
										)}
									</div>
								</div>
							);
						})}
					</div>

					{hasNextPage && (
						<div className="text-center mt-4">
							<button
								type="button"
								className="btn btn-secondary"
								onClick={() => void fetchNextPage()}
								disabled={isFetchingNextPage}
							>
								{isFetchingNextPage ? "Yükleniyor..." : "Daha Fazla Göster"}
							</button>
						</div>
					)}
				</>
			)}
		</div>
	);
}
