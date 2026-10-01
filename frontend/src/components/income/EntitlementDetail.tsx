import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { ArrowLeft, Edit, Trash2 } from "lucide-react";
import { useState } from "react";
import { ApiError } from "../../api/errors";
import {
	fetchIncomeEntitlement,
	reviseIncomeEntitlement,
	voidIncomeEntitlement,
} from "../../api/income-api";
import type {
	IncomeEntitlementSettlementStatus,
	ReviseIncomeEntitlementPayload,
	VoidIncomeEntitlementPayload,
} from "../../api/income-types";
import {
	formatPeriodMonthTurkish,
	fromEntitlementPeriodMonth,
} from "../../lib/istanbul-date";
import { formatMoneyToTry } from "../../lib/money";
import { AccessibleModal } from "../common/AccessibleModal";
import { MoneyInput } from "../common/MoneyInput";

interface EntitlementDetailProps {
	entitlementId: string;
}

export function formatSettlementStatusLabel(
	status: IncomeEntitlementSettlementStatus,
): { label: string; badgeClass: string } {
	switch (status) {
		case "OPEN":
			return { label: "Tahsil Edilmedi (Açık)", badgeClass: "badge-warning" };
		case "PARTIAL":
			return { label: "Kısmi Tahsil Edildi", badgeClass: "badge-info" };
		case "SETTLED":
			return { label: "Tamamı Karşılandı", badgeClass: "badge-success" };
		case "VOIDED":
			return { label: "İptal Edildi", badgeClass: "badge-secondary" };
		default:
			return { label: status, badgeClass: "badge-secondary" };
	}
}

