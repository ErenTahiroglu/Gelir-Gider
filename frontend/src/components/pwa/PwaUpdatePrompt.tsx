import { RefreshCw, X } from "lucide-react";

export interface PwaUpdatePromptProps {
	needRefresh: boolean;
	onUpdate: () => void;
	onDismiss: () => void;
}

export function PwaUpdatePrompt({
	needRefresh,
	onUpdate,
	onDismiss,
}: PwaUpdatePromptProps) {
	if (!needRefresh) return null;

	return (
		<aside
			className="pwa-update-banner"
			role="status"
			aria-live="polite"
			data-testid="pwa-update-prompt"
		>
			<div className="pwa-update-content">
				<RefreshCw size={18} className="pwa-update-icon" aria-hidden="true" />
				<span className="pwa-update-text">Yeni sürüm hazır.</span>
			</div>
			<div className="pwa-update-actions">
				<button
					type="button"
					className="btn btn-sm btn-primary pwa-update-btn-refresh"
					onClick={onUpdate}
					data-testid="pwa-update-refresh-btn"
				>
					Şimdi Yenile
				</button>
				<button
					type="button"
					className="btn btn-sm btn-ghost pwa-update-btn-dismiss"
					onClick={onDismiss}
					data-testid="pwa-update-dismiss-btn"
					aria-label="Kapat"
				>
					<X size={16} aria-hidden="true" />
					<span>Sonra</span>
				</button>
			</div>
		</aside>
	);
}
