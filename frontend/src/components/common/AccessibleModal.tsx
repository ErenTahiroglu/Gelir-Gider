/**
 * Accessible Dialog / Sheet / Modal Primitives (Dependency-Free)
 *
 * Adheres strictly to Section 20, 60, 62:
 *   - Accessible dialog role="dialog", aria-modal="true", labelledby/describedby
 *   - Traps focus within modal container
 *   - Closes on Escape key
 *   - Closes on overlay click
 *   - Returns focus to trigger element on unmount/close
 *   - Locks background scroll
 *   - Responsive: bottom sheet style on mobile, centered/drawer on desktop
 */

import { type ReactNode, useEffect, useRef } from "react";

export interface AccessibleModalProps {
	isOpen: boolean;
	onClose: () => void;
	title: string;
	titleId?: string | undefined;
	description?: string | undefined;
	descriptionId?: string | undefined;
	variant?: "drawer-right" | "bottom-sheet" | "center-dialog" | undefined;
	children: ReactNode;
	className?: string | undefined;
}

export function AccessibleModal({
	isOpen,
	onClose,
	title,
	titleId = "modal-title",
	description,
	descriptionId = "modal-desc",
	variant = "drawer-right",
	children,
	className = "",
}: AccessibleModalProps) {
	const overlayRef = useRef<HTMLDivElement>(null);
	const contentRef = useRef<HTMLDivElement>(null);
	const previousActiveElement = useRef<HTMLElement | null>(null);

	// Remember focused element on open & return on close
	useEffect(() => {
		if (!isOpen) {
			return undefined;
		}

		previousActiveElement.current = document.activeElement as HTMLElement;

		// Focus first focusable element inside modal
		const timer = setTimeout(() => {
			if (contentRef.current) {
				const focusable = contentRef.current.querySelectorAll<HTMLElement>(
					'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
				);
				const first = focusable[0];
				if (first) {
					first.focus();
				} else {
					contentRef.current.focus();
				}
			}
		}, 50);

		// Lock body scroll
		const originalOverflow = document.body.style.overflow;
		document.body.style.overflow = "hidden";

		return () => {
			clearTimeout(timer);
			document.body.style.overflow = originalOverflow;
			if (previousActiveElement.current) {
				previousActiveElement.current.focus();
			}
		};
	}, [isOpen]);

	// Escape key handler & focus trap
	useEffect(() => {
		if (!isOpen) return undefined;

		const handleKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				e.preventDefault();
				onClose();
				return;
			}

			if (e.key === "Tab" && contentRef.current) {
				const focusableElements =
					contentRef.current.querySelectorAll<HTMLElement>(
						'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
					);
				if (focusableElements.length === 0) return;

				const firstElement = focusableElements[0];
				const lastElement = focusableElements[focusableElements.length - 1];

				if (e.shiftKey) {
					if (document.activeElement === firstElement && lastElement) {
						lastElement.focus();
						e.preventDefault();
					}
				} else {
					if (document.activeElement === lastElement && firstElement) {
						firstElement.focus();
						e.preventDefault();
					}
				}
			}
		};

		window.addEventListener("keydown", handleKeyDown);
		return () => window.removeEventListener("keydown", handleKeyDown);
	}, [isOpen, onClose]);

	if (!isOpen) return null;

	return (
		<div className="accessible-modal-overlay" data-testid="modal-overlay">
			<div
				ref={overlayRef}
				onClick={onClose}
				className="accessible-modal-backdrop"
				aria-hidden="true"
			/>
			<div
				ref={contentRef}
				role="dialog"
				aria-modal="true"
				aria-labelledby={titleId}
				aria-describedby={description ? descriptionId : undefined}
				tabIndex={-1}
				className={`accessible-modal-content modal-variant-${variant} ${className}`}
				data-testid="modal-content"
			>
				<header className="modal-header">
					<h2 id={titleId} className="modal-title">
						{title}
					</h2>
					<button
						type="button"
						onClick={onClose}
						className="modal-close-btn"
						aria-label="Kapat"
						data-testid="modal-close-btn"
					>
						✕
					</button>
				</header>
				{description && (
					<p id={descriptionId} className="sr-only">
						{description}
					</p>
				)}
				<div className="modal-body">{children}</div>
			</div>
		</div>
	);
}
