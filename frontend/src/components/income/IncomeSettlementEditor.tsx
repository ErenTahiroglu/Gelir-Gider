import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Plus, Trash2 } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { ApiError, isNetworkUncertainError } from "../../api/errors";
import {
	createIncomeSettlement,
	fetchIncomeEntitlements,
	reviseIncomeSettlement,
} from "../../api/income-api";
import type {
	CreateIncomeSettlementPayload,
	IncomeReceiptSettlementResponse,
	ReviseIncomeSettlementPayload,
} from "../../api/income-types";
import {
	formatPeriodMonthTurkish,
	fromEntitlementPeriodMonth,
} from "../../lib/istanbul-date";
import {
	formatCentsToCanonical,
	formatMoneyToTry,
	parseMoneyToCents,
} from "../../lib/money";
import { MoneyInput } from "../common/MoneyInput";

interface IncomeSettlementEditorProps {
	incomeReceiptId: string;
	sourceId: string;
	receiptAmount: string;
	existingSettlement?: IncomeReceiptSettlementResponse | null | undefined;
	onSuccess: () => void;
	onCancel: () => void;
}

interface AllocationRow {
	id: string;
	entitlementId: string;
	amount: string;
}

type FrozenSettlementAttempt =
	| {
			type: "CREATE";
			key: string;
			payload: CreateIncomeSettlementPayload;
	  }
	| {
			type: "REVISE";
			key: string;
			payload: ReviseIncomeSettlementPayload;
	  }
	| {
			type: "CLEAR";
			key: string;
			payload: ReviseIncomeSettlementPayload;
	  };

