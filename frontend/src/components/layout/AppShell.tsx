import React, { Suspense, useCallback, useState } from "react";
import {
	QuickEntryProvider,
	useQuickEntry,
} from "../../context/QuickEntryContext";
import { usePwa } from "../../lib/pwa/usePwa";
import { RouteNavigationManager } from "../accessibility/RouteNavigationManager";
import { CommandPaletteHost } from "../command-palette/CommandPaletteHost";
import { PwaUpdatePrompt } from "../pwa/PwaUpdatePrompt";
import { MobileNav } from "./MobileNav";
import { TopBar } from "./TopBar";

const SIDEBAR_STORAGE_KEY = "gelir_gider_sidebar_collapsed";

const LazyDesktopSidebar = React.lazy(() =>
	import("./DesktopSidebar").then((m) => ({ default: m.DesktopSidebar })),
);

const LazyQuickEntrySheet = React.lazy(() =>
	import("../quick-entry/QuickEntrySheet").then((m) => ({
		default: m.QuickEntrySheet,
	})),
);

function LazyQuickEntryHost() {
	const { isOpen } = useQuickEntry();
	if (!isOpen) return null;
	return (
		<Suspense fallback={null}>
			<LazyQuickEntrySheet />
		</Suspense>
	);
}

export function AppShell({ children }: { children: React.ReactNode }) {
	const [collapsed, setCollapsed] = useState<boolean>(() => {
		try {
			return localStorage.getItem(SIDEBAR_STORAGE_KEY) === "true";
		} catch {
			return false;
		}
	});

	const { needRefresh, updateApp, dismissUpdate } = usePwa();

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
		<QuickEntryProvider>
			<RouteNavigationManager />
			<div
				className={`app-container ${collapsed ? "sidebar-collapsed" : "sidebar-expanded"}`}
				data-testid="app-shell"
			>
				<Suspense fallback={null}>
					<LazyDesktopSidebar
						collapsed={collapsed}
						onToggleCollapse={handleToggleCollapse}
					/>
				</Suspense>

				<div className="app-main-area">
					<TopBar />

					<main className="app-content-scroll" tabIndex={-1}>
						<div className="content-container">{children}</div>
					</main>
				</div>

				<MobileNav />
				<LazyQuickEntryHost />
				<CommandPaletteHost />
				<PwaUpdatePrompt
					needRefresh={needRefresh}
					onUpdate={updateApp}
					onDismiss={dismissUpdate}
				/>
			</div>
		</QuickEntryProvider>
	);
}
