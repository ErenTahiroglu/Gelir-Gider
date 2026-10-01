import { useQuery } from "@tanstack/react-query";
import { Info, RefreshCw } from "lucide-react";
import { useState } from "react";
import { fetchMonthlyReferenceIncome } from "../../api/income-api";
import type {
	IncomeReferenceMethod,
	IncomeSourceNature,
} from "../../api/income-types";
import { getIstanbulCalendarDate } from "../../lib/istanbul-date";
import { formatMoneyToTry } from "../../lib/money";
import {
	formatNatureLabel,
	formatReferenceMethodLabel,
} from "./IncomeSourcesPanel";

export function ReferenceIncomePanel() {
	const todayIstanbul = getIstanbulCalendarDate().dateString;
	const [asOf, setAsOf] = useState(todayIstanbul);

	const { data, isLoading, isError, refetch } = useQuery({
		queryKey: ["income-reference", asOf],
		queryFn: () => fetchMonthlyReferenceIncome(asOf),
		staleTime: 30_000,
	});

	return (
		<div
			className="reference-income-panel"
			data-testid="reference-income-panel"
		>
			<div className="flex flex-wrap justify-between items-center gap-3 mb-4">
				<div>
					<h2 className="text-xl font-semibold">Referans Gelir</h2>
					<p className="text-sm text-secondary">
						Bütçe tavanları ve harcama sınırlarını belirleyen aylık baz gelir.
					</p>
				</div>
				<div className="flex items-center gap-2">
					<label htmlFor="ref-income-as-of" className="text-xs text-secondary">
						Tarih İtibarıyla:
					</label>
					<input
						id="ref-income-as-of"
						type="date"
						className="form-control form-control-sm text-sm"
						value={asOf}
						onChange={(e) => setAsOf(e.target.value)}
					/>
				</div>
			</div>

			<div className="alert alert-info flex items-start gap-2 mb-4" role="note">
				<Info size={18} className="flex-shrink-0 mt-0.5" aria-hidden="true" />
				<div className="text-sm">
					<strong>Referans Gelir ≠ Gerçekleşen Gelir:</strong> Referans gelir,
					bütçe planınızın zorunlu ve esnek harcama tavanlarını belirlemek üzere
					kullanılan teorik aylık bazdır. Bu ay hesabınıza fiilen yatan nakit
					(gerçekleşen gelir) ile aynı şey değildir; düzenli kaynaklarınızın
					belirlediğiniz yöntemlere göre aylığa indirgenmiş toplamıdır.
				</div>
			</div>

			{isLoading ? (
				<div className="card p-8 text-center text-secondary">
					Referans gelir verileri hesaplanıyor...
				</div>
			) : isError || !data ? (
				<div className="card p-8 text-center text-danger">
					<p>Referans gelir alınırken bir hata oluştu.</p>
					<button
						type="button"
						className="btn btn-secondary mt-2 inline-flex items-center gap-1"
						onClick={() => void refetch()}
					>
						<RefreshCw size={14} aria-hidden="true" />
						<span>Tekrar Dene</span>
					</button>
				</div>
			) : (
				<>
					{/* Server total display -- AUTHORITATIVE figure */}
					<div className="card p-6 mb-4 text-center sm:text-left bg-primary/5 border border-primary/20">
						<span className="text-xs font-semibold uppercase tracking-wider text-secondary block mb-1">
							Aylık Toplam Referans Gelir ({data.currency})
						</span>
						<span
							className="text-4xl font-extrabold text-primary block"
							data-testid="reference-income-total"
						>
							{formatMoneyToTry(data.total)}
						</span>
						<span className="text-xs text-secondary mt-1 block">
							Hesaplama Tarihi: {data.asOf}
						</span>
					</div>

					{/* Breakdown table */}
					<div className="card p-6">
						<h3 className="font-semibold text-lg mb-3">Kaynak Dağılımı</h3>
						<p className="text-xs text-secondary mb-4">
							Aşağıdaki tutarlar sunucu tarafından hesaplanan açıklayıcı
							katkılardır. Toplam tutar sunucu otoritesidir.
						</p>

						{data.sources.length === 0 ? (
							<p className="text-sm text-secondary">
								Bu tarih itibarıyla referans gelire katkı veren aktif kaynak
								bulunamadı.
							</p>
						) : (
							<div className="table-responsive">
								<table className="table" data-testid="reference-sources-table">
									<thead>
										<tr>
											<th>Kaynak</th>
											<th>Tür</th>
											<th>Referans Yöntemi</th>
											<th className="text-right">Aylık Katkı</th>
										</tr>
									</thead>
									<tbody>
										{data.sources.map((s) => (
											<tr key={s.sourceId}>
												<td>
													<span className="font-medium block">{s.name}</span>
													<span className="font-mono text-xs text-secondary">
														{s.code}
													</span>
												</td>
												<td>
													<span className="badge badge-secondary">
														{formatNatureLabel(s.nature as IncomeSourceNature)}
													</span>
												</td>
												<td className="text-sm">
													{formatReferenceMethodLabel(
														s.referenceMethod as IncomeReferenceMethod,
													)}
												</td>
												<td className="text-right font-semibold">
													{formatMoneyToTry(s.referenceAmount)}
												</td>
											</tr>
										))}
									</tbody>
								</table>
							</div>
						)}
					</div>
				</>
			)}
		</div>
	);
}