export function IncomeSettlementEditor({
	incomeReceiptId,
	sourceId,
	receiptAmount,
	existingSettlement,
	onSuccess,
	onCancel,
}: IncomeSettlementEditorProps) {
	const queryClient = useQueryClient();

	const isEditing = Boolean(existingSettlement);

	// Initial allocations from existing settlement or empty row
	const initialAllocations: AllocationRow[] = useMemo(() => {
		if (existingSettlement && existingSettlement.allocations.length > 0) {
			return existingSettlement.allocations.map((a) => ({
				id: a.entitlementId || crypto.randomUUID(),
				entitlementId: a.entitlementId,
				amount: a.allocatedAmount,
			}));
		}
		return [{ id: crypto.randomUUID(), entitlementId: "", amount: "" }];
	}, [existingSettlement]);

	const [allocations, setAllocations] =
		useState<AllocationRow[]>(initialAllocations);
	const [note, _setNote] = useState("");
	const [reasonNote, setReasonNote] = useState("");
	const [submitting, setSubmitting] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [uncertainWarning, setUncertainWarning] = useState<string | null>(null);

	const frozenAttemptRef = useRef<FrozenSettlementAttempt | null>(null);

	// Load entitlements for the same source
	const { data: entitlementsData, isLoading: entitlementsLoading } = useQuery({
		queryKey: ["income-entitlements", { sourceId }],
		queryFn: () => fetchIncomeEntitlements({ sourceId, limit: 100 }),
		staleTime: 10_000,
	});

	const allEntitlements = entitlementsData?.entitlements ?? [];

	// Eligible entitlements: ACTIVE and (outstandingAmount > 0 or part of existing settlement)
	const eligibleEntitlements = useMemo(() => {
		return allEntitlements.filter((e) => {
			if (e.status !== "ACTIVE") return false;
			const isAlreadyAllocated = allocations.some(
				(a) => a.entitlementId === e.entitlementId,
			);
			return parseMoneyToCents(e.outstandingAmount) > 0n || isAlreadyAllocated;
		});
	}, [allEntitlements, allocations]);

	// Calculate totals in BigInt cents
	const receiptCents = useMemo(
		() => parseMoneyToCents(receiptAmount),
		[receiptAmount],
	);

	const totalAllocatedCents = useMemo(() => {
		let sum = 0n;
		for (const row of allocations) {
			if (row.amount?.trim()) {
				try {
					sum += parseMoneyToCents(row.amount);
				} catch {
					// Ignore invalid partial input
				}
			}
		}
		return sum;
	}, [allocations]);

	const unallocatedCents = receiptCents - totalAllocatedCents;
	const isOverallocated = unallocatedCents < 0n;

	const handleAddRow = () => {
		setAllocations((prev) => [
			...prev,
			{ id: crypto.randomUUID(), entitlementId: "", amount: "" },
		]);
	};

	const handleRemoveRow = (index: number) => {
		setAllocations((prev) => prev.filter((_, i) => i !== index));
	};

	const handleRowChange = (
		index: number,
		field: "entitlementId" | "amount",
		val: string,
	) => {
		setAllocations((prev) =>
			prev.map((row, i) => {
				if (i !== index) return row;
				if (field === "entitlementId") {
					// If setting entitlementId and amount is empty, prefill with min(unallocated, remainingCapacity)
					const entitlement = eligibleEntitlements.find(
						(e) => e.entitlementId === val,
					);
					let newAmount = row.amount;
					if (!newAmount && entitlement) {
						const remainingCapacityCents = parseMoneyToCents(
							entitlement.outstandingAmount,
						);
						const fillCents =
							unallocatedCents > 0n
								? unallocatedCents < remainingCapacityCents
									? unallocatedCents
									: remainingCapacityCents
								: remainingCapacityCents;
						if (fillCents > 0n) {
							newAmount = formatCentsToCanonical(fillCents);
						}
					}
					return { ...row, entitlementId: val, amount: newAmount };
				}
				return { ...row, [field]: val };
			}),
		);
	};

	const executeClearSettlement = async (isRetry: boolean) => {
		if (!existingSettlement) return;
		setError(null);
		setUncertainWarning(null);

		let key: string;
		let payload: ReviseIncomeSettlementPayload;

		if (isRetry && frozenAttemptRef.current?.type === "CLEAR") {
			key = frozenAttemptRef.current.key;
			payload = frozenAttemptRef.current.payload;
		} else {
			if (
				!window.confirm(
					"Bu tahsilatın tüm beklenen gelir eşleştirmesini temizlemek istediğinize emin misiniz?",
				)
			) {
				return;
			}

			key = crypto.randomUUID();
			payload = {
				expectedRevisionNo: existingSettlement.revisionNo,
				allocations: [],
				reasonNote: "Eşleştirme kullanıcı tarafından temizlendi",
			};
			frozenAttemptRef.current = { type: "CLEAR", key, payload };
		}

		setSubmitting(true);
		try {
			await reviseIncomeSettlement(incomeReceiptId, payload, key);
			frozenAttemptRef.current = null;
			setUncertainWarning(null);
			await queryClient.invalidateQueries({
				queryKey: ["income-settlement", incomeReceiptId],
			});
			await queryClient.invalidateQueries({
				queryKey: ["income-entitlements"],
			});
			await queryClient.invalidateQueries({ queryKey: ["income-receipts"] });
			onSuccess();
		} catch (err) {
			if (isNetworkUncertainError(err)) {
				setUncertainWarning(
					"Eşleştirmenin temizlenip temizlenmediği doğrulanamadı.",
				);
			} else {
				frozenAttemptRef.current = null;
				if (err instanceof ApiError) {
					if (err.code === "INCOME_SETTLEMENT_REVISION_CONFLICT") {
						await queryClient.invalidateQueries({
							queryKey: ["income-settlement", incomeReceiptId],
						});
						await queryClient.invalidateQueries({
							queryKey: ["income-entitlements"],
						});
					}
					setError(err.userMessage);
				} else {
					setError("Eşleştirme temizlenirken hata oluştu.");
				}
			}
		} finally {
			setSubmitting(false);
		}
	};

	const executeSubmit = async (isRetry: boolean) => {
		setError(null);
		setUncertainWarning(null);

		let key: string;
		let attemptType: "CREATE" | "REVISE";
		let createPayload: CreateIncomeSettlementPayload | null = null;
		let revisePayload: ReviseIncomeSettlementPayload | null = null;

		if (
			isRetry &&
			frozenAttemptRef.current &&
			(frozenAttemptRef.current.type === "CREATE" ||
				frozenAttemptRef.current.type === "REVISE")
		) {
			key = frozenAttemptRef.current.key;
			attemptType = frozenAttemptRef.current.type;
			if (frozenAttemptRef.current.type === "CREATE") {
				createPayload = frozenAttemptRef.current.payload;
			} else {
				revisePayload = frozenAttemptRef.current.payload;
			}
		} else {
			const validRows = allocations.filter(
				(r) => r.entitlementId && r.amount?.trim(),
			);

			if (validRows.length === 0) {
				setError(
					"En az bir beklenen gelir eşleştirmesi seçmeli ve tutar girmelisiniz.",
				);
				return;
			}

			// Check for duplicate entitlement selections
			const seenEntitlements = new Set<string>();
			for (const row of validRows) {
				if (seenEntitlements.has(row.entitlementId)) {
					setError("Aynı beklenen gelir birden fazla satırda seçilemez.");
					return;
				}
				seenEntitlements.add(row.entitlementId);

				let cents: bigint;
				try {
					cents = parseMoneyToCents(row.amount);
				} catch {
					setError("Geçerli bir eşleştirme tutarı girin.");
					return;
				}

				if (cents <= 0n) {
					setError("Tüm eşleştirme tutarları sıfırdan büyük olmalıdır.");
					return;
				}
			}

			// Guard: sum <= receiptAmount
			if (totalAllocatedCents > receiptCents) {
				setError(
					`Eşleştirilen toplam tutar (${formatCentsToCanonical(totalAllocatedCents)} ₺), tahsilat tutarından (${receiptAmount} ₺) fazla olamaz.`,
				);
				return;
			}

			key = crypto.randomUUID();
			if (isEditing && existingSettlement) {
				attemptType = "REVISE";
				revisePayload = {
					expectedRevisionNo: existingSettlement.revisionNo,
					allocations: validRows.map((r) => ({
						entitlementId: r.entitlementId,
						amount: r.amount,
					})),
					note: note.trim() ? note.trim() : null,
					reasonNote: reasonNote.trim() ? reasonNote.trim() : null,
				};
				frozenAttemptRef.current = {
					type: "REVISE",
					key,
					payload: revisePayload,
				};
			} else {
				attemptType = "CREATE";
				createPayload = {
					allocations: validRows.map((r) => ({
						entitlementId: r.entitlementId,
						amount: r.amount,
					})),
					note: note.trim() ? note.trim() : null,
				};
				frozenAttemptRef.current = {
					type: "CREATE",
					key,
					payload: createPayload,
				};
			}
		}

		setSubmitting(true);
		try {
			if (attemptType === "REVISE" && revisePayload) {
				await reviseIncomeSettlement(incomeReceiptId, revisePayload, key);
			} else if (attemptType === "CREATE" && createPayload) {
				await createIncomeSettlement(incomeReceiptId, createPayload, key);
			}

			frozenAttemptRef.current = null;
			setUncertainWarning(null);
			await queryClient.invalidateQueries({
				queryKey: ["income-settlement", incomeReceiptId],
			});
			await queryClient.invalidateQueries({
				queryKey: ["income-entitlements"],
			});
			await queryClient.invalidateQueries({ queryKey: ["income-receipts"] });
			onSuccess();
		} catch (err) {
			if (isNetworkUncertainError(err)) {
				setUncertainWarning(
					attemptType === "CREATE"
						? "Eşleştirmenin oluşturulup oluşturulmadığı doğrulanamadı."
						: "Eşleştirme güncellemesinin tamamlanıp tamamlanmadığı doğrulanamadı.",
				);
			} else {
				frozenAttemptRef.current = null;
				if (err instanceof ApiError) {
					if (err.code === "INCOME_SETTLEMENT_REVISION_CONFLICT") {
						await queryClient.invalidateQueries({
							queryKey: ["income-settlement", incomeReceiptId],
						});
						await queryClient.invalidateQueries({
							queryKey: ["income-entitlements"],
						});
					}
					setError(err.userMessage);
				} else {
					setError("Eşleştirme kaydedilirken hata oluştu.");
				}
			}
		} finally {
			setSubmitting(false);
		}
	};

	const handleSubmit = (e: React.FormEvent) => {
		e.preventDefault();
		void executeSubmit(false);
	};

	return (
		<div className="settlement-editor card p-6" data-testid="settlement-editor">
			<div className="flex justify-between items-center mb-4">
				<h3 className="font-semibold text-lg">
					{isEditing
						? "Beklenen Gelir Eşleştirmesini Düzenle"
						: "Beklenen Gelir Eşleştirmesi Yap"}
				</h3>
				{isEditing && (
					<button
						type="button"
						className="btn btn-sm btn-outline-danger"
						onClick={() => void executeClearSettlement(false)}
						disabled={submitting || Boolean(uncertainWarning)}
						data-testid="btn-clear-settlement"
					>
						Eşleştirmeyi Temizle
					</button>
				)}
			</div>

			<p className="text-sm text-secondary mb-4">
				Bu gerçekleşen tahsilatın hangi beklenen gelir kayıtlarına ait olduğunu
				eşleştirin. Eşleştirme yalnızca ilişkilendirme amaçlıdır; hesap
				bakiyelerini tekrar değiştirmez.
			</p>

			{uncertainWarning && (
				<div
					className="alert alert-warning mb-4 flex items-center justify-between gap-2"
					role="alert"
					data-testid="settlement-uncertain-warning"
				>
					<div className="flex items-center gap-2">
						<AlertTriangle size={18} className="text-warning shrink-0" />
						<span className="text-sm">{uncertainWarning}</span>
					</div>
					<div className="flex items-center gap-2">
						<button
							type="button"
							className="btn btn-sm btn-secondary"
							onClick={() => {
								frozenAttemptRef.current = null;
								setUncertainWarning(null);
							}}
							disabled={submitting}
						>
							Yeni Deneme
						</button>
						<button
							type="button"
							className="btn btn-sm btn-primary"
							onClick={() => {
								if (frozenAttemptRef.current?.type === "CLEAR") {
									void executeClearSettlement(true);
								} else {
									void executeSubmit(true);
								}
							}}
							disabled={submitting}
							data-testid="btn-retry-settlement"
						>
							{submitting ? "Deneniyor..." : "Aynı İşlemi Tekrar Dene"}
						</button>
					</div>
				</div>
			)}

			{error && (
				<div className="alert alert-danger mb-4" role="alert">
					{error}
				</div>
			)}

			<div className="grid grid-cols-3 gap-3 p-3 bg-secondary/10 rounded mb-4 text-sm">
				<div>
					<span className="text-secondary block">Tahsilat Tutarı</span>
					<span className="font-bold">{formatMoneyToTry(receiptAmount)}</span>
				</div>
				<div>
					<span className="text-secondary block">Eşleştirilen Toplam</span>
					<span className="font-bold text-success">
						{formatCentsToCanonical(totalAllocatedCents)} ₺
					</span>
				</div>
				<div>
					<span className="text-secondary block">Kalan Eşleşmemiş</span>
					<span
						className={`font-bold ${isOverallocated ? "text-danger" : "text-secondary"}`}
					>
						{formatCentsToCanonical(unallocatedCents)} ₺
					</span>
				</div>
			</div>

			<form onSubmit={handleSubmit}>
				<div className="allocations-list flex flex-col gap-3 mb-4">
					{allocations.map((row, idx) => {
						const _selectedEntitlement = eligibleEntitlements.find(
							(e) => e.entitlementId === row.entitlementId,
						);
						return (
							<div
								key={row.id}
								className="allocation-row flex flex-wrap sm:flex-nowrap items-end gap-2 p-3 border rounded"
							>
								<div className="flex-1 min-w-[200px]">
									<label
										htmlFor={`allocation-entitlement-${idx}`}
										className="form-label text-xs mb-1"
									>
										Beklenen Gelir Dönemi
									</label>
									{entitlementsLoading ? (
										<p className="text-xs text-secondary">Yükleniyor...</p>
									) : (
										<select
											id={`allocation-entitlement-${idx}`}
											className="form-control"
											value={row.entitlementId}
											onChange={(e) =>
												handleRowChange(idx, "entitlementId", e.target.value)
											}
											disabled={submitting || Boolean(uncertainWarning)}
											required
										>
											<option value="">Beklenen Gelir Seçin...</option>
											{eligibleEntitlements.map((e) => {
												const periodUi = fromEntitlementPeriodMonth(
													e.periodMonth,
												);
												return (
													<option key={e.entitlementId} value={e.entitlementId}>
														{formatPeriodMonthTurkish(periodUi)} — Toplam:{" "}
														{formatMoneyToTry(e.amount)} (Kalan:{" "}
														{formatMoneyToTry(e.outstandingAmount)})
													</option>
												);
											})}
										</select>
									)}
								</div>

								<div className="w-[160px]">
									<label
										htmlFor={`allocation-amount-${idx}`}
										className="form-label text-xs mb-1"
									>
										Aktarılan Tutar
									</label>
									<MoneyInput
										id={`allocation-amount-${idx}`}
										value={row.amount}
										onChange={(val) => handleRowChange(idx, "amount", val)}
										placeholder="0,00"
										disabled={submitting || Boolean(uncertainWarning)}
										required
									/>
								</div>

								{allocations.length > 1 && (
									<button
										type="button"
										className="btn btn-icon btn-ghost text-danger mb-1"
										onClick={() => handleRemoveRow(idx)}
										disabled={submitting || Boolean(uncertainWarning)}
										aria-label="Satırı Sil"
									>
										<Trash2 size={16} aria-hidden="true" />
									</button>
								)}
							</div>
						);
					})}
				</div>

				<div className="mb-4">
					<button
						type="button"
						className="btn btn-sm btn-outline-secondary inline-flex items-center gap-1"
						onClick={handleAddRow}
						disabled={submitting || Boolean(uncertainWarning)}
					>
						<Plus size={14} aria-hidden="true" />
						<span>Satır Ekle</span>
					</button>
				</div>

				{isEditing && (
					<div className="form-group mb-4">
						<label htmlFor="settlement-reason" className="form-label">
							Değişiklik Gerekçesi (İsteğe Bağlı)
						</label>
						<input
							id="settlement-reason"
							type="text"
							className="form-control"
							value={reasonNote}
							onChange={(e) => setReasonNote(e.target.value)}
							disabled={submitting || Boolean(uncertainWarning)}
							placeholder="Örn: Yanlış aya eşleştirilmişti"
							maxLength={255}
						/>
					</div>
				)}

				<div className="form-actions flex justify-end gap-2">
					<button
						type="button"
						className="btn btn-secondary"
						onClick={onCancel}
						disabled={submitting}
					>
						Vazgeç
					</button>
					<button
						type="submit"
						className="btn btn-primary"
						disabled={
							submitting || isOverallocated || Boolean(uncertainWarning)
						}
						data-testid="btn-save-settlement"
					>
						{submitting ? "Kaydediliyor..." : "Eşleştirmeyi Kaydet"}
					</button>
				</div>
			</form>
		</div>
	);
}
