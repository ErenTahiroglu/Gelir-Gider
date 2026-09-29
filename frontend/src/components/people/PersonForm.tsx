import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, ArrowLeft, RefreshCw, Save } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ApiError, isNetworkUncertainError } from "../../api/errors";
import { createPerson, fetchPerson, updatePerson } from "../../api/people-api";
import type {
	PersonProductDto,
	PersonRelationship,
} from "../../api/people-types";

interface PersonFormProps {
	mode: "create" | "edit";
	personId?: string;
	onSuccess?: (person: PersonProductDto) => void;
	onCancel?: () => void;
}

interface FrozenPersonAttempt {
	mode: "create" | "edit";
	personId?: string | undefined;
	payload: {
		displayName: string;
		relationship: PersonRelationship;
		note?: string | undefined;
		occurredAt: string;
		expectedRevisionNo?: number | undefined;
	};
	idempotencyKey: string;
}

export function PersonForm({
	mode,
	personId,
	onSuccess,
	onCancel,
}: PersonFormProps) {
	const queryClient = useQueryClient();

	// In edit mode, fetch fresh person authority
	const {
		data: personData,
		isLoading: isFetchingPerson,
		error: fetchError,
		refetch: refetchPerson,
	} = useQuery({
		queryKey: ["person", personId],
		queryFn: () => (personId ? fetchPerson(personId) : null),
		enabled: mode === "edit" && Boolean(personId),
		staleTime: 0,
	});

	const initialPerson = personData?.person;

	const [displayName, setDisplayName] = useState("");
	const [relationship, setRelationship] =
		useState<PersonRelationship>("FRIEND");
	const [note, setNote] = useState("");
	const [validationError, setValidationError] = useState<string | null>(null);
	const [apiError, setApiError] = useState<string | null>(null);
	const [revisionConflict, setRevisionConflict] = useState(false);
	const [isNetworkUncertain, setIsNetworkUncertain] = useState(false);

	// Frozen attempt for network retry
	const frozenAttemptRef = useRef<FrozenPersonAttempt | null>(null);

	// Synchronize edit fields when fresh person data is loaded
	useEffect(() => {
		if (mode === "edit" && initialPerson) {
			setDisplayName(initialPerson.displayName);
			setRelationship(initialPerson.relationship);
			setNote(initialPerson.note ?? "");
			setRevisionConflict(false);
		}
	}, [mode, initialPerson]);

	const mutation = useMutation({
		mutationFn: async (attempt: FrozenPersonAttempt) => {
			if (attempt.mode === "create") {
				return createPerson(attempt.payload, attempt.idempotencyKey);
			}

			if (
				!attempt.personId ||
				attempt.payload.expectedRevisionNo === undefined
			) {
				throw new Error("Kişi verisi bulunamadı.");
			}

			return updatePerson(
				attempt.personId,
				{
					displayName: attempt.payload.displayName,
					relationship: attempt.payload.relationship,
					note: attempt.payload.note,
					occurredAt: attempt.payload.occurredAt,
					expectedRevisionNo: attempt.payload.expectedRevisionNo,
				},
				attempt.idempotencyKey,
			);
		},
		retry: false,
		onSuccess: (data) => {
			// Invalidate caches
			void queryClient.invalidateQueries({ queryKey: ["people"] });
			void queryClient.invalidateQueries({ queryKey: ["active-people"] });
			if (personId) {
				void queryClient.invalidateQueries({ queryKey: ["person", personId] });
				void queryClient.invalidateQueries({
					queryKey: ["person-balance-summary", personId],
				});
			}

			// Clear frozen attempt
			frozenAttemptRef.current = null;
			setIsNetworkUncertain(false);
			setRevisionConflict(false);

			onSuccess?.(data.person);
		},
		onError: (err) => {
			if (isNetworkUncertainError(err)) {
				setIsNetworkUncertain(true);
				setApiError(null);
				return;
			}
			setIsNetworkUncertain(false);
			if (err instanceof ApiError) {
				if (err.code === "PEOPLE_REVISION_CONFLICT") {
					setRevisionConflict(true);
					setApiError(
						"Kişi bilgileri başka bir işlem tarafından güncellendi. Lütfen en güncel bilgileri inceleyin.",
					);
				} else {
					setApiError(err.userMessage);
				}
			} else if (err instanceof Error) {
				setApiError(err.message);
			} else {
				setApiError("İşlem sırasında bir hata oluştu.");
			}
		},
	});

	const handleSubmit = (e: React.FormEvent) => {
		e.preventDefault();
		if (isNetworkUncertain) return;
		setValidationError(null);
		setApiError(null);

		const trimmedName = displayName.trim();
		if (!trimmedName) {
			setValidationError("Lütfen kişinin adını girin.");
			return;
		}
		if (trimmedName.length > 120) {
			setValidationError("Kişi adı en fazla 120 karakter olabilir.");
			return;
		}
		if (note.trim().length > 500) {
			setValidationError("Not en fazla 500 karakter olabilir.");
			return;
		}

		if (mode === "edit" && (!personId || !initialPerson)) {
			setValidationError("Kişi verisi bulunamadı.");
			return;
		}

		const key = crypto.randomUUID();
		const occurredAt = new Date().toISOString();
		const attempt: FrozenPersonAttempt = {
			mode,
			personId,
			payload: {
				displayName: trimmedName,
				relationship,
				note: note.trim() !== "" ? note.trim() : undefined,
				occurredAt,
				...(mode === "edit" && initialPerson
					? { expectedRevisionNo: initialPerson.revisionNo }
					: {}),
			},
			idempotencyKey: key,
		};
		frozenAttemptRef.current = attempt;
		mutation.mutate(attempt);
	};

	const handleRetryUncertain = () => {
		if (!frozenAttemptRef.current) return;
		setApiError(null);
		mutation.mutate(frozenAttemptRef.current);
	};

	const handleReloadConflict = async () => {
		frozenAttemptRef.current = null;
		setIsNetworkUncertain(false);
		setRevisionConflict(false);
		setApiError(null);
		await refetchPerson();
	};

	if (mode === "edit" && isFetchingPerson) {
		return (
			<div className="person-form-loading" data-testid="person-form-loading">
				<p>Kişi bilgileri yükleniyor...</p>
			</div>
		);
	}

	if (mode === "edit" && fetchError) {
		return (
			<div className="person-form-error alert alert-danger">
				<AlertCircle size={18} aria-hidden="true" />
				<span>Kişi bilgileri yüklenemedi. Lütfen tekrar deneyin.</span>
			</div>
		);
	}

	return (
		<form
			onSubmit={handleSubmit}
			className="person-form"
			data-testid="person-form"
			noValidate
		>
			{validationError && (
				<div
					className="alert alert-danger"
					role="alert"
					data-testid="person-validation-error"
				>
					<AlertCircle size={18} aria-hidden="true" />
					<span>{validationError}</span>
				</div>
			)}

			{apiError && (
				<div
					className="alert alert-danger"
					role="alert"
					data-testid="person-api-error"
				>
					<AlertCircle size={18} aria-hidden="true" />
					<span>{apiError}</span>
				</div>
			)}

			{isNetworkUncertain && (
				<div
					className="alert alert-warning"
					role="alert"
					data-testid="person-uncertain-alert"
				>
					<AlertCircle size={18} aria-hidden="true" />
					<div>
						<p>İşlemin kaydedilip kaydedilmediği doğrulanamadı.</p>
						<button
							type="button"
							className="btn btn-secondary btn-sm mt-2"
							onClick={handleRetryUncertain}
							disabled={mutation.isPending}
							data-testid="retry-uncertain-btn"
						>
							Aynı İşlemi Tekrar Dene
						</button>
					</div>
				</div>
			)}

			{revisionConflict && (
				<div
					className="person-conflict-box alert alert-warning"
					data-testid="person-conflict-box"
				>
					<div className="conflict-message">
						<strong>Güncelleme Çakışması</strong>
						<p>
							Bu kişi başka bir sekmede veya cihazda güncellendi. Devam etmeden
							önce güncel bilgileri yüklemeniz gerekmektedir.
						</p>
					</div>
					<button
						type="button"
						className="btn btn-secondary btn-sm"
						onClick={handleReloadConflict}
						data-testid="reload-conflict-btn"
					>
						<RefreshCw size={14} aria-hidden="true" />
						<span>Güncel Veriyi Yükle</span>
					</button>
				</div>
			)}

			<div className="form-group">
				<label htmlFor="person-displayName" className="form-label">
					Kişi Adı <span className="required-star">*</span>
				</label>
				<input
					id="person-displayName"
					type="text"
					className="form-control"
					value={displayName}
					onChange={(e) => setDisplayName(e.target.value)}
					maxLength={120}
					placeholder="Örn: Ali Yılmaz"
					disabled={
						mutation.isPending || revisionConflict || isNetworkUncertain
					}
					data-testid="person-name-input"
					required
				/>
				<span className="form-hint">{displayName.length}/120 karakter</span>
			</div>

			<div className="form-group">
				<span className="form-label">İlişki Türü</span>
				<div
					className="relationship-options-grid"
					role="radiogroup"
					aria-label="İlişki Türü"
				>
					<label
						className={`relationship-card ${relationship === "FRIEND" ? "selected" : ""}`}
					>
						<input
							type="radio"
							name="relationship"
							value="FRIEND"
							checked={relationship === "FRIEND"}
							onChange={() => setRelationship("FRIEND")}
							disabled={
								mutation.isPending || revisionConflict || isNetworkUncertain
							}
							data-testid="relationship-friend"
						/>
						<span className="relationship-title">Arkadaş</span>
						<span className="relationship-desc">5-TL yuvarlama önerisi</span>
					</label>

					<label
						className={`relationship-card ${relationship === "FAMILY" ? "selected" : ""}`}
					>
						<input
							type="radio"
							name="relationship"
							value="FAMILY"
							checked={relationship === "FAMILY"}
							onChange={() => setRelationship("FAMILY")}
							disabled={
								mutation.isPending || revisionConflict || isNetworkUncertain
							}
							data-testid="relationship-family"
						/>
						<span className="relationship-title">Aile</span>
						<span className="relationship-desc">Tam tutar tahsilatı</span>
					</label>

					<label
						className={`relationship-card ${relationship === "OTHER" ? "selected" : ""}`}
					>
						<input
							type="radio"
							name="relationship"
							value="OTHER"
							checked={relationship === "OTHER"}
							onChange={() => setRelationship("OTHER")}
							disabled={
								mutation.isPending || revisionConflict || isNetworkUncertain
							}
							data-testid="relationship-other"
						/>
						<span className="relationship-title">Diğer</span>
						<span className="relationship-desc">Tam tutar tahsilatı</span>
					</label>
				</div>
			</div>

			<div className="form-group">
				<label htmlFor="person-note" className="form-label">
					Not (İsteğe Bağlı)
				</label>
				<textarea
					id="person-note"
					className="form-control"
					value={note}
					onChange={(e) => setNote(e.target.value)}
					maxLength={500}
					rows={3}
					placeholder="Kişi hakkında hatırlatıcı bir not..."
					disabled={
						mutation.isPending || revisionConflict || isNetworkUncertain
					}
					data-testid="person-note-input"
				/>
				<span className="form-hint">{note.length}/500 karakter</span>
			</div>

			<div className="form-actions">
				{onCancel && (
					<button
						type="button"
						className="btn btn-secondary"
						onClick={onCancel}
						disabled={mutation.isPending}
						data-testid="person-cancel-btn"
					>
						<ArrowLeft size={16} aria-hidden="true" />
						<span>İptal</span>
					</button>
				)}

				<button
					type="submit"
					className="btn btn-primary"
					disabled={
						mutation.isPending || revisionConflict || isNetworkUncertain
					}
					data-testid="person-submit-btn"
				>
					<Save size={16} aria-hidden="true" />
					<span>
						{mutation.isPending
							? "Kaydediliyor..."
							: mode === "create"
								? "Kişiyi Ekle"
								: "Değişiklikleri Kaydet"}
					</span>
				</button>
			</div>
		</form>
	);
}
