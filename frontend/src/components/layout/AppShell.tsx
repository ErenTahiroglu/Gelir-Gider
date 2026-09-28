import type React from "react";
import { useCallback, useState } from "react";
import { DesktopSidebar } from "./DesktopSidebar";
import { MobileNav } from "./MobileNav";
import { TopBar } from "./TopBar";

const SIDEBAR_STORAGE_KEY = "gelir_gider_sidebar_collapsed";

export function AppShell({ children }: { children: React.ReactNode }) {
	const [collapsed, setCollapsed] = useState<boolean>(() => {
		try {
			return localStorage.getItem(SIDEBAR_STORAGE_KEY) === "true";
		} catch {
			return false;
		}
	});

	const handleToggleCollapse = useCallback(() => {
		setCollapsed((prev) => {
			const next = !prev;
			try {
				localStorage.setItem(SIDEBAR_STORAGE_KEY, String(next));
			} catch {
				// Ignore storage quota/permission errors
			}
			return next;
		});
	}, []);

	return (
		<div
			className={`app-container ${collapsed ? "sidebar-collapsed" : "sidebar-expanded"}`}
			data-testid="app-shell"
		>
			<DesktopSidebar
				collapsed={collapsed}
				onToggleCollapse={handleToggleCollapse}
			/>

			<div className="app-main-area">
				<TopBar />

				<main className="app-content-scroll" tabIndex={-1}>
					<div className="content-container">{children}</div>
				</main>
			</div>

			<MobileNav />
		</div>
	);
}
