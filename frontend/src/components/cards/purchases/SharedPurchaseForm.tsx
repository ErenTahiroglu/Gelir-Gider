/**
 * Shared Credit Card Purchase Creation Form
 *
 * Implements Section 39-49:
 *   - Atomic endpoint: POST /credit-cards/:cardId/purchases/shared
 *   - People selector: GET /people?status=ACTIVE&limit=100
 *   - 1..9 participants, no duplicates
 *   - EQUAL / MANUAL / RATIO strict contract shapes
 *   - BigInt cent split preview (Section 47 & 48)
 *   - Stable Idempotency-Key
 *   - Secondary spending category assignment
 */

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2, Users } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { mapCreditCardError } from "../../../api/credit-card-errors";
import {
	createSharedCreditCardPurchase,
	fetchAllActivePeople,
} from "../../../api/credit-cards-api";
import type {
	SharedPurchaseResponse,
	SplitMethod,
	SplitParticipantInput,
} from "../../../api/credit-cards-types";
import { fetchSpendingCategories } from "../../../api/manual-expenses-api";
import { assignSpendingCategory } from "../../../api/quick-entry-api";
import type { BudgetCategorySelection } from "../../../api/quick-entry-types";
import {
	formatIstanbulDateTimeLocal,
	parseIstanbulDateTimeLocalToIso,
} from "../../../lib/istanbul-date";
import { formatMoneyToTry } from "../../../lib/money";
import {
	calculateEqualSplitPreview,
	calculateManualSplitPreview,
	calculateRatioSplitPreview,
} from "../../../lib/split-math";
import { MoneyInput } from "../../common/MoneyInput";

export interface SharedPurchaseFormProps {
	cardId: string;
	cardName?: string | undefined;
	onSuccess?: ((res: SharedPurchaseResponse) => void) | undefined;
	onCancel?: (() => void) | undefined;
}

interface FormParticipant {
	personId: string;
	shareAmount: string; // for MANUAL
	weight: number; // for RATIO
	dueDate: string; // YYYY-MM-DD
	description: string;
}