export function EntitlementDetail({ entitlementId }: EntitlementDetailProps) {
	const navigate = useNavigate();
	const queryClient = useQueryClient();

	const [isEditModalOpen, setIsEditModalOpen] = useState(false);
	const [isVoidModalOpen, setIsVoidModalOpen] = useState(false);

	// Edit form state
	const [editAmount, setEditAmount] = useState("");
	const [editExpectedReceiptOn, setEditExpectedReceiptOn] = useState("");
	const [editNote, setEditNote] = useState("");
	const [editReasonNote, setEditReasonNote] = useState("");
	const [editError, setEditError] = useState<string | null>(null);

	// Void form state
	const [voidReasonNote, setVoidReasonNote] = useState("");
	const [voidError, setVoidError] = useState<string | null>(null);

	const {
		data: entitlement,
		isLoading,
		isError,
		refetch,
	} = useQuery({
		queryKey: ["income-entitlement", entitlementId],
		queryFn: () => fetchIncomeEntitlement(entitlementId),
		staleTime: 10_000,
	});

	const openEdit = () => {
		if (!entitlement) return;
		setEditAmount(entitlement.amount);
		setEditExpectedReceiptOn(entitlement.expectedReceiptOn ?? "");
		setEditNote(entitlement.note ?? "");
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
		if (!entitlement) return;
		setEditError(null);

		if (!editAmount || Number.parseFloat(editAmount) <= 0) {
			setEditError("Geçerli ve pozitif bir tutar girin.");
			return;
		}

		const payload: ReviseIncomeEntitlementPayload = {
			expectedRevisionNo: entitlement.revisionNo,
			amount: editAmount,
			expectedReceiptOn: editExpectedReceiptOn ? editExpectedReceiptOn : null,
			note: editNote.trim() ? editNote.trim() : null,
			reasonNote: editReasonNote.trim() ? editReasonNote.trim() : null,
		};

		try {
			await reviseIncomeEntitlement(
				entitlement.entitlementId,
				payload,
				crypto.randomUUID(),
			);
			await queryClient.invalidateQueries({
				queryKey: ["income-entitlements"],
			});
			await queryClient.invalidateQueries({
				queryKey: ["income-entitlement", entitlementId],
			});
			setIsEditModalOpen(false);
		} catch (err) {
			if (err instanceof ApiError) {
				if (err.code === "INCOME_ENTITLEMENT_REVISION_CONFLICT") {
					await refetch();
				}
				setEditError(err.userMessage);
			} else {
				setEditError("Beklenen gelir güncellenirken bir hata oluştu.");
			}
		}
	};

	const handleVoidSubmit = async (e: React.FormEvent) => {
		e.preventDefault();
		if (!entitlement) return;
		setVoidError(null);

		const payload: VoidIncomeEntitlementPayload = {
			expectedRevisionNo: entitlement.revisionNo,
			reasonNote: voidReasonNote.trim() ? voidReasonNote.trim() : null,
		};

		try {
			await voidIncomeEntitlement(
				entitlement.entitlementId,
				payload,
				crypto.randomUUID(),
			);
			await queryClient.invalidateQueries({
				queryKey: ["income-entitlements"],
			});
			await queryClient.invalidateQueries({
				queryKey: ["income-entitlement", entitlementId],
			});
			setIsVoidModalOpen(false);
		} catch (err) {
			if (err instanceof ApiError) {
				if (err.code === "INCOME_ENTITLEMENT_REVISION_CONFLICT") {
					await refetch();
				}
				setVoidError(err.userMessage);
			} else {
				setVoidError("Beklenen gelir iptal edilirken bir hata oluştu.");
			}
		}
	};

	if (isLoading) {
		return (
			<div className="detail-page-container">
				<div className="card p-8 text-center text-secondary">
					Beklenen gelir detayları yükleniyor...
				</div>
			</div>
		);
	}

	if (isError || !entitlement) {
		return (
			<div className="detail-page-container">
				<div className="card p-8 text-center text-danger">
					<p className="mb-3">
						Beklenen gelir kaydı bulunamadı veya bir hata oluştu.
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

	const isVoided = entitlement.status === "VOIDED";
	const settlementInfo = formatSettlementStatusLabel(
		entitlement.settlementStatus,
	);
	const periodUi = fromEntitlementPeriodMonth(entitlement.periodMonth);

	return (
		<div
			className="detail-page-container"
			data-testid="entitlement-detail-page"
		>
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
						<h1 className="page-title mb-0">
							{entitlement.sourceName} — {formatPeriodMonthTurkish(periodUi)}
						</h1>
						<span className="text-xs text-secondary font-mono">
							Revizyon #{entitlement.revisionNo}
						</span>
					</div>
				</div>

				{!isVoided && (
					<div className="flex items-center gap-2">
						<button
							type="button"
							className="btn btn-secondary flex items-center gap-1"
							onClick={openEdit}
							data-testid="btn-edit-entitlement"
						>
							<Edit size={16} aria-hidden="true" />
							<span>Düzenle</span>
						</button>
						<button
							type="button"
							className="btn btn-outline-danger flex items-center gap-1"
							onClick={openVoid}
							data-testid="btn-void-entitlement"
						>
							<Trash2 size={16} aria-hidden="true" />
							<span>İptal Et</span>
						</button>
					</div>
				)}
			</div>

			{isVoided && (
				<div className="alert alert-secondary mb-4" role="status">
					Bu beklenen gelir kaydı iptal edilmiştir (geçersiz kılınmıştır).
				</div>
			)}

			<div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">
				<div className="card p-4">
					<span className="text-xs text-secondary block mb-1">
						Beklenen Tutar
					</span>
					<span
						className="text-2xl font-bold block"
						data-testid="entitlement-amount"
					>
						{formatMoneyToTry(entitlement.amount)}
					</span>
					<span className="text-xs text-secondary mt-1 block">
						Dönem: {formatPeriodMonthTurkish(periodUi)}
					</span>
				</div>

				<div className="card p-4">
					<span className="text-xs text-secondary block mb-1">
						Eşleşen (Karşılanan) Tutar
					</span>
					<span className="text-2xl font-bold text-success block">
						{formatMoneyToTry(entitlement.allocatedAmount)}
					</span>
					<span className="text-xs text-secondary mt-1 block">
						Durum:{" "}
						<span className={`badge ${settlementInfo.badgeClass}`}>
							{settlementInfo.label}
						</span>
					</span>
				</div>

				<div className="card p-4">
					<span className="text-xs text-secondary block mb-1">
						Kalan Açık Beklenti
					</span>
					<span className="text-2xl font-bold text-warning block">
						{formatMoneyToTry(entitlement.outstandingAmount)}
					</span>
					<span className="text-xs text-secondary mt-1 block">
						{entitlement.expectedReceiptOn ? (
							<span>
								Beklenen Gün: {entitlement.expectedReceiptOn}
								{entitlement.overdue && (
									<strong className="text-danger ml-1">(Gecikti)</strong>
								)}
							</span>
						) : (
							"Belirli gün girilmedi"
						)}
					</span>
				</div>
			</div>

			<div className="card p-6 mb-4">
				<h3 className="font-semibold text-lg mb-3">Detay Bilgileri</h3>
				<dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-3 text-sm">
					<div>
						<dt className="text-secondary">Gelir Kaynağı Kodu</dt>
						<dd className="font-mono">{entitlement.sourceCode}</dd>
					</div>
					<div>
						<dt className="text-secondary">Gelir Kaynağı Adı</dt>
						<dd className="font-medium">{entitlement.sourceName}</dd>
					</div>
					<div>
						<dt className="text-secondary">Dönem Formatı</dt>
						<dd className="font-mono">{entitlement.periodMonth}</dd>
					</div>
					<div>
						<dt className="text-secondary">Durum</dt>
						<dd>
							<span
								className={`badge ${isVoided ? "badge-secondary" : "badge-success"}`}
							>
								{entitlement.status === "ACTIVE" ? "Aktif" : "İptal Edildi"}
							</span>
						</dd>
					</div>
					{entitlement.note && (
						<div className="sm:col-span-2">
							<dt className="text-secondary">Not</dt>
							<dd>{entitlement.note}</dd>
						</div>
					)}
				</dl>
			</div>

			{/* Edit Modal */}
			<AccessibleModal
				isOpen={isEditModalOpen}
				onClose={() => setIsEditModalOpen(false)}
				title="Beklenen Geliri Düzenle"
				variant="center-dialog"
			>
				<form onSubmit={handleEditSubmit}>
					{editError && (
						<div className="alert alert-danger mb-4" role="alert">
							{editError}
						</div>
					)}

					<div className="form-group mb-3">
						<label htmlFor="edit-entitlement-amount" className="form-label">
							Yeni Beklenen Tutar
						</label>
						<MoneyInput
							id="edit-entitlement-amount"
							value={editAmount}
							onChange={setEditAmount}
							required
						/>
					</div>

					<div className="form-group mb-3">
						<label
							htmlFor="edit-entitlement-expected-on"
							className="form-label"
						>
							Tahmini Tahsilat Günü
						</label>
						<input
							id="edit-entitlement-expected-on"
							type="date"
							className="form-control"
							value={editExpectedReceiptOn}
							onChange={(e) => setEditExpectedReceiptOn(e.target.value)}
						/>
					</div>

					<div className="form-group mb-3">
						<label htmlFor="edit-entitlement-note" className="form-label">
							Açıklama / Not
						</label>
						<input
							id="edit-entitlement-note"
							type="text"
							className="form-control"
							value={editNote}
							onChange={(e) => setEditNote(e.target.value)}
							maxLength={255}
						/>
					</div>

					<div className="form-group mb-4">
						<label htmlFor="edit-entitlement-reason" className="form-label">
							Değişiklik Gerekçesi (İsteğe Bağlı)
						</label>
						<input
							id="edit-entitlement-reason"
							type="text"
							className="form-control"
							value={editReasonNote}
							onChange={(e) => setEditReasonNote(e.target.value)}
							placeholder="Örn: Enflasyon artışı güncellendi"
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
						<button type="submit" className="btn btn-primary">
							Değişiklikleri Kaydet
						</button>
					</div>
				</form>
			</AccessibleModal>

			{/* Void Modal */}
			<AccessibleModal
				isOpen={isVoidModalOpen}
				onClose={() => setIsVoidModalOpen(false)}
				title="Beklenen Geliri İptal Et"
				variant="center-dialog"
			>
				<form onSubmit={handleVoidSubmit}>
					<p className="text-secondary text-sm mb-4">
						Bu beklenen geliri iptal etmek istediğinize emin misiniz? Bir
						tahsilatla eşleştirilmiş beklenen gelirler doğrudan iptal edilemez.
					</p>

					{voidError && (
						<div className="alert alert-danger mb-4" role="alert">
							{voidError}
						</div>
					)}

					<div className="form-group mb-4">
						<label htmlFor="void-entitlement-reason" className="form-label">
							İptal Gerekçesi (İsteğe Bağlı)
						</label>
						<input
							id="void-entitlement-reason"
							type="text"
							className="form-control"
							value={voidReasonNote}
							onChange={(e) => setVoidReasonNote(e.target.value)}
							placeholder="Örn: Bu ay burs yatmayacak"
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
							Beklenen Geliri İptal Et
						</button>
					</div>
				</form>
			</AccessibleModal>
		</div>
	);
}
