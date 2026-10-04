import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import type React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../src/api/errors";
import * as notificationsApi from "../src/api/notifications-api";
import type {
	NotificationEventDto,
	PushSubscriptionDto,
} from "../src/api/notifications-types";
import { NotificationEventList } from "../src/components/notifications/NotificationEventList";
import { NotificationsPage } from "../src/components/notifications/NotificationsPage";
import { PushSettings } from "../src/components/notifications/PushSettings";
import {
	arrayBufferToBase64Url,
	sanitizeDeepLink,
	urlBase64ToUint8Array,
} from "../src/lib/web-push";

vi.mock("../src/api/notifications-api");

// Mock tanstack router
vi.mock("@tanstack/react-router", () => ({
	Link: ({ children, to, ...props }: any) => (
		<a href={to} {...props}>
			{children}
		</a>
	),
	useNavigate: () => vi.fn(),
	useParams: () => ({}),
	useSearch: () => ({}),
}));

function createWrapper() {
	const queryClient = new QueryClient({
		defaultOptions: {
			queries: { retry: false },
			mutations: { retry: false },
		},
	});
	return {
		queryClient,
		wrapper: ({ children }: { children: React.ReactNode }) => (
			<QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
		),
	};
}

describe("F9 — Notification Center & Web Push Test Suite", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		localStorage.clear();
	});

	afterEach(() => {
		cleanup();
	});

	it("queries notification events with date=YYYY-MM-DD in Europe/Istanbul", async () => {
		const getEventsMock = vi
			.mocked(notificationsApi.getNotificationEvents)
			.mockResolvedValueOnce({
				items: [
					{
						id: "evt-1",
						userId: "user-1",
						notificationType: "CREDIT_CARD_DUE",
						subjectId: "card-1",
						scheduledLocalDate: "2026-10-01",
						scheduledFor: "2026-10-01T08:00:00.000Z",
						createdAt: "2026-10-01T08:00:00.000Z",
					},
				],
				nextCursor: null,
			});

		const { wrapper } = createWrapper();
		render(<NotificationEventList />, { wrapper });

		await waitFor(() => {
			expect(getEventsMock).toHaveBeenCalledTimes(1);
		});

		const callArg = getEventsMock.mock.calls[0]![0];
		expect(callArg.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
		expect(callArg.limit).toBe(50);
	});

	it("preserves privacy by rendering generic safe copy without financial amounts or unread state", async () => {
		vi.mocked(notificationsApi.getNotificationEvents).mockResolvedValueOnce({
			items: [
				{
					id: "evt-1",
					userId: "user-1",
					notificationType: "CREDIT_CARD_DUE",
					subjectId: "card-1",
					scheduledLocalDate: "2026-10-01",
					scheduledFor: "2026-10-01T08:00:00.000Z",
					createdAt: "2026-10-01T08:00:00.000Z",
				},
				{
					id: "evt-2",
					userId: "user-1",
					notificationType: "BUDGET_THRESHOLD",
					subjectId: "budget-1",
					scheduledLocalDate: "2026-10-01",
					scheduledFor: "2026-10-01T09:00:00.000Z",
					createdAt: "2026-10-01T09:00:00.000Z",
				},
				{
					id: "evt-3",
					userId: "user-1",
					notificationType: "NO_SPEND_CHECK",
					subjectId: "check-1",
					scheduledLocalDate: "2026-10-01",
					scheduledFor: "2026-10-01T20:00:00.000Z",
					createdAt: "2026-10-01T20:00:00.000Z",
				},
			],
			nextCursor: null,
		});

		const { wrapper } = createWrapper();
		render(<NotificationEventList />, { wrapper });

		await waitFor(() => {
			expect(
				screen.getByText(/Kredi kartı ödeme günü bildirimi planlandı/i),
			).toBeInTheDocument();
			expect(
				screen.getByText(/Aylık harcama eşiği bildirimi oluşturuldu/i),
			).toBeInTheDocument();
			expect(
				screen.getByText(/Günlük harcama kontrolü oluşturuldu/i),
			).toBeInTheDocument();
		});

		// Assert NO unread controls or fake badge
		expect(
			screen.queryByText(/Okundu Olarak İşaretle/i),
		).not.toBeInTheDocument();
		expect(screen.queryByText(/Okunmamış/i)).not.toBeInTheDocument();
		// Assert NO money symbols in event cards
		expect(screen.queryByText(/₺/)).not.toBeInTheDocument();
	});

	it("converts public keys and buffers correctly with base64url encoding", () => {
		const testBytes = new Uint8Array([72, 101, 108, 108, 111]); // "Hello"
		const b64url = arrayBufferToBase64Url(testBytes.buffer);
		expect(b64url).toBe("SGVsbG8");
		expect(b64url).not.toContain("=");
		expect(b64url).not.toContain("+");
		expect(b64url).not.toContain("/");

		const decoded = urlBase64ToUint8Array("SGVsbG8");
		expect(Array.from(decoded)).toEqual([72, 101, 108, 108, 111]);
	});

	it("sanitizes deep links strictly allowing only same-origin relative paths", () => {
		expect(sanitizeDeepLink("/cards")).toBe("/cards");
		expect(sanitizeDeepLink("/cards?id=1#details")).toBe("/cards?id=1#details");
		expect(sanitizeDeepLink("https://evil.test/x")).toBe("/");
		expect(sanitizeDeepLink("//evil.test/x")).toBe("/");
		expect(sanitizeDeepLink("\\evil.test/x")).toBe("/");
		expect(sanitizeDeepLink("javascript:alert(1)")).toBe("/");
		expect(sanitizeDeepLink(null)).toBe("/");
		expect(sanitizeDeepLink(undefined)).toBe("/");
		expect(sanitizeDeepLink(123)).toBe("/");
	});

	it("register network uncertainty does NOT claim active and allows exact retry", async () => {
		const mockSub = {
			endpoint: "https://push.example.com/sub/123",
			expirationTime: null,
			getKey: vi.fn((name: string) => {
				if (name === "p256dh") return new Uint8Array([1, 2, 3, 4]).buffer;
				if (name === "auth") return new Uint8Array([5, 6, 7, 8]).buffer;
				return null;
			}),
			unsubscribe: vi.fn().mockResolvedValue(true),
		};

		const mockReg = {
			scope: `${window.location.origin}/push/`,
			active: { state: "activated" },
			pushManager: {
				getSubscription: vi.fn().mockResolvedValue(null),
				subscribe: vi.fn().mockResolvedValue(mockSub),
			},
		};

		Object.defineProperty(window, "isSecureContext", {
			value: true,
			writable: true,
		});
		Object.defineProperty(navigator, "serviceWorker", {
			value: {
				getRegistrations: vi.fn().mockResolvedValue([]),
				register: vi.fn().mockResolvedValue(mockReg),
			},
			writable: true,
		});
		Object.defineProperty(window, "PushManager", {
			value: class PushManager {},
			writable: true,
		});
		Object.defineProperty(window, "Notification", {
			value: {
				permission: "granted",
				requestPermission: vi.fn().mockResolvedValue("granted"),
			},
			writable: true,
		});

		(import.meta.env as Record<string, string>).VITE_WEB_PUSH_VAPID_PUBLIC_KEY =
			"BMd_sample_vapid_key_for_testing_1234567890";

		const registerMock = vi
			.mocked(notificationsApi.registerPushSubscription)
			.mockRejectedValueOnce(
				new ApiError({
					status: 0,
					code: "NETWORK_ERROR",
					message: "Network uncertain",
				}),
			)
			.mockResolvedValueOnce({
				subscriptionId: "sub-srv-123",
				userId: "user-1",
				status: "ACTIVE",
				revisionNo: 1,
				expirationTime: null,
				userAgent: "mock",
				createdAt: "2026-10-01T10:00:00.000Z",
				idempotentReplay: false,
			});

		vi.mocked(notificationsApi.getPushSubscriptions).mockResolvedValue({
			items: [],
			nextCursor: null,
		});

		const { wrapper } = createWrapper();
		render(<PushSettings />, { wrapper });

		await waitFor(() => {
			expect(screen.getByTestId("btn-enable-push")).toBeInTheDocument();
		});

		fireEvent.click(screen.getByTestId("btn-enable-push"));

		await waitFor(() => {
			expect(registerMock).toHaveBeenCalledTimes(1);
			expect(screen.getByTestId("btn-retry-register")).toBeInTheDocument();
		});

		// UI must NOT claim Bildirimler açık
		expect(screen.queryByText(/Bildirimler açık\./i)).not.toBeInTheDocument();

		const [body1, key1] = registerMock.mock.calls[0]!;

		// Click retry
		fireEvent.click(screen.getByTestId("btn-retry-register"));

		await waitFor(() => {
			expect(registerMock).toHaveBeenCalledTimes(2);
		});

		const [body2, key2] = registerMock.mock.calls[1]!;
		expect(key2).toBe(key1);
		expect(body2).toEqual(body1);
		// subscribe was called at most once
		expect(mockReg.pushManager.subscribe).toHaveBeenCalledTimes(1);
	});

	it("deterministic register rejection clears frozen state without masquerading as uncertainty", async () => {
		const mockSub = {
			endpoint: "https://push.example.com/sub/456",
			expirationTime: null,
			getKey: vi.fn((name: string) => {
				if (name === "p256dh") return new Uint8Array([1, 2, 3, 4]).buffer;
				if (name === "auth") return new Uint8Array([5, 6, 7, 8]).buffer;
				return null;
			}),
			unsubscribe: vi.fn().mockResolvedValue(true),
		};

		const mockReg = {
			scope: `${window.location.origin}/push/`,
			active: { state: "activated" },
			pushManager: {
				getSubscription: vi.fn().mockResolvedValue(null),
				subscribe: vi.fn().mockResolvedValue(mockSub),
			},
		};

		Object.defineProperty(window, "isSecureContext", {
			value: true,
			writable: true,
		});
		Object.defineProperty(navigator, "serviceWorker", {
			value: {
				getRegistrations: vi.fn().mockResolvedValue([]),
				register: vi.fn().mockResolvedValue(mockReg),
			},
			writable: true,
		});
		Object.defineProperty(window, "PushManager", {
			value: class PushManager {},
			writable: true,
		});
		Object.defineProperty(window, "Notification", {
			value: {
				permission: "granted",
				requestPermission: vi.fn().mockResolvedValue("granted"),
			},
			writable: true,
		});

		(import.meta.env as Record<string, string>).VITE_WEB_PUSH_VAPID_PUBLIC_KEY =
			"BMd_sample_vapid_key_for_testing_1234567890";

		const registerMock = vi
			.mocked(notificationsApi.registerPushSubscription)
			.mockRejectedValueOnce(
				new ApiError({
					status: 400,
					code: "NOTIFICATION_INVALID_INPUT",
					message: "Invalid subscription payload",
				}),
			)
			.mockResolvedValueOnce({
				subscriptionId: "sub-srv-456",
				userId: "user-1",
				status: "ACTIVE",
				revisionNo: 1,
				expirationTime: null,
				userAgent: "mock",
				createdAt: "2026-10-01T10:00:00.000Z",
				idempotentReplay: false,
			});

		vi.mocked(notificationsApi.getPushSubscriptions).mockResolvedValue({
			items: [],
			nextCursor: null,
		});

		const { wrapper } = createWrapper();
		render(<PushSettings />, { wrapper });

		await waitFor(() => {
			expect(screen.getByTestId("btn-enable-push")).toBeInTheDocument();
		});

		fireEvent.click(screen.getByTestId("btn-enable-push"));

		await waitFor(() => {
			expect(registerMock).toHaveBeenCalledTimes(1);
			expect(screen.getByTestId("push-status-alert")).toHaveTextContent(
				/Bildirim aboneliği oluşturulamadı/i,
			);
		});

		// No retry box because error is deterministic
		expect(screen.queryByTestId("btn-retry-register")).not.toBeInTheDocument();

		const key1 = registerMock.mock.calls[0]![1];

		// Next attempt must generate a new key
		fireEvent.click(screen.getByTestId("btn-match-server"));

		await waitFor(() => {
			expect(registerMock).toHaveBeenCalledTimes(2);
		});

		const key2 = registerMock.mock.calls[1]![1];
		expect(key2).not.toBe(key1);
	});

	it("local PushSubscription alone does not mean ACTIVE; requires confirmed server ACTIVE status", async () => {
		const mockSub = {
			endpoint: "https://push.example.com/sub/unverified",
			expirationTime: null,
			getKey: vi.fn(),
			unsubscribe: vi.fn().mockResolvedValue(true),
		};

		const mockReg = {
			scope: `${window.location.origin}/push/`,
			active: { state: "activated" },
			pushManager: {
				getSubscription: vi.fn().mockResolvedValue(mockSub),
			},
		};

		Object.defineProperty(window, "isSecureContext", {
			value: true,
			writable: true,
		});
		Object.defineProperty(navigator, "serviceWorker", {
			value: {
				getRegistrations: vi.fn().mockResolvedValue([mockReg]),
			},
			writable: true,
		});
		Object.defineProperty(window, "PushManager", {
			value: class PushManager {},
			writable: true,
		});
		Object.defineProperty(window, "Notification", {
			value: { permission: "granted" },
			writable: true,
		});

		(import.meta.env as Record<string, string>).VITE_WEB_PUSH_VAPID_PUBLIC_KEY =
			"BMd_sample_vapid_key_for_testing_1234567890";

		// No stored ID in localStorage
		vi.mocked(notificationsApi.getPushSubscriptions).mockResolvedValue({
			items: [],
			nextCursor: null,
		});

		const { wrapper } = createWrapper();
		render(<PushSettings />, { wrapper });

		await waitFor(() => {
			expect(
				screen.getByText(
					/Tarayıcı aboneliği var ancak sunucu bağlantısı doğrulanmadı/i,
				),
			).toBeInTheDocument();
		});

		expect(screen.queryByText(/Bildirimler açık\./i)).not.toBeInTheDocument();
		expect(screen.getByTestId("btn-match-server")).toBeInTheDocument();
	});

	it("exact stored subscription ID + server ACTIVE means confirmed ACTIVE", async () => {
		const mockSub = {
			endpoint: "https://push.example.com/sub/active",
			expirationTime: null,
			getKey: vi.fn(),
			unsubscribe: vi.fn().mockResolvedValue(true),
		};

		const mockReg = {
			scope: `${window.location.origin}/push/`,
			active: { state: "activated" },
			pushManager: {
				getSubscription: vi.fn().mockResolvedValue(mockSub),
			},
		};

		Object.defineProperty(window, "isSecureContext", {
			value: true,
			writable: true,
		});
		Object.defineProperty(navigator, "serviceWorker", {
			value: {
				getRegistrations: vi.fn().mockResolvedValue([mockReg]),
			},
			writable: true,
		});
		Object.defineProperty(window, "PushManager", {
			value: class PushManager {},
			writable: true,
		});
		Object.defineProperty(window, "Notification", {
			value: { permission: "granted" },
			writable: true,
		});

		(import.meta.env as Record<string, string>).VITE_WEB_PUSH_VAPID_PUBLIC_KEY =
			"BMd_sample_vapid_key_for_testing_1234567890";

		localStorage.setItem("gelir-gider.pushSubscriptionId", "sub-active-123");

		vi.mocked(notificationsApi.getPushSubscription).mockResolvedValueOnce({
			subscriptionId: "sub-active-123",
			userId: "user-1",
			status: "ACTIVE",
			revisionNo: 1,
			expirationTime: null,
			userAgent: "test",
			createdAt: "2026-10-01T10:00:00.000Z",
		});

		vi.mocked(notificationsApi.getPushSubscriptions).mockResolvedValue({
			items: [
				{
					subscriptionId: "sub-active-123",
					userId: "user-1",
					status: "ACTIVE",
					revisionNo: 1,
					expirationTime: null,
					userAgent: "test",
					createdAt: "2026-10-01T10:00:00.000Z",
				},
			],
			nextCursor: null,
		});

		const { wrapper } = createWrapper();
		render(<PushSettings />, { wrapper });

		await waitFor(() => {
			expect(
				screen.getByText(/Bildirimler açık\. Ödeme hatırlatmaları/i),
			).toBeInTheDocument();
		});

		expect(screen.getByTestId("btn-disable-push")).toBeInTheDocument();
	});

	it("exact stored subscription ID + server DISABLED means NOT active", async () => {
		const mockSub = {
			endpoint: "https://push.example.com/sub/disabled",
			expirationTime: null,
			getKey: vi.fn(),
			unsubscribe: vi.fn().mockResolvedValue(true),
		};

		const mockReg = {
			scope: `${window.location.origin}/push/`,
			active: { state: "activated" },
			pushManager: {
				getSubscription: vi.fn().mockResolvedValue(mockSub),
			},
		};

		Object.defineProperty(window, "isSecureContext", {
			value: true,
			writable: true,
		});
		Object.defineProperty(navigator, "serviceWorker", {
			value: {
				getRegistrations: vi.fn().mockResolvedValue([mockReg]),
			},
			writable: true,
		});
		Object.defineProperty(window, "PushManager", {
			value: class PushManager {},
			writable: true,
		});
		Object.defineProperty(window, "Notification", {
			value: { permission: "granted" },
			writable: true,
		});

		(import.meta.env as Record<string, string>).VITE_WEB_PUSH_VAPID_PUBLIC_KEY =
			"BMd_sample_vapid_key_for_testing_1234567890";

		localStorage.setItem("gelir-gider.pushSubscriptionId", "sub-disabled-123");

		vi.mocked(notificationsApi.getPushSubscription).mockResolvedValueOnce({
			subscriptionId: "sub-disabled-123",
			userId: "user-1",
			status: "DISABLED",
			revisionNo: 2,
			expirationTime: null,
			userAgent: "test",
			createdAt: "2026-10-01T10:00:00.000Z",
		});

		vi.mocked(notificationsApi.getPushSubscriptions).mockResolvedValue({
			items: [
				{
					subscriptionId: "sub-disabled-123",
					userId: "user-1",
					status: "DISABLED",
					revisionNo: 2,
					expirationTime: null,
					userAgent: "test",
					createdAt: "2026-10-01T10:00:00.000Z",
				},
			],
			nextCursor: null,
		});

		const { wrapper } = createWrapper();
		render(<PushSettings />, { wrapper });

		await waitFor(() => {
			expect(
				screen.getByText(/Bildirimler sunucuda devre dışı bırakılmış/i),
			).toBeInTheDocument();
		});

		expect(screen.queryByText(/Bildirimler açık\./i)).not.toBeInTheDocument();
	});

	it("missing local server ID never guesses by userAgent and requires explicit recovery", async () => {
		const mockSub = {
			endpoint: "https://push.example.com/sub/no-guess",
			expirationTime: null,
			getKey: vi.fn((name: string) => {
				if (name === "p256dh") return new Uint8Array([1, 2, 3]).buffer;
				if (name === "auth") return new Uint8Array([4, 5, 6]).buffer;
				return null;
			}),
			unsubscribe: vi.fn().mockResolvedValue(true),
		};

		const mockReg = {
			scope: `${window.location.origin}/push/`,
			active: { state: "activated" },
			pushManager: {
				getSubscription: vi.fn().mockResolvedValue(mockSub),
				subscribe: vi.fn(),
			},
		};

		Object.defineProperty(window, "isSecureContext", {
			value: true,
			writable: true,
		});
		Object.defineProperty(navigator, "serviceWorker", {
			value: {
				getRegistrations: vi.fn().mockResolvedValue([mockReg]),
			},
			writable: true,
		});
		Object.defineProperty(window, "PushManager", {
			value: class PushManager {},
			writable: true,
		});
		Object.defineProperty(window, "Notification", {
			value: { permission: "granted" },
			writable: true,
		});

		(import.meta.env as Record<string, string>).VITE_WEB_PUSH_VAPID_PUBLIC_KEY =
			"BMd_sample_vapid_key_for_testing_1234567890";

		// Server list has items with same userAgent
		vi.mocked(notificationsApi.getPushSubscriptions).mockResolvedValue({
			items: [
				{
					subscriptionId: "sub-other-1",
					userId: "user-1",
					status: "ACTIVE",
					revisionNo: 1,
					expirationTime: null,
					userAgent: navigator.userAgent,
					createdAt: "2026-10-01T10:00:00.000Z",
				},
				{
					subscriptionId: "sub-other-2",
					userId: "user-1",
					status: "ACTIVE",
					revisionNo: 1,
					expirationTime: null,
					userAgent: navigator.userAgent,
					createdAt: "2026-10-01T10:00:00.000Z",
				},
			],
			nextCursor: null,
		});

		const registerMock = vi
			.mocked(notificationsApi.registerPushSubscription)
			.mockResolvedValueOnce({
				subscriptionId: "sub-recovered-123",
				userId: "user-1",
				status: "ACTIVE",
				revisionNo: 1,
				expirationTime: null,
				userAgent: navigator.userAgent,
				createdAt: "2026-10-01T10:00:00.000Z",
				idempotentReplay: false,
			});

		const { wrapper } = createWrapper();
		render(<PushSettings />, { wrapper });

		await waitFor(() => {
			expect(
				screen.getByText(
					/Tarayıcı aboneliği var ancak sunucu bağlantısı doğrulanmadı/i,
				),
			).toBeInTheDocument();
		});

		// Neither is marked with "Bu Cihaz" badge because stored ID is not bound
		expect(screen.queryByText(/Bu Cihaz/)).not.toBeInTheDocument();

		// Click Sunucuyla Eşleştir
		fireEvent.click(screen.getByTestId("btn-match-server"));

		await waitFor(() => {
			expect(registerMock).toHaveBeenCalledTimes(1);
		});

		// Assert subscribe() was NOT called again — existing local subscription was used
		expect(mockReg.pushManager.subscribe).not.toHaveBeenCalled();
	});

	it("disable network uncertainty allows exact retry and postpones local unsubscribe until confirmed success", async () => {
		const mockSub = {
			endpoint: "https://push.example.com/sub/disable-uncertain",
			expirationTime: null,
			getKey: vi.fn(),
			unsubscribe: vi.fn().mockResolvedValue(true),
		};

		const mockReg = {
			scope: `${window.location.origin}/push/`,
			active: { state: "activated" },
			pushManager: {
				getSubscription: vi.fn().mockResolvedValue(mockSub),
			},
		};

		Object.defineProperty(window, "isSecureContext", {
			value: true,
			writable: true,
		});
		Object.defineProperty(navigator, "serviceWorker", {
			value: {
				getRegistrations: vi.fn().mockResolvedValue([mockReg]),
			},
			writable: true,
		});
		Object.defineProperty(window, "PushManager", {
			value: class PushManager {},
			writable: true,
		});
		Object.defineProperty(window, "Notification", {
			value: { permission: "granted" },
			writable: true,
		});

		(import.meta.env as Record<string, string>).VITE_WEB_PUSH_VAPID_PUBLIC_KEY =
			"BMd_sample_vapid_key_for_testing_1234567890";

		localStorage.setItem(
			"gelir-gider.pushSubscriptionId",
			"sub-disable-uncertain-id",
		);

		vi.mocked(notificationsApi.getPushSubscription).mockResolvedValue({
			subscriptionId: "sub-disable-uncertain-id",
			userId: "user-1",
			status: "ACTIVE",
			revisionNo: 1,
			expirationTime: null,
			userAgent: "test",
			createdAt: "2026-10-01T10:00:00.000Z",
		});

		vi.mocked(notificationsApi.getPushSubscriptions).mockResolvedValue({
			items: [
				{
					subscriptionId: "sub-disable-uncertain-id",
					userId: "user-1",
					status: "ACTIVE",
					revisionNo: 1,
					expirationTime: null,
					userAgent: "test",
					createdAt: "2026-10-01T10:00:00.000Z",
				},
			],
			nextCursor: null,
		});

		const disableMock = vi
			.mocked(notificationsApi.disablePushSubscription)
			.mockRejectedValueOnce(
				new ApiError({
					status: 0,
					code: "NETWORK_ERROR",
					message: "Network uncertain",
				}),
			)
			.mockResolvedValueOnce({
				subscriptionId: "sub-disable-uncertain-id",
				userId: "user-1",
				status: "DISABLED",
				revisionNo: 2,
				expirationTime: null,
				userAgent: "test",
				createdAt: "2026-10-01T10:00:00.000Z",
				idempotentReplay: false,
			});

		const { wrapper } = createWrapper();
		render(<PushSettings />, { wrapper });

		await waitFor(() => {
			expect(screen.getByTestId("btn-disable-push")).toBeInTheDocument();
		});

		fireEvent.click(screen.getByTestId("btn-disable-push"));

		await waitFor(() => {
			expect(disableMock).toHaveBeenCalledTimes(1);
			expect(screen.getByTestId("btn-retry-disable")).toBeInTheDocument();
		});

		// Local unsubscribe MUST NOT have been called yet
		expect(mockSub.unsubscribe).not.toHaveBeenCalled();

		const [id1, body1, key1] = disableMock.mock.calls[0]!;

		// Click retry
		fireEvent.click(screen.getByTestId("btn-retry-disable"));

		await waitFor(() => {
			expect(disableMock).toHaveBeenCalledTimes(2);
		});

		const [id2, body2, key2] = disableMock.mock.calls[1]!;
		expect(id2).toBe(id1);
		expect(key2).toBe(key1);
		expect(body2).toEqual(body1);

		// Confirmed success -> local unsubscribe is now called exactly once
		await waitFor(() => {
			expect(mockSub.unsubscribe).toHaveBeenCalledTimes(1);
		});
	});
});
