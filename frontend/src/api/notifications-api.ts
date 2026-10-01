import { apiGet, apiPost } from "./client";
import type {
	DisablePushSubscriptionRequest,
	DisablePushSubscriptionResponse,
	NotificationEventDto,
	NotificationEventsListResponse,
	PushSubscriptionDto,
	PushSubscriptionStatus,
	PushSubscriptionsListResponse,
	RegisterPushSubscriptionRequest,
	RegisterPushSubscriptionResponse,
} from "./notifications-types";

export async function getNotificationEvents(params: {
	date: string;
	limit?: number;
	after?: string;
}): Promise<NotificationEventsListResponse> {
	const query = new URLSearchParams();
	query.set("date", params.date);
	if (params.limit !== undefined) {
		query.set("limit", String(params.limit));
	}
	if (params.after !== undefined) {
		query.set("after", params.after);
	}
	return apiGet<NotificationEventsListResponse>(
		`/notifications/events?${query.toString()}`,
	);
}

export async function getNotificationEvent(
	id: string,
): Promise<NotificationEventDto> {
	return apiGet<NotificationEventDto>(
		`/notifications/events/${encodeURIComponent(id)}`,
	);
}

export async function getPushSubscriptions(params?: {
	status?: PushSubscriptionStatus;
	limit?: number;
	after?: string;
}): Promise<PushSubscriptionsListResponse> {
	const query = new URLSearchParams();
	if (params?.status !== undefined) {
		query.set("status", params.status);
	}
	if (params?.limit !== undefined) {
		query.set("limit", String(params.limit));
	}
	if (params?.after !== undefined) {
		query.set("after", params.after);
	}
	const qs = query.toString();
	return apiGet<PushSubscriptionsListResponse>(
		`/notifications/subscriptions${qs ? `?${qs}` : ""}`,
	);
}

export async function getPushSubscription(
	id: string,
): Promise<PushSubscriptionDto> {
	return apiGet<PushSubscriptionDto>(
		`/notifications/subscriptions/${encodeURIComponent(id)}`,
	);
}

export async function registerPushSubscription(
	body: RegisterPushSubscriptionRequest,
	idempotencyKey: string,
): Promise<RegisterPushSubscriptionResponse> {
	return apiPost<RegisterPushSubscriptionResponse>(
		"/notifications/subscriptions",
		body,
		{
			headers: {
				"Idempotency-Key": idempotencyKey,
			},
		},
	);
}

export async function disablePushSubscription(
	id: string,
	body: DisablePushSubscriptionRequest,
	idempotencyKey: string,
): Promise<DisablePushSubscriptionResponse> {
	return apiPost<DisablePushSubscriptionResponse>(
		`/notifications/subscriptions/${encodeURIComponent(id)}/disable`,
		body,
		{
			headers: {
				"Idempotency-Key": idempotencyKey,
			},
		},
	);
}
