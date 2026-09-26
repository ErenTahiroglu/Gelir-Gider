import { useState } from "react";
import { useAuth } from "../../auth/auth-context";

export function RecoveryCodePanel() {
	const { state, acknowledgeRecoveryCode } = useAuth();
	const [acknowledged, setAcknowledged] = useState(false);
	const [copied, setCopied] = useState(false);

	if (state.status !== "RECOVERY_CODE_REQUIRED") {
		return null;
	}

	const { recoveryCode, warning } = state;

	const handleCopy = async () => {
		try {
			if (navigator.clipboard) {
				await navigator.clipboard.writeText(recoveryCode);
				setCopied(true);
				setTimeout(() => setCopied(false), 3000);
			}
		} catch {
			// Clipboard API not permitted or available
		}
	};

	return (
		<main className="auth-surface" data-testid="recovery-code-panel">
			<div className="auth-card">
				<header className="auth-header">
					<h1 className="auth-title">Kurtarma Kodunuz</h1>
					<p className="auth-subtitle">
						Passkey erişiminizi kaybederseniz hesabınızı kurtarmak için bu koda
						ihtiyacınız olacak.
					</p>
				</header>

				{warning && (
					<div
						className="auth-alert auth-alert-warning"
						role="alert"
						data-testid="recovery-warning-alert"
					>
						{warning}
					</div>
				)}

				<div className="recovery-code-box" data-testid="recovery-code-box">
					<code className="recovery-code-text tabular-nums">
						{recoveryCode}
					</code>
				</div>

				<div className="recovery-copy-action">
					<button
						type="button"
						className="btn btn-secondary"
						onClick={() => void handleCopy()}
						data-testid="copy-recovery-code-button"
					>
						{copied ? "Kopyalandı!" : "Kodu Kopyala"}
					</button>
				</div>

				<div className="recovery-ack-section">
					<label className="checkbox-label">
						<input
							type="checkbox"
							checked={acknowledged}
							onChange={(e) => setAcknowledged(e.target.checked)}
							data-testid="recovery-ack-checkbox"
						/>
						<span>Kurtarma kodumu güvenli bir yere kaydettim.</span>
					</label>
				</div>

				<div className="auth-actions">
					<button
						type="button"
						className="btn btn-primary"
						disabled={!acknowledged}
						onClick={() => void acknowledgeRecoveryCode()}
						data-testid="acknowledge-recovery-button"
					>
						Devam Et
					</button>
				</div>
			</div>
		</main>
	);
}
