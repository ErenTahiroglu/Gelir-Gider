import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { ArrowLeft, Edit, Layers, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { ApiError } from "../../api/errors";
import {
	fetchIncomeReceipt,
	fetchIncomeReceiptSettlement,
	reviseIncomeReceipt,
	voidIncomeReceipt,
} from "../../api/income-api";
import type {
	ReviseIncomeReceiptPayload,
	VoidIncomeReceiptPayload,
} from "../../api/income-types";
import { fetchAllLedgerAccounts } from "../../api/manual-expenses-api";
import {
	formatIstanbulDateTimeLocal,
	formatIstanbulDateTimeTurkish,
	formatPeriodMonthTurkish,
	fromEntitlementPeriodMonth,
	parseIstanbulDateTimeLocalToIso,
} from "../../lib/istanbul-date";
import { formatMoneyToTry } from "../../lib/money";
import { AccessibleModal } from "../common/AccessibleModal";
import { MoneyInput } from "../common/MoneyInput";
import { IncomeSettlementEditor } from "./IncomeSettlementEditor";

interface IncomeReceiptDetailProps {
	incomeReceiptId: string;
}

export function IncomeReceiptDetail({
	incomeReceiptId,
}: IncomeReceiptDetailProps) {
	const navigate = useNavigate();
	const queryClient = useQueryClient();

	const [isEditModalOpen, setIsEditModalOpen] = useState(false);
	const [isVoidModalOpen, setIsVoidModalOpen] = useState(false);
	const [isSettling, setIsSettling] = useState(false);

	// Edit form state
	const [editAmount, setEditAmount] = useState("");
	const [editReceivedAtLocal, setEditReceivedAtLocal] = useState("");
	const [editDestinationAccountId, setEditDestinationAccountId] = useState("");
	const [editNote, setEditNote] = useState("");
	const [editReasonNote, setEditReasonNote] = useState("");
	const [editError, setEditError] = useState<string | null>(null);

	// Void form state
	const [voidReasonNote, setVoidReasonNote] = useState("");
	const [voidError, setVoidError] = useState<string | null>(null);

	// Fetch receipt
	const {
		data: receipt,
		isLoading: receiptLoading,
		isError: receiptError,
		refetch: refetchReceipt,
	} = useQuery({
		queryKey: ["income-receipt", incomeReceiptId],
		queryFn: () => fetchIncomeReceipt(incomeReceiptId),
		staleTime: 10_000,
	});

	// Fetch settlement
	const {
		data: settlement,
		isLoading: settlementLoading,
		refetch: refetchSettlement,
	} = useQuery({
		queryKey: ["income-settlement", incomeReceiptId],
		queryFn: () => fetchIncomeReceiptSettlement(incomeReceiptId),
		staleTime: 10_000,
	});

	// Fetch accounts for name display
	const { data: accounts } = useQuery({
		queryKey: ["ledger-accounts"],
		queryFn: () => fetchAllLedgerAccounts(100),
		staleTime: 60_000,
	});

	const destinationAccount = useMemo(() => {
		if (!receipt || !accounts) return null;
		return (
			accounts.find((a) => a.accountId === receipt.destinationAccountId) ?? null
		);
	}, [receipt, accounts]);

	const eligibleAssetAccounts = useMemo(() => {
		return (accounts ?? []).filter(
			(acc) =>
				acc.accountType === "ASSET" &&
				acc.normalBalance === "DEBIT" &&
				acc.currency === "TRY" &&
				!acc.archived,
		);
	}, [accounts]);

	const openEdit = () => {
		if (!receipt) return;
		setEditAmount(receipt.amount);
		setEditReceivedAtLocal(
			formatIstanbulDateTimeLocal(new Date(receipt.receivedAt)),
		);
		setEditDestinationAccountId(receipt.destinationAccountId);
		setEditNote(receipt.note ?? "");
		setEditReasonNote("");
		setEditError(null);
		setIsEditModalOpen(true);
	};

	const openVoid = () => {
		setVoidReasonNote("");
		setVoidError(null);
		setIsVoidModalOpen(true);
	};

	const handleEditSubmit = async (e: React.FormEvent) => {
		e.preventDefault();
		if (!receipt) return;
		setEditError(null);

		if (!editAmount || Number.parseFloat(editAmount) <= 0) {
			setEditError("Geçerli ve pozitif bir tutar girin.");
			return;
		}

		if (!editDestinationAccountId) {
			setEditError("Yatan kasa/banka hesabını seçin.");
			return;
		}

		let canonicalIso: string;
		try {
			canonicalIso = parseIstanbulDateTimeLocalToIso(editReceivedAtLocal);
		} catch {
			setEditError("Geçerli bir tarih ve saat girin.");
			return;
		}

		const payload: ReviseIncomeReceiptPayload = {
			expectedRevisionNo: receipt.revisionNo,
			amount: editAmount,
			receivedAt: canonicalIso,
			destinationAccountId: editDestinationAccountId,
			note: editNote.trim() ? editNote.trim() : null,
			reasonNote: editReasonNote.trim() ? editReasonNote.trim() : null,
		};

		try {
			await reviseIncomeReceipt(
				receipt.incomeReceiptId,
				payload,
				crypto.randomUUID(),
			);
			await queryClient.invalidateQueries({ queryKey: ["income-receipts"] });
			await queryClient.invalidateQueries({
				queryKey: ["income-receipt", incomeReceiptId],
			});
			await queryClient.invalidateQueries({ queryKey: ["transactions"] });
			await queryClient.invalidateQueries({ queryKey: ["ledger-accounts"] });
			await queryClient.invalidateQueries({ queryKey: ["income-reference"] });
			setIsEditModalOpen(false);
		} catch (err) {
			if (err instanceof ApiError) {
				if (err.code === "INCOME_RECEIPT_REVISION_CONFLICT") {
					await refetchReceipt();
				}
				setEditError(err.userMessage);
			} else {
				setEditError("Tahsilat kaydı güncellenirken bir hata oluştu.");
			}
		}
	};

	const handleVoidSubmit = async (e: React.FormEvent) => {
		e.preventDefault();
		if (!receipt) return;
		setVoidError(null);

		const payload: VoidIncomeReceiptPayload = {
			expectedRevisionNo: receipt.revisionNo,
			reasonNote: voidReasonNote.trim() ? voidReasonNote.trim() : null,
		};

		try {
			await voidIncomeReceipt(
				receipt.incomeReceiptId,
				payload,
				crypto.randomUUID(),
			);
			await queryClient.invalidateQueries({ queryKey: ["income-receipts"] });
			await queryClient.invalidateQueries({
				queryKey: ["income-receipt", incomeReceiptId],
			});
			await queryClient.invalidateQueries({ queryKey: ["transactions"] });
			await queryClient.invalidateQueries({ queryKey: ["ledger-accounts"] });
			await queryClient.invalidateQueries({ queryKey: ["income-reference"] });
			setIsVoidModalOpen(false);
		} catch (err) {
			if (err instanceof ApiError) {
				if (err.code === "INCOME_RECEIPT_REVISION_CONFLICT") {
					await refetchReceipt();
				}
				setVoidError(err.userMessage);
			} else {
				setVoidError("Tahsilat kaydı iptal edilirken bir hata oluştu.");
			}
		}
	};

	if (receiptLoading) {
		return (
			<div className="detail-page-container">
				<div className="card p-8 text-center text-secondary">
					Tahsilat detayları yükleniyor...
				</div>
			</div>
		);
	}

	if (receiptError || !receipt) {
		return (
			<div className="detail-page-container">
				<div className="card p-8 text-center text-danger">
					<p className="mb-3">
						Tahsilat kaydı bulunamadı veya bir hata oluştu.
					</p>
					<button
						type="button"
						className="btn btn-secondary inline-flex items-center gap-1"
						onClick={() => void navigate({ to: "/income" })}
					>
						<ArrowLeft size={16} aria-hidden="true" />
						<span>Gelirler Sayfasına Dön</span>
					</button>
				</div>
			</div>
		);
	}

	const isVoided = receipt.status === "VOIDED";

	return (
		<div className="detail-page-container" data-testid="receipt-detail-page">
			<div className="flex items-center justify-between gap-3 mb-4">
				<div className="flex items-center gap-3">
					<button
						type="button"
						className="btn btn-icon btn-secondary"
						onClick={() => void navigate({ to: "/income" })}
						aria-label="Geri Dön"
					>
						<ArrowLeft size={18} aria-hidden="true" />
					</button>
					<div>
						<h1 className="page-title mb-0">{receipt.sourceName} Tahsilatı</h1>
						<span className="text-xs text-secondary font-mono">
							Revizyon #{receipt.revisionNo}
						</span>
					</div>
				</div>

				{!isVoided && (
					<div className="flex items-center gap-2">
						<button
							type="button"
							className="btn btn-secondary flex items-center gap-1"
							onClick={openEdit}
							data-testid="btn-edit-receipt"
						>
							<Edit size={16} aria-hidden="true" />
							<span>Düzenle</span>
						</button>
						<button
							type="button"
							className="btn btn-outline-danger flex items-center gap-1"
							onClick={openVoid}
							data-testid="btn-void-receipt"
						>
							<Trash2 size={16} aria-hidden="true" />
							<span>İptal Et</span>
						</button>
					</div>
				)}
			</div>

			{isVoided && (
				<div className="alert alert-secondary mb-4" role="status">
					Bu tahsilat kaydı iptal edilmiştir (muhasebe etkisi tersine
					çevrilmiştir).
				</div>
			)}

			<div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">
				<div className="card p-4">
					<span className="text-xs text-secondary block mb-1">
						Tahsil Edilen Tutar
					</span>
					<span
						className="text-2xl font-bold text-success block"
						data-testid="receipt-amount"
					>
						{formatMoneyToTry(receipt.amount)}
					</span>
					<span className="text-xs text-secondary mt-1 block">
						Kasa/Banka:{" "}
						{destinationAccount?.name ?? receipt.destinationAccountId}
					</span>
				</div>

				<div className="card p-4">
					<span className="text-xs text-secondary block mb-1">
						Tahsilat Zamanı
					</span>
					<span className="text-lg font-semibold block">
						{formatIstanbulDateTimeTurkish(receipt.receivedAt)}
					</span>
					<span className="text-xs text-secondary mt-1 block">
						Kaynak: {receipt.sourceName} ({receipt.sourceCode})
					</span>
				</div>

				<div className="card p-4">
					<span className="text-xs text-secondary block mb-1">
						Eşleştirme Durumu
					</span>
					{settlement && settlement.allocations.length > 0 ? (
						<>
							<span className="text-lg font-bold text-primary block">
								{formatMoneyToTry(settlement.allocatedAmount)} Eşleşti
							</span>
							<span className="text-xs text-secondary mt-1 block">
								Kalan eşleşmemiş:{" "}
								{formatMoneyToTry(settlement.unallocatedAmount)}
							</span>
						</>
					) : (
						<>
							<span className="text-lg font-medium text-warning block">
								Eşleştirilmedi
							</span>
							<span className="text-xs text-secondary mt-1 block">
								Henüz beklenen gelirle ilişkilendirilmedi
							</span>
						</>
					)}
				</div>
			</div>

			{receipt.note && (
				<div className="card p-4 mb-4 text-sm">
					<span className="text-secondary font-medium block mb-1">
						Açıklama:
					</span>
					<p>{receipt.note}</p>
				</div>
			)}

			{/* Settlement Section */}
			<div className="card p-6 mb-4" data-testid="settlement-section">
				<div className="flex flex-wrap justify-between items-center gap-3 mb-4">
					<div>
						<h2 className="text-lg font-semibold flex items-center gap-2">
							<Layers size={18} aria-hidden="true" />
							<span>Beklenen Gelir Eşleştirmesi</span>
						</h2>
						<p className="text-sm text-secondary">
							Bu tahsilatın hangi aylık beklenen geliri karşıladığını takip
							edin.
						</p>
					</div>

					{!isVoided && !isSettling && (
						<button
							type="button"
							className="btn btn-outline-primary"
							onClick={() => setIsSettling(true)}
							data-testid="btn-open-settlement-editor"
						>
							{settlement && settlement.allocations.length > 0
								? "Eşleştirmeyi Düzenle"
								: "Beklenen Gelir Eşleştir"}
						</button>
					)}
				</div>

				{isSettling ? (
					<IncomeSettlementEditor
						incomeReceiptId={receipt.incomeReceiptId}
						sourceId={receipt.sourceId}
						receiptAmount={receipt.amount}
						existingSettlement={settlement}
						onSuccess={() => {
							setIsSettling(false);
							void refetchSettlement();
						}}
						onCancel={() => setIsSettling(false)}
					/>
				) : settlement && settlement.allocations.length > 0 ? (
					<div className="table-responsive">
						<table className="table" data-testid="settlement-allocations-table">
							<thead>
								<tr>
									<th>Beklenen Gelir Dönemi</th>
									<th>Beklenen Tutar</th>
									<th>Bu Tahsilattan Karşılanan</th>
									<th>Beklenenin Kalan Açığı</th>
								</tr>
							</thead>
							<tbody>
								{settlement.allocations.map((alloc) => {
									const periodUi = fromEntitlementPeriodMonth(
										alloc.periodMonth,
									);
									return (
										<tr key={alloc.entitlementId}>
											<td className="font-medium">
												<Link
													to="/income/entitlements/$entitlementId"
													params={{ entitlementId: alloc.entitlementId }}
													className="text-primary hover:underline"
												>
													{formatPeriodMonthTurkish(periodUi)}
												</Link>
											</td>
											<td>{formatMoneyToTry(alloc.entitlementAmount)}</td>
											<td className="font-semibold text-success">
												{formatMoneyToTry(alloc.allocatedAmount)}
											</td>
											<td className="text-secondary">
												{formatMoneyToTry(
													alloc.entitlementOutstandingAfterAllReceipts,
												)}
											</td>
										</tr>
									);
								})}
							</tbody>
						</table>
					</div>
				) : (
					<div className="p-4 bg-secondary/10 rounded text-center text-sm text-secondary">
						Henüz beklenen gelir eşleştirmesi yapılmadı.
					</div>
				)}
			</div>

			{/* Edit Modal */}
			<AccessibleModal
				isOpen={isEditModalOpen}
				onClose={() => setIsEditModalOpen(false)}
				title="Tahsilatı Düzenle"
				variant="center-dialog"
			>
				<form onSubmit={handleEditSubmit}>
					{editError && (
						<div className="alert alert-danger mb-4" role="alert">
							{editError}
						</div>
					)}

					<div className="form-group mb-3">
						<label htmlFor="edit-receipt-amount" className="form-label">
							Yeni Tutar
						</label>
						<MoneyInput
							id="edit-receipt-amount"
							value={editAmount}
							onChange={setEditAmount}
							required
						/>
					</div>

					<div className="form-group mb-3">
						<label htmlFor="edit-receipt-account" className="form-label">
							Yatan Kasa / Banka Hesabı
						</label>
						<select
							id="edit-receipt-account"
							className="form-control"
							value={editDestinationAccountId}
							onChange={(e) => setEditDestinationAccountId(e.target.value)}
							required
						>
							<option value="">Hesap Seçin...</option>
							{eligibleAssetAccounts.map((acc) => (
								<option key={acc.accountId} value={acc.accountId}>
									{acc.name} ({acc.code})
								</option>
							))}
						</select>
					</div>

					<div className="form-group mb-3">
						<label htmlFor="edit-receipt-datetime" className="form-label">
							Tahsilat Zamanı (Türkiye Saati)
						</label>
						<input
							id="edit-receipt-datetime"
							type="datetime-local"
							className="form-control"
							value={editReceivedAtLocal}
							onChange={(e) => setEditReceivedAtLocal(e.target.value)}
							required
						/>
					</div>

					<div className="form-group mb-3">
						<label htmlFor="edit-receipt-note" className="form-label">
							Açıklama / Not
						</label>
						<input
							id="edit-receipt-note"
							type="text"
							className="form-control"
							value={editNote}
							onChange={(e) => setEditNote(e.target.value)}
							maxLength={255}
						/>
					</div>

					<div className="form-group mb-4">
						<label htmlFor="edit-receipt-reason" className="form-label">
							Değişiklik Gerekçesi (İsteğe Bağlı)
						</label>
						<input
							id="edit-receipt-reason"
							type="text"
							className="form-control"
							value={editReasonNote}
							onChange={(e) => setEditReasonNote(e.target.value)}
							placeholder="Örn: Yanlış hesap seçilmişti"
							maxLength={255}
						/>
					</div>

					<div className="modal-actions flex justify-end gap-2">
						<button
							type="button"
							className="btn btn-secondary"
							onClick={() => setIsEditModalOpen(false)}
						>
							Vazgeç
						</button>
						<button
							type="submit"
							className="btn btn-primary"
							data-testid="btn-save-receipt-revision"
						>
							Değişiklikleri Kaydet
						</button>
					</div>
				</form>
			</AccessibleModal>

			{/* Void Modal */}
			<AccessibleModal
				isOpen={isVoidModalOpen}
				onClose={() => setIsVoidModalOpen(false)}
				title="Tahsilatı İptal Et"
				variant="center-dialog"
			>
				<form onSubmit={handleVoidSubmit}>
					<p className="text-secondary text-sm mb-4">
						Bu tahsilat kaydını iptal etmek istediğinize emin misiniz? İptal
						edildiğinde ilgili kasa/banka hesabına giren tutar muhasebede
						tersine çevrilecektir. Eşleştirilmiş beklenen gelir kaydı varsa önce
						eşleştirmeyi temizlemeniz gerekir.
					</p>

					{voidError && (
						<div className="alert alert-danger mb-4" role="alert">
							{voidError}
						</div>
					)}

					<div className="form-group mb-4">
						<label htmlFor="void-receipt-reason" className="form-label">
							İptal Gerekçesi (İsteğe Bağlı)
						</label>
						<input
							id="void-receipt-reason"
							type="text"
							className="form-control"
							value={voidReasonNote}
							onChange={(e) => setVoidReasonNote(e.target.value)}
							placeholder="Örn: Hatalı mükerrer kayıt"
							maxLength={255}
						/>
					</div>

					<div className="modal-actions flex justify-end gap-2">
						<button
							type="button"
							className="btn btn-secondary"
							onClick={() => setIsVoidModalOpen(false)}
						>
							Vazgeç
						</button>
						<button type="submit" className="btn btn-danger">
							Tahsilatı İptal Et
						</button>
					</div>
				</form>
			</AccessibleModal>
		</div>
	);
}