export function SharedPurchaseForm({
	cardId,
	cardName,
	onSuccess,
	onCancel,
}: SharedPurchaseFormProps) {
	const queryClient = useQueryClient();

	// Fetch active people
	const {
		data: people,
		isLoading: peopleLoading,
		error: peopleError,
	} = useQuery({
		queryKey: ["active-people"],
		queryFn: () => fetchAllActivePeople(100),
		staleTime: 60_000,
	});

	// Fetch spending categories
	const { data: categoriesData } = useQuery({
		queryKey: ["spending-categories"],
		queryFn: fetchSpendingCategories,
		staleTime: 60_000,
	});

	const activePeople = useMemo(() => people ?? [], [people]);
	const activeCategories = useMemo(
		() =>
			(categoriesData?.categories ?? []).filter((c) => c.status === "ACTIVE"),
		[categoriesData?.categories],
	);

	// Purchase fields
	const [amountCanonical, setAmountCanonical] = useState<string>("");
	const [amountDisplay, setAmountDisplay] = useState<string>("");
	const [amountValid, setAmountValid] = useState<boolean>(false);
	const [spendingCategoryId, setSpendingCategoryId] = useState<string>("");
	const [purchaseCategory, setPurchaseCategory] =
		useState<BudgetCategorySelection>("MANDATORY_EXPENSE");
	const [merchant, setMerchant] = useState<string>("");
	const [description, setDescription] = useState<string>("");
	const [installmentCount, setInstallmentCount] = useState<string>("1");
	const [occurredAtLocal, setOccurredAtLocal] = useState<string>(() =>
		formatIstanbulDateTimeLocal(new Date()),
	);

	// Split fields
	const [splitMethod, setSplitMethod] = useState<SplitMethod>("EQUAL");
	const [userWeight, setUserWeight] = useState<number>(1);
	const [participants, setParticipants] = useState<FormParticipant[]>([]);

	// Selected person to add
	const [candidatePersonId, setCandidatePersonId] = useState<string>("");

	// Submission state
	const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
	const [errorMessage, setErrorMessage] = useState<string | null>(null);
	const [successResult, setSuccessResult] =
		useState<SharedPurchaseResponse | null>(null);

	const idempotencyKeyRef = useRef<string>(crypto.randomUUID());

	// Filter candidate people: active people not already selected
	const unselectedPeople = activePeople.filter(
		(p) => !participants.some((part) => part.personId === p.personId),
	);

	const handleAddParticipant = () => {
		if (!candidatePersonId) return;
		if (participants.length >= 9) {
			setErrorMessage("En fazla 9 ortak kişi eklenebilir.");
			return;
		}

		setParticipants((prev) => [
			...prev,
			{
				personId: candidatePersonId,
				shareAmount: "0.00",
				weight: 1,
				dueDate: "",
				description: "",
			},
		]);
		setCandidatePersonId("");
		setErrorMessage(null);
	};

	const handleRemoveParticipant = (personId: string) => {
		setParticipants((prev) => prev.filter((p) => p.personId !== personId));
	};

	const handleParticipantShareChange = (personId: string, val: string) => {
		setParticipants((prev) =>
			prev.map((p) =>
				p.personId === personId ? { ...p, shareAmount: val } : p,
			),
		);
	};

	const handleParticipantWeightChange = (personId: string, val: number) => {
		setParticipants((prev) =>
			prev.map((p) => (p.personId === personId ? { ...p, weight: val } : p)),
		);
	};

	const handleCategoryChange = (catId: string) => {
		setSpendingCategoryId(catId);
		if (!catId) return;
		const cat = activeCategories.find((c) => c.id === catId);
		if (cat && cat.defaultBudgetCategory !== "ASK") {
			setPurchaseCategory(cat.defaultBudgetCategory);
		}
	};

	// Split preview calculation (Section 47 & 48)
	const previewResult = useMemo(() => {
		if (!amountValid || !amountCanonical || participants.length === 0) {
			return null;
		}

		const partsForPreview = participants.map((p) => {
			const person = activePeople.find((ap) => ap.personId === p.personId);
			return {
				personId: p.personId,
				displayName: person?.displayName,
				shareAmountStr: p.shareAmount,
				weight: p.weight,
			};
		});

		if (splitMethod === "EQUAL") {
			return calculateEqualSplitPreview(amountCanonical, partsForPreview);
		}
		if (splitMethod === "MANUAL") {
			return calculateManualSplitPreview(amountCanonical, partsForPreview);
		}
		if (splitMethod === "RATIO") {
			return calculateRatioSplitPreview(
				amountCanonical,
				userWeight,
				partsForPreview,
			);
		}
		return null;
	}, [
		amountValid,
		amountCanonical,
		participants,
		splitMethod,
		userWeight,
		activePeople,
	]);

	const handleSubmit = async (e: React.FormEvent) => {
		e.preventDefault();
		setErrorMessage(null);

		if (!amountValid || !amountCanonical) {
			setErrorMessage("Geçerli bir harcama tutarı giriniz.");
			return;
		}

		if (participants.length === 0) {
			setErrorMessage("Ortak harcama için en az bir kişi eklemelisiniz.");
			return;
		}

		if (participants.length > 9) {
			setErrorMessage("En fazla 9 ortak kişi eklenebilir.");
			return;
		}

		if (previewResult && !previewResult.isValid) {
			setErrorMessage(
				previewResult.errorMessage || "Paylaşım hesaplaması geçersiz.",
			);
			return;
		}

		let installments: number | undefined;
		if (installmentCount) {
			const instNum = Number.parseInt(installmentCount, 10);
			if (Number.isNaN(instNum) || instNum < 1 || instNum > 60) {
				setErrorMessage("Taksit sayısı 1 ile 60 arasında olmalıdır.");
				return;
			}
			installments = instNum > 1 ? instNum : undefined;
		}

		let occurredAtIso: string;
		try {
			occurredAtIso = parseIstanbulDateTimeLocalToIso(occurredAtLocal);
		} catch {
			setErrorMessage("Tarih ve saat biçimi geçersiz.");
			return;
		}

		// Prepare participants payload strictly adhering to Section 44, 45, 46
		const payloadParticipants: SplitParticipantInput[] = participants.map(
			(p) => {
				const base: SplitParticipantInput = {
					personId: p.personId,
					dueDate: p.dueDate || undefined,
					description: p.description.trim() || undefined,
				};
				if (splitMethod === "MANUAL") {
					base.shareAmount = p.shareAmount;
				} else if (splitMethod === "RATIO") {
					base.weight = p.weight;
				}
				// EQUAL does NOT send shareAmount or weight!
				return base;
			},
		);

		setIsSubmitting(true);

		try {
			const res = await createSharedCreditCardPurchase(
				cardId,
				{
					amount: amountCanonical,
					purchaseCategory,
					merchant: merchant.trim() || undefined,
					description: description.trim() || undefined,
					installmentCount: installments,
					occurredAt: occurredAtIso,
					splitMethod,
					userWeight: splitMethod === "RATIO" ? userWeight : undefined,
					participants: payloadParticipants,
				},
				idempotencyKeyRef.current,
			);

			// Authoritative invalidations (Section 60)
			await Promise.all([
				queryClient.invalidateQueries({ queryKey: ["card-purchases", cardId] }),
				queryClient.invalidateQueries({ queryKey: ["credit-card", cardId] }),
				queryClient.invalidateQueries({ queryKey: ["credit-cards"] }),
				queryClient.invalidateQueries({ queryKey: ["active-credit-cards"] }),
				queryClient.invalidateQueries({ queryKey: ["transactions"] }),
				queryClient.invalidateQueries({ queryKey: ["spending-summary"] }),
			]);

			// Secondary category assignment
			if (spendingCategoryId) {
				try {
					await assignSpendingCategory({
						subjectType: "CREDIT_CARD_PURCHASE",
						subjectId: res.purchase.eventId ?? res.purchase.purchaseId ?? "",
						categoryId: spendingCategoryId,
					});
					await queryClient.invalidateQueries({
						queryKey: ["spending-summary"],
					});
				} catch {
					// Non-blocking secondary error
				}
			}

			setSuccessResult(res);
			if (onSuccess) onSuccess(res);
		} catch (err) {
			setErrorMessage(mapCreditCardError(err));
		} finally {
			setIsSubmitting(false);
		}
	};

	// If no people available (Section 40)
	if (!peopleLoading && activePeople.length === 0) {
		return (
			<div
				className="no-people-warning"
				style={{
					padding: "1.5rem",
					borderRadius: "8px",
					background: "rgba(234, 179, 8, 0.15)",
					border: "1px solid #eab308",
					color: "#ca8a04",
				}}
				data-testid="no-people-message"
			>
				<h4 style={{ margin: "0 0 0.5rem 0" }}>Ortak Harcama Kullanılamıyor</h4>
				<p style={{ margin: 0 }}>
					Ortak harcama için önce en az bir kişi kaydı gerekiyor. Kişi yönetimi
					sonraki aşamada açılacak.
				</p>
				{onCancel && (
					<button
						type="button"
						className="btn btn-secondary"
						onClick={onCancel}
						style={{ marginTop: "1rem" }}
					>
						Geri Dön
					</button>
				)}
			</div>
		);
	}

	// Success screen with server-returned obligations (Section 49)
	if (successResult) {
		return (
			<div
				className="shared-success-card card"
				style={{ padding: "1.5rem" }}
				data-testid="shared-purchase-success-view"
			>
				<h3 style={{ color: "#16a34a", marginTop: 0 }}>
					Ortak Harcama Başarıyla Kaydedildi
				</h3>
				<p>
					Toplam harcama tutarı:{" "}
					<strong>
						{formatMoneyToTry(successResult.purchase?.amount ?? "0.00")}
					</strong>
				</p>
				<p>
					Senin Payın:{" "}
					<strong>
						{formatMoneyToTry(successResult.split?.userShareAmount ?? "0.00")}
					</strong>
				</p>

				<h4 style={{ marginTop: "1.25rem", marginBottom: "0.5rem" }}>
					Oluşturulan Alacak Kayıtları:
				</h4>
				<ul style={{ paddingLeft: "1.25rem" }}>
					{successResult.split.participants.map((part) => (
						<li key={part.personId} data-testid="obligation-confirm-row">
							<strong>{part.displayName}</strong> adına{" "}
							<strong>{formatMoneyToTry(part.shareAmount)}</strong> alacak kaydı
							oluşturuldu.
						</li>
					))}
				</ul>

				<div style={{ marginTop: "1.5rem" }}>
					{onSuccess && (
						<button
							type="button"
							className="btn btn-primary"
							onClick={() => onSuccess(successResult)}
							data-testid="shared-success-close-btn"
						>
							Tamam
						</button>
					)}
				</div>
			</div>
		);
	}

	return (
		<form
			onSubmit={handleSubmit}
			className="shared-purchase-form"
			data-testid="shared-purchase-form"
			noValidate
		>
			{errorMessage && (
				<div
					className="error-alert"
					role="alert"
					data-testid="shared-purchase-error"
				>
					{errorMessage}
				</div>
			)}

			<div className="form-group">
				<label htmlFor="shared-amount" className="form-label">
					Toplam Kart Harcaması *
				</label>
				<MoneyInput
					id="shared-amount"
					value={amountDisplay}
					onChange={(canonical, raw, isValid) => {
						setAmountCanonical(canonical);
						setAmountDisplay(raw);
						setAmountValid(isValid);
					}}
					required
				/>
			</div>

			<div className="form-row">
				<div className="form-group" style={{ flex: 1 }}>
					<label htmlFor="shared-merchant" className="form-label">
						İşyeri / Satıcı
					</label>
					<input
						id="shared-merchant"
						type="text"
						className="form-input"
						value={merchant}
						onChange={(e) => setMerchant(e.target.value)}
						placeholder="Örn: Restoran, Market"
						maxLength={200}
						data-testid="shared-merchant-input"
					/>
				</div>

				<div className="form-group" style={{ flex: 1 }}>
					<label htmlFor="shared-installment" className="form-label">
						Taksit Sayısı
					</label>
					<input
						id="shared-installment"
						type="number"
						min={1}
						max={60}
						className="form-input"
						value={installmentCount}
						onChange={(e) => setInstallmentCount(e.target.value)}
						placeholder="Tek çekim için 1"
						data-testid="shared-installment-input"
					/>
				</div>
			</div>

			<div className="form-group">
				<label htmlFor="shared-description" className="form-label">
					Açıklama
				</label>
				<input
					id="shared-description"
					type="text"
					className="form-input"
					value={description}
					onChange={(e) => setDescription(e.target.value)}
					placeholder="Örn: Akşam yemeği ortak hesap"
					maxLength={500}
					data-testid="shared-description-input"
				/>
			</div>

			<div className="form-row">
				<div className="form-group" style={{ flex: 1 }}>
					<label htmlFor="shared-spending-category" className="form-label">
						Harcama Kategorisi
					</label>
					<select
						id="shared-spending-category"
						className="form-select"
						value={spendingCategoryId}
						onChange={(e) => handleCategoryChange(e.target.value)}
						data-testid="shared-category-select"
					>
						<option value="">Kategori Seçin (Opsiyonel)</option>
						{activeCategories.map((c) => (
							<option key={c.id} value={c.id}>
								{c.name}
							</option>
						))}
					</select>
				</div>

				<div className="form-group" style={{ flex: 1 }}>
					<label htmlFor="shared-occurred-at" className="form-label">
						Harcama Tarihi / Saati *
					</label>
					<input
						id="shared-occurred-at"
						type="datetime-local"
						className="form-input"
						value={occurredAtLocal}
						onChange={(e) => setOccurredAtLocal(e.target.value)}
						required
						data-testid="shared-occurred-at-input"
					/>
				</div>
			</div>

			{/* Split Configuration */}
			<div
				className="split-section card"
				style={{
					padding: "1rem",
					background: "var(--color-bg-secondary, #f8fafc)",
					border: "1px solid var(--color-border, #e2e8f0)",
					borderRadius: "8px",
					marginTop: "1rem",
				}}
			>
				<h4
					style={{
						margin: "0 0 0.75rem 0",
						display: "flex",
						alignItems: "center",
						gap: "0.5rem",
					}}
				>
					<Users size={18} aria-hidden="true" />
					<span>Ortak Harcama Paylaşımı</span>
				</h4>

				{/* Method Selector */}
				<div
					className="split-method-group"
					style={{ display: "flex", gap: "1rem", marginBottom: "1rem" }}
				>
					<label
						style={{
							display: "flex",
							alignItems: "center",
							gap: "0.4rem",
							cursor: "pointer",
						}}
					>
						<input
							type="radio"
							name="splitMethod"
							value="EQUAL"
							checked={splitMethod === "EQUAL"}
							onChange={() => setSplitMethod("EQUAL")}
							data-testid="split-method-equal"
						/>
						<span>Eşit Paylaşım</span>
					</label>

					<label
						style={{
							display: "flex",
							alignItems: "center",
							gap: "0.4rem",
							cursor: "pointer",
						}}
					>
						<input
							type="radio"
							name="splitMethod"
							value="MANUAL"
							checked={splitMethod === "MANUAL"}
							onChange={() => setSplitMethod("MANUAL")}
							data-testid="split-method-manual"
						/>
						<span>Tutar Belirterek</span>
					</label>

					<label
						style={{
							display: "flex",
							alignItems: "center",
							gap: "0.4rem",
							cursor: "pointer",
						}}
					>
						<input
							type="radio"
							name="splitMethod"
							value="RATIO"
							checked={splitMethod === "RATIO"}
							onChange={() => setSplitMethod("RATIO")}
							data-testid="split-method-ratio"
						/>
						<span>Oran / Ağırlıkla</span>
					</label>
				</div>

				{splitMethod === "RATIO" && (
					<div
						className="form-group"
						style={{ maxWidth: "200px", marginBottom: "1rem" }}
					>
						<label htmlFor="user-weight-input" className="form-label">
							Senin Ağırlığın
						</label>
						<input
							id="user-weight-input"
							type="number"
							min={0}
							className="form-input"
							value={userWeight}
							onChange={(e) =>
								setUserWeight(
									Math.max(0, Number.parseInt(e.target.value, 10) || 0),
								)
							}
							data-testid="user-weight-input"
						/>
					</div>
				)}

				{/* Add Participant Row */}
				<div
					className="add-participant-row"
					style={{
						display: "flex",
						gap: "0.5rem",
						alignItems: "flex-end",
						marginBottom: "1rem",
					}}
				>
					<div style={{ flex: 1 }}>
						<label htmlFor="candidate-person" className="form-label">
							Kişi Ekle (1-9 kişi)
						</label>
						<select
							id="candidate-person"
							className="form-select"
							value={candidatePersonId}
							onChange={(e) => setCandidatePersonId(e.target.value)}
							disabled={participants.length >= 9}
							data-testid="candidate-person-select"
						>
							<option value="">Kişi Seçin</option>
							{unselectedPeople.map((p) => (
								<option key={p.personId} value={p.personId}>
									{p.displayName} ({p.relationship})
								</option>
							))}
						</select>
					</div>
					<button
						type="button"
						className="btn btn-secondary"
						onClick={handleAddParticipant}
						disabled={!candidatePersonId || participants.length >= 9}
						data-testid="add-participant-btn"
					>
						<Plus size={16} aria-hidden="true" />
						<span>Ekle</span>
					</button>
				</div>

				{/* Participant List */}
				{participants.length > 0 && (
					<div
						className="participants-list"
						style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}
					>
						{participants.map((part) => {
							const person = activePeople.find(
								(p) => p.personId === part.personId,
							);
							return (
								<div
									key={part.personId}
									className="participant-row"
									style={{
										display: "flex",
										gap: "0.5rem",
										alignItems: "center",
										background: "var(--color-bg-surface, #ffffff)",
										padding: "0.5rem 0.75rem",
										borderRadius: "6px",
										border: "1px solid var(--color-border, #e2e8f0)",
									}}
									data-testid={`participant-row-${part.personId}`}
								>
									<div style={{ flex: 2, fontWeight: 500 }}>
										{person?.displayName || "Kişi"}
									</div>

									{splitMethod === "MANUAL" && (
										<div style={{ flex: 2 }}>
											<input
												type="text"
												className="form-input form-input-sm"
												placeholder="0.00"
												value={part.shareAmount}
												onChange={(e) =>
													handleParticipantShareChange(
														part.personId,
														e.target.value,
													)
												}
												data-testid={`participant-share-${part.personId}`}
											/>
										</div>
									)}

									{splitMethod === "RATIO" && (
										<div style={{ flex: 1 }}>
											<input
												type="number"
												min={1}
												className="form-input form-input-sm"
												value={part.weight}
												onChange={(e) =>
													handleParticipantWeightChange(
														part.personId,
														Math.max(
															1,
															Number.parseInt(e.target.value, 10) || 1,
														),
													)
												}
												data-testid={`participant-weight-${part.personId}`}
											/>
										</div>
									)}

									<button
										type="button"
										className="btn-icon text-danger"
										onClick={() => handleRemoveParticipant(part.personId)}
										title="Kişiyi Çıkar"
										data-testid={`remove-participant-${part.personId}`}
										style={{
											background: "none",
											border: "none",
											cursor: "pointer",
											color: "#dc2626",
										}}
									>
										<Trash2 size={16} aria-hidden="true" />
									</button>
								</div>
							);
						})}
					</div>
				)}

				{/* Preview Section (Section 47 & 48) */}
				{previewResult?.isValid && (
					<div
						className="split-preview-box"
						style={{
							marginTop: "1rem",
							padding: "0.75rem",
							borderRadius: "6px",
							background: "rgba(37, 99, 235, 0.08)",
							border: "1px solid rgba(37, 99, 235, 0.2)",
						}}
						data-testid="split-preview-box"
					>
						<div
							style={{
								fontSize: "0.85rem",
								fontWeight: 600,
								marginBottom: "0.25rem",
								color: "#1e40af",
							}}
						>
							Önizleme (Tahmini Paylar)
						</div>
						<div
							style={{
								display: "flex",
								justifyContent: "space-between",
								fontSize: "0.85rem",
							}}
						>
							<span>Senin Payın:</span>
							<strong data-testid="preview-user-share">
								{formatMoneyToTry(previewResult.userShareAmount)}
							</strong>
						</div>
						<div
							style={{
								display: "flex",
								justifyContent: "space-between",
								fontSize: "0.85rem",
								marginTop: "0.25rem",
							}}
						>
							<span>Diğerlerinden Toplam Alacak:</span>
							<strong data-testid="preview-external-share">
								{formatMoneyToTry(previewResult.externalShareAmount)}
							</strong>
						</div>
						<small
							style={{
								display: "block",
								marginTop: "0.4rem",
								fontSize: "0.75rem",
								color: "#64748b",
							}}
						>
							Sunucu kayıtta kuruş farkını ve alacak kayıtlarını kesinleştirir.
						</small>
					</div>
				)}
			</div>

			<div className="form-actions" style={{ marginTop: "1.5rem" }}>
				{onCancel && (
					<button
						type="button"
						className="btn btn-secondary"
						onClick={onCancel}
						disabled={isSubmitting}
					>
						İptal
					</button>
				)}
				<button
					type="submit"
					className="btn btn-primary"
					disabled={
						isSubmitting ||
						!amountValid ||
						participants.length === 0 ||
						(previewResult !== null && !previewResult.isValid)
					}
					data-testid="submit-shared-purchase-button"
				>
					{isSubmitting ? "Kaydediliyor..." : "Ortak Harcamayı Kaydet"}
				</button>
			</div>
		</form>
	);
}
