/**
 * Reusable Turkish Currency Money Input Component
 *
 * Adheres strictly to Section 41, 42, 60:
 *   - Accepts natural inputs: "350", "350,5", "350,50", "1.250,50"
 *   - Normalizes without floating-point arithmetic to canonical "350.00"
 *   - Accessible with aria-invalid, aria-describedby
 *   - Immediate validation feedback on blur/change
 */

import {
	type ChangeEvent,
	type FocusEvent,
	useEffect,
	useRef,
	useState,
} from "react";
import { normalizeTurkishMoneyInput } from "../../lib/money";

export interface MoneyInputProps {
	id: string;
	name?: string | undefined;
	value: string;
	onChange: (canonical: string, raw: string, isValid: boolean) => void;
	placeholder?: string | undefined;
	disabled?: boolean | undefined;
	required?: boolean | undefined;
	"aria-describedby"?: string | undefined;
	className?: string | undefined;
	autoFocus?: boolean | undefined;
}

export function MoneyInput({
	id,
	name,
	value,
	onChange,
	placeholder = "0,00",
	disabled = false,
	required = false,
	"aria-describedby": ariaDescribedBy,
	className = "",
	autoFocus = false,
}: MoneyInputProps) {
	const inputRef = useRef<HTMLInputElement>(null);
	// Internal raw text while typing
	const [displayValue, setDisplayValue] = useState<string>(value);
	const [localError, setLocalError] = useState<string | null>(null);

	useEffect(() => {
		if (autoFocus && inputRef.current) {
			inputRef.current.focus();
		}
	}, [autoFocus]);

	const handleChange = (e: ChangeEvent<HTMLInputElement>) => {
		const raw = e.target.value;
		setDisplayValue(raw);

		if (raw.trim() === "") {
			setLocalError(required ? "Tutar zorunludur" : null);
			onChange("", raw, false);
			return;
		}

		const result = normalizeTurkishMoneyInput(raw);
		if (result.valid && result.canonical) {
			setLocalError(null);
			onChange(result.canonical, raw, true);
		} else {
			setLocalError(result.error ?? "Geçersiz tutar");
			onChange("", raw, false);
		}
	};

	const handleBlur = (_e: FocusEvent<HTMLInputElement>) => {
		if (displayValue.trim() === "") {
			if (required) {
				setLocalError("Tutar zorunludur");
			}
			return;
		}

		const result = normalizeTurkishMoneyInput(displayValue);
		if (result.valid && result.canonical) {
			// Format cleanly for display with comma, e.g. "350,00"
			const [whole, dec] = result.canonical.split(".");
			const formatted = `${whole},${dec}`;
			setDisplayValue(formatted);
			setLocalError(null);
			onChange(result.canonical, formatted, true);
		} else {
			setLocalError(result.error ?? "Geçersiz tutar");
		}
	};

	const errorId = `${id}-error`;
	const combinedDescribedBy = [ariaDescribedBy, localError ? errorId : null]
		.filter(Boolean)
		.join(" ");

	return (
		<div className={`money-input-container ${className}`}>
			<div className="money-input-wrapper">
				<span className="money-currency-prefix" aria-hidden="true">
					₺
				</span>
				<input
					ref={inputRef}
					type="text"
					inputMode="decimal"
					id={id}
					name={name}
					value={displayValue}
					onChange={handleChange}
					onBlur={handleBlur}
					placeholder={placeholder}
					disabled={disabled}
					required={required}
					aria-invalid={localError !== null}
					aria-describedby={combinedDescribedBy || undefined}
					className={`form-input money-input ${localError ? "input-error" : ""}`}
					data-testid="money-input"
				/>
			</div>
			{localError && (
				<span
					id={errorId}
					className="form-field-error"
					data-testid="money-input-error"
					role="alert"
				>
					{localError}
				</span>
			)}
		</div>
	);
}
