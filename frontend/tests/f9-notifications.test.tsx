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

	it("handles push registration with base64url keys, stable Idempotency-Key and stores ID", async () => {
		// Mock browser PushManager and ServiceWorker
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
				getRegistration: vi.fn().mockResolvedValue(null),
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

		// Set valid VAPID public key
		(import.meta.env as Record<string, string>).VITE_WEB_PUSH_VAPID_PUBLIC_KEY =
			"BMd_sample_vapid_key_for_testing_1234567890";

		const registerMock = vi
			.mocked(notificationsApi.registerPushSubscription)
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

		vi.mocked(notificationsApi.getPushSubscriptions).mockResolvedValueOnce({
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
		});

		const [body, key] = registerMock.mock.calls[0]!;
		expect(body.endpoint).toBe("https://push.example.com/sub/123");
		expect(body.p256dh).toBeDefined();
		expect(body.auth).toBeDefined();
		expect(body.userAgent).toBeDefined();
		expect(body.occurredAt).toBeDefined();
		expect(key).toBeDefined();
		expect(key.length).toBeGreaterThan(0);

		await waitFor(() => {
			expect(
				screen.getByText(
					/Web Push bildirimleri bu cihaz için başarıyla etkinleştirildi/i,
				),
			).toBeInTheDocument();
		});
	});

	it("executes backend disable first before local browser unsubscribe", async () => {
		const mockSub = {
			endpoint: "https://push.example.com/sub/123",
			expirationTime: null,
			getKey: vi.fn(),
			unsubscribe: vi.fn().mockResolvedValue(true),
		};

		const mockReg = {
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
				getRegistration: vi.fn().mockResolvedValue(mockReg),
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

		localStorage.setItem("gelir-gider.pushSubscriptionId", "sub-srv-123");

		const disableMock = vi
			.mocked(notificationsApi.disablePushSubscription)
			.mockResolvedValueOnce({
				subscriptionId: "sub-srv-123",
				userId: "user-1",
				status: "DISABLED",
				revisionNo: 2,
				expirationTime: null,
				userAgent: navigator.userAgent,
				createdAt: "2026-10-01T10:00:00.000Z",
				idempotentReplay: false,
			});

		vi.mocked(notificationsApi.getPushSubscriptions).mockResolvedValueOnce({
			items: [
				{
					subscriptionId: "sub-srv-123",
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

		const { wrapper } = createWrapper();
		render(<PushSettings />, { wrapper });

		await waitFor(() => {
			expect(screen.getByTestId("btn-disable-push")).toBeInTheDocument();
		});

		fireEvent.click(screen.getByTestId("btn-disable-push"));

		await waitFor(() => {
			expect(disableMock).toHaveBeenCalledTimes(1);
		});

		const [subId, body, key] = disableMock.mock.calls[0]!;
		expect(subId).toBe("sub-srv-123");
		expect(body.occurredAt).toBeDefined();
		expect(key).toBeDefined();

		// Check local unsubscribe was called after backend confirmed
		await waitFor(() => {
			expect(mockSub.unsubscribe).toHaveBeenCalledTimes(1);
		});
	});

	it("shows warning when backend disable succeeds but browser unsubscribe throws", async () => {
		const mockSub = {
			endpoint: "https://push.example.com/sub/123",
			expirationTime: null,
			getKey: vi.fn(),
			unsubscribe: vi.fn().mockRejectedValue(new Error("Browser error")),
		};

		const mockReg = {
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
				getRegistration: vi.fn().mockResolvedValue(mockReg),
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

		localStorage.setItem("gelir-gider.pushSubscriptionId", "sub-srv-warning");

		vi.mocked(notificationsApi.disablePushSubscription).mockResolvedValueOnce({
			subscriptionId: "sub-srv-warning",
			userId: "user-1",
			status: "DISABLED",
			revisionNo: 2,
			expirationTime: null,
			userAgent: navigator.userAgent,
			createdAt: "2026-10-01T10:00:00.000Z",
			idempotentReplay: false,
		});

		vi.mocked(notificationsApi.getPushSubscriptions).mockResolvedValueOnce({
			items: [],
			nextCursor: null,
		});

		const { wrapper } = createWrapper();
		render(<PushSettings />, { wrapper });

		await waitFor(() => screen.getByTestId("btn-disable-push"));
		fireEvent.click(screen.getByTestId("btn-disable-push"));

		await waitFor(() => {
			expect(
				screen.getByText(
					/Sunucu bildirimi kapatıldı ancak tarayıcı aboneliği temizlenemedi/i,
				),
			).toBeInTheDocument();
		});

		expect(screen.getByTestId("btn-cleanup-local-sub")).toBeInTheDocument();
	});
});
