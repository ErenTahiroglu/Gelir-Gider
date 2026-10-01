import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Plus, RefreshCw } from "lucide-react";
import { useMemo, useState } from "react";
import { fetchIncomeReceipts } from "../../api/income-api";
import type { IncomeReceiptItem } from "../../api/income-types";
import { fetchAllLedgerAccounts } from "../../api/manual-expenses-api";
import { formatIstanbulDateTimeTurkish } from "../../lib/istanbul-date";
import { formatMoneyToTry } from "../../lib/money";

export function IncomeReceiptsPanel() {
	const [includeVoided, setIncludeVoided] = useState(false);

	const {
		data,
		isLoading,
		isError,
		fetchNextPage,
		hasNextPage,
		isFetchingNextPage,
		refetch,
	} = useInfiniteQuery({
		queryKey: ["income-receipts", { includeVoided }],
		queryFn: ({ pageParam }) =>
			fetchIncomeReceipts({
				limit: 20,
				includeVoided,
				...(pageParam
					? {
							beforeReceivedAt: pageParam.beforeReceivedAt,
							beforeIncomeReceiptId: pageParam.beforeIncomeReceiptId,
						}
					: {}),
			}),
		initialPageParam: undefined as
			| { beforeReceivedAt: string; beforeIncomeReceiptId: string }
			| undefined,
		getNextPageParam: (lastPage) => {
			if (lastPage.hasMore && lastPage.nextCursor) {
				return lastPage.nextCursor;
			}
			return undefined;
		},
	});

	const { data: accounts } = useQuery({
		queryKey: ["ledger-accounts"],
		queryFn: () => fetchAllLedgerAccounts(100),
		staleTime: 60_000,
	});

	const accountsMap = useMemo(() => {
		const map = new Map<string, string>();
		for (const a of accounts ?? []) {
			map.set(a.accountId, a.name);
		}
		return map;
	}, [accounts]);

	const allReceipts: IncomeReceiptItem[] =
		data?.pages.flatMap((p) => p.receipts) ?? [];

	return (
		<div className="income-receipts-panel" data-testid="income-receipts-panel">
			<div className="flex flex-wrap justify-between items-center gap-3 mb-4">
				<div>
					<h2 className="text-xl font-semibold">
						Gerçekleşen Gelirler (Tahsilatlar)
					</h2>
					<p className="text-sm text-secondary">
						Kasa veya banka hesaplarınıza fiilen giren nakit gelirler.
					</p>
				</div>
				<div className="flex items-center gap-3">
					<label className="flex items-center gap-2 text-sm cursor-pointer">
						<input
							type="checkbox"
							checked={includeVoided}
							onChange={(e) => setIncludeVoided(e.target.checked)}
							data-testid="toggle-voided-receipts"
						/>
						<span>İptalleri Göster</span>
					</label>
					<Link
						to="/income/receipts/new"
						className="btn btn-primary flex items-center gap-1"
						data-testid="btn-new-receipt"
					>
						<Plus size={16} aria-hidden="true" />
						<span>Gelir Girişi Yap</span>
					</Link>
				</div>
			</div>

			{isLoading ? (
				<div className="card p-6 text-center text-secondary">
					Tahsilatlar yükleniyor...
				</div>
			) : isError ? (
				<div className="card p-6 text-center text-danger">
					<p>Tahsilatlar alınırken bir hata oluştu.</p>
					<button
						type="button"
						className="btn btn-secondary mt-2 inline-flex items-center gap-1"
						onClick={() => void refetch()}
					>
						<RefreshCw size={14} aria-hidden="true" />
						<span>Tekrar Dene</span>
					</button>
				</div>
			) : allReceipts.length === 0 ? (
				<div className="card p-8 text-center text-secondary">
					<p className="mb-3">Kayıtlı gelir tahsilatı bulunamadı.</p>
					<Link to="/income/receipts/new" className="btn btn-outline-primary">
						İlk Gelir Tahsilatınızı Girin
					</Link>
				</div>
			) : (
				<>
					{/* Desktop table */}
					<div className="desktop-only table-responsive card mb-4">
						<table className="table" data-testid="receipts-desktop-table">
							<thead>
								<tr>
									<th>Tarih & Saat</th>
									<th>Kaynak</th>
									<th>Tutar</th>
									<th>Yatan Hesap</th>
									<th>Açıklama</th>
									<th>Durum</th>
									<th className="text-right">Detay</th>
								</tr>
							</thead>
							<tbody>
								{allReceipts.map((item) => {
									const isVoided = item.status === "VOIDED";
									const accountName =
										accountsMap.get(item.destinationAccountId) ??
										item.destinationAccountId;
									return (
										<tr
											key={item.incomeReceiptId}
											className={isVoided ? "opacity-60" : ""}
											data-testid={`receipt-row-${item.incomeReceiptId}`}
										>
											<td className="text-sm font-medium">
												{formatIstanbulDateTimeTurkish(item.receivedAt)}
											</td>
											<td>
												<span className="font-semibold block">
													{item.sourceName}
												</span>
												<span className="font-mono text-xs text-secondary">
													{item.sourceCode}
												</span>
											</td>
											<td className="font-bold text-success">
												{formatMoneyToTry(item.amount)}
											</td>
											<td className="text-sm">{accountName}</td>
											<td className="text-sm text-secondary truncate max-w-[200px]">
												{item.note ?? "—"}
											</td>
											<td>
												<span
													className={`badge ${isVoided ? "badge-secondary" : "badge-success"}`}
												>
													{isVoided ? "İptal Edildi" : "Tamamlandı"}
												</span>
											</td>
											<td className="text-right">
												<Link
													to="/income/receipts/$incomeReceiptId"
													params={{ incomeReceiptId: item.incomeReceiptId }}
													className="btn btn-sm btn-ghost"
												>
													İncele
												</Link>
											</td>
										</tr>
									);
								})}
							</tbody>
						</table>
					</div>

					{/* Mobile cards */}
					<div className="mobile-only flex flex-col gap-3 mb-4">
						{allReceipts.map((item) => {
							const isVoided = item.status === "VOIDED";
							const accountName =
								accountsMap.get(item.destinationAccountId) ??
								item.destinationAccountId;
							return (
								<Link
									key={item.incomeReceiptId}
									to="/income/receipts/$incomeReceiptId"
									params={{ incomeReceiptId: item.incomeReceiptId }}
									className={`card p-4 block hover:border-primary transition-colors ${isVoided ? "opacity-60" : ""}`}
									data-testid={`receipt-card-${item.incomeReceiptId}`}
								>
									<div className="flex justify-between items-start gap-2 mb-2">
										<div>
											<span className="font-bold text-base block text-success">
												{formatMoneyToTry(item.amount)}
											</span>
											<span className="text-xs text-secondary">
												{item.sourceName}
											</span>
										</div>
										<span
											className={`badge ${isVoided ? "badge-secondary" : "badge-success"}`}
										>
											{isVoided ? "İptal" : "Tamamlandı"}
										</span>
									</div>

									<div className="text-xs text-secondary my-1">
										<span>
											{formatIstanbulDateTimeTurkish(item.receivedAt)}
										</span>
										<span className="mx-1">•</span>
										<span>{accountName}</span>
									</div>

									{item.note && (
										<p className="text-sm text-secondary truncate mt-1">
											{item.note}
										</p>
									)}
								</Link>
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
