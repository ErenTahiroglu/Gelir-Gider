/**
 * Attach Split Modal
 *
 * Implements Section 51:
 *   - Attaches split to an existing POSTED unshared purchase
 *   - Endpoint: POST /credit-cards/:cardId/purchases/:purchaseId/split
 */

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { mapCreditCardError } from "../../../api/credit-card-errors";
import {
	attachPurchaseSplit,
	fetchAllActivePeople,
} from "../../../api/credit-cards-api";
import type {
	CreditCardPurchaseItem,
	SplitMethod,
	SplitParticipantInput,
} from "../../../api/credit-cards-types";
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
import { AccessibleModal } from "../../common/AccessibleModal";

export interface AttachSplitModalProps {
	isOpen: boolean;
	cardId: string;
	purchase: CreditCardPurchaseItem;
	onClose: () => void;
	onSuccess?: () => void;
}

interface FormParticipant {
	personId: string;
	shareAmount: string;
	weight: number;
	dueDate: string;
	description: string;
}

export function AttachSplitModal({
	isOpen,
	cardId,
	purchase,
	onClose,
	onSuccess,
}: AttachSplitModalProps) {
	const queryClient = useQueryClient();

	const { data: people } = useQuery({
		queryKey: ["active-people"],
		queryFn: () => fetchAllActivePeople(100),
		enabled: isOpen,
	});

	const activePeople = useMemo(() => people ?? [], [people]);

	const [splitMethod, setSplitMethod] = useState<SplitMethod>("EQUAL");
	const [userWeight, _setUserWeight] = useState<number>(1);
	const [participants, setParticipants] = useState<FormParticipant[]>([]);
	const [candidatePersonId, setCandidatePersonId] = useState<string>("");
	const [occurredAtLocal, _setOccurredAtLocal] = useState<string>(() =>
		formatIstanbulDateTimeLocal(new Date()),
	);

	const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
	const [errorMessage, setErrorMessage] = useState<string | null>(null);

	const idempotencyKeyRef = useRef<string>(crypto.randomUUID());

	const unselectedPeople = activePeople.filter(
		(p) => !participants.some((part) => part.personId === p.personId),
	);

	const handleAddParticipant = () => {
		if (!candidatePersonId || participants.length >= 9) return;
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

	const previewResult = useMemo(() => {
		if (participants.length === 0) return null;
		const partsForPreview = participants.map((p) => ({
			personId: p.personId,
			displayName: activePeople.find((ap) => ap.personId === p.personId)
				?.displayName,
			shareAmountStr: p.shareAmount,
			weight: p.weight,
		}));

		if (splitMethod === "EQUAL") {
			return calculateEqualSplitPreview(purchase.amount, partsForPreview);
		}
		if (splitMethod === "MANUAL") {
			return calculateManualSplitPreview(purchase.amount, partsForPreview);
		}
		if (splitMethod === "RATIO") {
			return calculateRatioSplitPreview(
				purchase.amount,
				userWeight,
				partsForPreview,
			);
		}
		return null;
	}, [purchase.amount, participants, splitMethod, userWeight, activePeople]);

	const handleSubmit = async (e: React.FormEvent) => {
		e.preventDefault();
		setErrorMessage(null);

		if (participants.length === 0) {
			setErrorMessage("En az bir kişi eklemelisiniz.");
			return;
		}

		if (previewResult && !previewResult.isValid) {
			setErrorMessage(previewResult.errorMessage || "Geçersiz paylaşım.");
			return;
		}

		let occurredAtIso: string;
		try {
			occurredAtIso = parseIstanbulDateTimeLocalToIso(occurredAtLocal);
		} catch {
			setErrorMessage("Tarih ve saat biçimi geçersiz.");
			return;
		}

		const payloadParticipants: SplitParticipantInput[] = participants.map(
			(p) => {
				const base: SplitParticipantInput = {
					personId: p.personId,
					dueDate: p.dueDate || undefined,
					description: p.description.trim() || undefined,
				};
				if (splitMethod === "MANUAL") base.shareAmount = p.shareAmount;
				if (splitMethod === "RATIO") base.weight = p.weight;
				return base;
			},
		);

		setIsSubmitting(true);

		try {
			await attachPurchaseSplit(
				cardId,
				purchase.eventId ?? purchase.purchaseId ?? "",
				{
					splitMethod,
					userWeight: splitMethod === "RATIO" ? userWeight : undefined,
					participants: payloadParticipants,
					occurredAt: occurredAtIso,
				},
				idempotencyKeyRef.current,
			);

			await Promise.all([
				queryClient.invalidateQueries({ queryKey: ["card-purchases", cardId] }),
				queryClient.invalidateQueries({
					queryKey: ["card-purchase", cardId, purchase.eventId],
				}),
				queryClient.invalidateQueries({
					queryKey: ["purchase-split", cardId, purchase.eventId],
				}),
				queryClient.invalidateQueries({ queryKey: ["credit-card", cardId] }),
				queryClient.invalidateQueries({ queryKey: ["credit-cards"] }),
			]);

			onClose();
			if (onSuccess) onSuccess();
		} catch (err) {
			setErrorMessage(mapCreditCardError(err));
		} finally {
			setIsSubmitting(false);
		}
	};

	return (
		<AccessibleModal
			isOpen={isOpen}
			onClose={onClose}
			title="Ortak Harcamaya Dönüştür"
			description="Bu harcamaya kişi paylaşımı ekle"
		>
			<form onSubmit={handleSubmit} noValidate>
				{errorMessage && (
					<div
						className="error-alert"
						role="alert"
						data-testid="attach-split-error"
					>
						{errorMessage}
					</div>
				)}

				<div style={{ marginBottom: "1rem" }}>
					<span>Toplam Harcama: </span>
					<strong>{formatMoneyToTry(purchase.amount)}</strong>
				</div>

				<div
					className="split-method-group"
					style={{ display: "flex", gap: "1rem", marginBottom: "1rem" }}
				>
					<label
						style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}
					>
						<input
							type="radio"
							name="attachSplitMethod"
							value="EQUAL"
							checked={splitMethod === "EQUAL"}
							onChange={() => setSplitMethod("EQUAL")}
						/>
						<span>Eşit</span>
					</label>
					<label
						style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}
					>
						<input
							type="radio"
							name="attachSplitMethod"
							value="MANUAL"
							checked={splitMethod === "MANUAL"}
							onChange={() => setSplitMethod("MANUAL")}
						/>
						<span>Tutarla</span>
					</label>
					<label
						style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}
					>
						<input
							type="radio"
							name="attachSplitMethod"
							value="RATIO"
							checked={splitMethod === "RATIO"}
							onChange={() => setSplitMethod("RATIO")}
						/>
						<span>Oranla</span>
					</label>
				</div>

				{/* Add person */}
				<div style={{ display: "flex", gap: "0.5rem", marginBottom: "1rem" }}>
					<select
						className="form-select"
						value={candidatePersonId}
						onChange={(e) => setCandidatePersonId(e.target.value)}
						data-testid="attach-candidate-select"
					>
						<option value="">Kişi Seçin</option>
						{unselectedPeople.map((p) => (
							<option key={p.personId} value={p.personId}>
								{p.displayName}
							</option>
						))}
					</select>
					<button
						type="button"
						className="btn btn-secondary"
						onClick={handleAddParticipant}
						disabled={!candidatePersonId}
						data-testid="attach-add-person-btn"
					>
						<Plus size={16} aria-hidden="true" />
						<span>Ekle</span>
					</button>
				</div>

				{/* List */}
				{participants.map((part) => {
					const person = activePeople.find((p) => p.personId === part.personId);
					return (
						<div
							key={part.personId}
							style={{
								display: "flex",
								gap: "0.5rem",
								alignItems: "center",
								marginBottom: "0.5rem",
							}}
						>
							<span style={{ flex: 2 }}>{person?.displayName}</span>
							{splitMethod === "MANUAL" && (
								<input
									type="text"
									className="form-input form-input-sm"
									style={{ flex: 1 }}
									value={part.shareAmount}
									onChange={(e) =>
										setParticipants((prev) =>
											prev.map((p) =>
												p.personId === part.personId
													? { ...p, shareAmount: e.target.value }
													: p,
											),
										)
									}
									placeholder="0.00"
								/>
							)}
							{splitMethod === "RATIO" && (
								<input
									type="number"
									min={1}
									className="form-input form-input-sm"
									style={{ flex: 1 }}
									value={part.weight}
									onChange={(e) =>
										setParticipants((prev) =>
											prev.map((p) =>
												p.personId === part.personId
													? {
															...p,
															weight: Math.max(
																1,
																Number.parseInt(e.target.value, 10) || 1,
															),
														}
													: p,
											),
										)
									}
								/>
							)}
							<button
								type="button"
								style={{
									background: "none",
									border: "none",
									color: "#dc2626",
									cursor: "pointer",
								}}
								onClick={() => handleRemoveParticipant(part.personId)}
							>
								<Trash2 size={16} aria-hidden="true" />
							</button>
						</div>
					);
				})}

				{/* Preview */}
				{previewResult?.isValid && (
					<div
						style={{
							padding: "0.5rem",
							borderRadius: "4px",
							background: "rgba(37,99,235,0.08)",
							marginBottom: "1rem",
							fontSize: "0.85rem",
						}}
					>
						<div>
							Senin Payın:{" "}
							<strong>{formatMoneyToTry(previewResult.userShareAmount)}</strong>
						</div>
						<div>
							Diğerlerinden Alacak:{" "}
							<strong>
								{formatMoneyToTry(previewResult.externalShareAmount)}
							</strong>
						</div>
					</div>
				)}

				<div
					className="modal-actions"
					style={{ display: "flex", justifyContent: "flex-end", gap: "0.5rem" }}
				>
					<button type="button" className="btn btn-secondary" onClick={onClose}>
						İptal
					</button>
					<button
						type="submit"
						className="btn btn-primary"
						disabled={isSubmitting || participants.length === 0}
						data-testid="confirm-attach-split-btn"
					>
						{isSubmitting ? "Kaydediliyor..." : "Paylaşımı Ekle"}
					</button>
				</div>
			</form>
		</AccessibleModal>
	);
}
