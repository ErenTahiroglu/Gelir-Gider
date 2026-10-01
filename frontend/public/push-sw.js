/**
 * GELIR-GIDER — DEDICATED PUSH SERVICE WORKER (Phase F9).
 *
 * Scope: /push/
 * Purpose: Web Push event handling and notification click navigation only.
 *
 * IMPORTANT F10 BOUNDARY NOTE:
 * Phase F10 owns full PWA capabilities (manifest, offline shell, asset caching,
 * install prompts, vite-plugin-pwa).
 * Phase F10 must preserve this F9 push registration or deliberately migrate it.
 * This worker MUST NOT intercept fetch, API requests, or static assets, and
 * MUST NOT implement offline caching.
 */

self.addEventListener("push", (event) => {
	let payload = {};
	if (event.data) {
		try {
			payload = event.data.json();
		} catch {
			try {
				payload = { body: event.data.text() };
			} catch {
				payload = {};
			}
		}
	}

	const title =
		typeof payload.title === "string" && payload.title.trim()
			? payload.title.trim()
			: "Gelir-Gider Bildirimi";

	const body =
		typeof payload.body === "string" && payload.body.trim()
			? payload.body.trim()
			: "Yeni bir bildiriminiz var.";

	// DeepLink is extracted safely — only relative paths allowed
	let deepLink = "/";
	if (
		payload.data &&
		typeof payload.data === "object" &&
		typeof payload.data.deepLink === "string" &&
		payload.data.deepLink.startsWith("/")
	) {
		deepLink = payload.data.deepLink;
	}

	const notificationOptions = {
		body,
		icon: "/favicon.ico",
		badge: "/favicon.ico",
		data: {
			deepLink,
		},
		// Privacy invariant: Never enrich notifications with financial numbers
	};

	event.waitUntil(self.registration.showNotification(title, notificationOptions));
});

self.addEventListener("notificationclick", (event) => {
	event.notification.close();

	const rawDeepLink = event.notification.data?.deepLink;
	const deepLink =
		typeof rawDeepLink === "string" && rawDeepLink.startsWith("/")
			? rawDeepLink
			: "/";

	event.waitUntil(
		self.clients
			.matchAll({ type: "window", includeUncontrolled: true })
			.then((clientList) => {
				// If a window is already open on same origin, navigate and focus it
				for (const client of clientList) {
					if ("focus" in client) {
						if ("navigate" in client) {
							void client.navigate(deepLink);
						}
						return client.focus();
					}
				}
				// Otherwise open a new window
				if (self.clients.openWindow) {
					return self.clients.openWindow(deepLink);
				}
			}),
	);
});
