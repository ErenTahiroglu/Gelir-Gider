import { Download } from "lucide-react";

export interface PwaInstallButtonProps {
	canInstall: boolean;
	onInstall: () => void;
	className?: string;
}

export function PwaInstallButton({
	canInstall,
	onInstall,
	className = "",
}: PwaInstallButtonProps) {
	if (!canInstall) return null;

	return (
		<button
			type="button"
			className={`pwa-install-btn ${className}`.trim()}
			onClick={onInstall}
			data-testid="pwa-install-button"
			aria-label="Uygulamayı Cihaza Yükle"
		>
			<Download size={18} aria-hidden="true" />
			<span>Uygulamayı Yükle</span>
		</button>
	);
}
