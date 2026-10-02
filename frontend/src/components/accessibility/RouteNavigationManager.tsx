import { useRouter, useRouterState } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";

const EXACT_TITLES: Record<string, string> = {
	"/": "Ana Sayfa",
	"/unlock": "Giriş Yap",
	"/transactions": "Hareketler",
	"/manual-expenses/new": "Yeni Nakit / Banka Harcaması",
	"/cards": "Kredi Kartları",
	"/cards/new": "Yeni Kredi Kartı",
	"/people": "Kişiler",
	"/people/new": "Yeni Kişi",
	"/goals": "Hedefler",
	"/goals/new": "Yeni Hedef",
	"/midas": "Midas Likidite",
	"/long-term": "Uzun Vadeli Yatırım",
	"/long-term/new": "Yeni Yatırım Görevi",
	"/income": "Gelirler",
	"/income/sources/new": "Yeni Gelir Kaynağı",
	"/income/entitlements/new": "Yeni Beklenen Gelir",
	"/income/receipts/new": "Yeni Gelir Tahsilatı",
	"/month-close": "Ayı Tamamla",
	"/month-close/wizard": "Ay Kapanış Sihirbazı",
	"/imports": "İçe Aktar",
	"/notifications": "Bildirimler",
	"/settings/quick-templates": "Hızlı Kayıt Şablonları",
};

export function getRouteTitle(pathname: string): string {
	if (EXACT_TITLES[pathname]) return EXACT_TITLES[pathname];
	if (pathname.includes("/statements/new")) return "Yeni Ekstre";
	if (pathname.includes("/statements/")) return "Ekstre Detayı";
	if (pathname.includes("/purchases/new")) return "Yeni Kart Harcaması";
	if (pathname.includes("/split")) return "Harcama Bölüştürme";
	if (pathname.includes("/purchases/")) return "Kart Harcaması Detayı";
	if (pathname.includes("/obligations/new")) return "Yeni Borç / Alacak Kaydı";
	if (pathname.includes("/obligations/")) return "Borç / Alacak Detayı";
	if (pathname.includes("/settle")) return "Borç / Alacak Kapatma";
	if (pathname.includes("/review")) return "İçe Aktarma İnceleme";
	if (pathname.startsWith("/transactions/")) return "İşlem Detayı";
	if (pathname.startsWith("/cards/")) return "Kart Detayı";
	if (pathname.startsWith("/people/")) return "Kişi Detayı";
	if (pathname.startsWith("/goals/")) return "Hedef Detayı";
	if (pathname.startsWith("/long-term/")) return "Yatırım Görevi Detayı";
	if (pathname.startsWith("/income/entitlements/"))
		return "Beklenen Gelir Detayı";
	if (pathname.startsWith("/income/receipts/")) return "Gelir Tahsilatı Detayı";
	if (pathname.startsWith("/month-close/")) return "Ay Kapanış Detayı";
	if (pathname.startsWith("/imports/")) return "İçe Aktarma Detayı";
	if (pathname.includes("/manual-expenses/") && pathname.endsWith("/edit"))
		return "Harcamayı Düzenle";
	return "Gelir-Gider";
}

export function RouteNavigationManager() {
	const router = useRouter({ warn: false });
	if (!router) {
		return null;
	}
	return <RouteNavigationManagerInner />;
}

function RouteNavigationManagerInner() {
	const routerState = useRouterState();
	const currentPath = routerState.location.pathname;
	const [announcement, setAnnouncement] = useState("");
	const previousPathRef = useRef(currentPath);

	useEffect(() => {
		if (previousPathRef.current === currentPath) return;
		previousPathRef.current = currentPath;

		const title = getRouteTitle(currentPath);
		document.title = `${title} — Gelir-Gider`;
		setAnnouncement(title);

		// Manage focus: do not steal if a modal/dialog is currently active
		const hasActiveModal = document.querySelector(
			'[role="dialog"][aria-modal="true"]',
		);
		if (!hasActiveModal) {
			requestAnimationFrame(() => {
				const mainContent = document.querySelector<HTMLElement>(
					"main.app-content-scroll",
				);
				if (mainContent) {
					mainContent.focus({ preventScroll: true });
				} else {
					const h1 = document.querySelector<HTMLElement>("h1");
					h1?.focus({ preventScroll: true });
				}
			});
		}
	}, [currentPath]);

	return (
		<div
			role="status"
			aria-live="polite"
			aria-atomic="true"
			className="sr-route-announcer"
			data-testid="route-announcer"
		>
			{announcement ? `${announcement} sayfasına gidildi` : ""}
		</div>
	);
}
