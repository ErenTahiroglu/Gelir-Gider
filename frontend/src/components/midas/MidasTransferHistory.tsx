import { useQuery } from "@tanstack/react-query";
import { ArrowDownLeft, ArrowUpRight, History, RefreshCw } from "lucide-react";
import { useMemo, useState } from "react";
import { fetchMidasTransfers } from "../../api/f7-api";
import type {
	MidasAllocationTransferProductDto,
	MidasBucketProductDto,
} from "../../api/f7-types";
import { formatIstanbulDateTimeTurkish } from "../../lib/istanbul-date";
import { formatMoneyToTry } from "../../lib/money";

interface MidasTransferHistoryProps {
	midasAccountId: string;
	buckets: MidasBucketProductDto[];
}

export function MidasTransferHistory({
	midasAccountId,
	buckets,
}: MidasTransferHistoryProps) {
	const [cursor, setCursor] = useState<string | undefined>(undefined);
	const [historyPages, setHistoryPages] = useState<
		MidasAllocationTransferProductDto[][]
	>([]);

	const bucketMap = useMemo(() => {
		const map = new Map<string, string>();
		for (const b of buckets) {
			map.set(b.bucketId, b.name || b.code);
		}
		return map;
	}, [buckets]);

	const { data, isLoading, isFetching } = useQuery({
		queryKey: ["midas-transfers", { midasAccountId, after: cursor }],
		queryFn: async () => {
			const res = await fetchMidasTransfers({
				midasAccountId,
				limit: 50,
				after: cursor,
			});
			return res;
		},
		enabled: Boolean(midasAccountId),
		staleTime: 30_000,
	});

	const resolveBucketName = (bucketId: string | null): string => {
		if (!bucketId) return "Serbest Bakiye";
		return bucketMap.get(bucketId) ?? "Havuz";
	};

	const currentTransfers = data?.transfers ?? [];
	const hasMore = Boolean(data?.hasMore && data?.nextCursor);

	const handleLoadMore = () => {
		if (data?.nextCursor) {
			setHistoryPages((prev) => [...prev, currentTransfers]);
			setCursor(data.nextCursor);
		}
	};

	const allVisibleTransfers = useMemo(() => {
		const combined = historyPages.flat();
		return [...combined, ...currentTransfers];
	}, [historyPages, currentTransfers]);

	return (
		<div
			className="card midas-transfer-history"
			data-testid="midas-transfer-history"
		>
			<div className="card-header">
				<div className="header-icon-badge">
					<History size={20} aria-hidden="true" />
				</div>
				<div>
					<h3 className="card-title">Transfer Geçmişi</h3>
					<p className="card-subtitle">
						Havuzlar arası bakiye dağıtımları ve aktarımlar
					</p>
				</div>
			</div>

			<div className="card-body">
				{isLoading && allVisibleTransfers.length === 0 ? (
					<div className="loading-state">
						<RefreshCw size={18} className="spin" aria-hidden="true" />
						<span>Transfer geçmişi yükleniyor...</span>
					</div>
				) : allVisibleTransfers.length === 0 ? (
					<div className="empty-state text-muted" data-testid="empty-transfers">
						Henüz bir transfer kaydı bulunmuyor.
					</div>
				) : (
					<div className="transfer-list-table-wrapper">
						<table
							className="table transfer-table"
							aria-label="Transfer Geçmişi"
						>
							<thead>
								<tr>
									<th scope="col">Tarih</th>
									<th scope="col">Kaynak</th>
									<th scope="col">Hedef</th>
									<th scope="col">Tutar</th>
									<th scope="col">Açıklama</th>
								</tr>
							</thead>
							<tbody>
								{allVisibleTransfers.map((tx) => {
									const isFromFree = !tx.fromBucketId;
									return (
										<tr
											key={tx.transferId}
											data-testid={`transfer-row-${tx.transferId}`}
										>
											<td className="transfer-date">
												{formatIstanbulDateTimeTurkish(tx.occurredAt)}
											</td>
											<td className="transfer-from">
												<span className="badge badge-subtle">
													{resolveBucketName(tx.fromBucketId)}
												</span>
											</td>
											<td className="transfer-to">
												<span className="badge badge-subtle">
													{resolveBucketName(tx.toBucketId)}
												</span>
											</td>
											<td className="transfer-amount font-mono">
												<span className="transfer-direction-icon">
													{isFromFree ? (
														<ArrowUpRight size={14} className="text-warning" />
													) : (
														<ArrowDownLeft size={14} className="text-success" />
													)}
												</span>
												{formatMoneyToTry(tx.amount)}
											</td>
											<td className="transfer-memo text-muted">
												{tx.memo || "—"}
											</td>
										</tr>
									);
								})}
							</tbody>
						</table>

						{hasMore && (
							<div className="pagination-footer mt-4">
								<button
									type="button"
									className="btn btn-secondary btn-sm"
									onClick={handleLoadMore}
									disabled={isFetching}
									data-testid="load-more-transfers-btn"
								>
									{isFetching ? (
										<>
											<RefreshCw
												size={14}
												className="spin"
												aria-hidden="true"
											/>
											<span>Yükleniyor...</span>
										</>
									) : (
										<span>Daha Fazla Göster</span>
									)}
								</button>
							</div>
						)}
					</div>
				)}
			</div>
		</div>
	);
}
