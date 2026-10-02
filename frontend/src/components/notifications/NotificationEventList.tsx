import { useInfiniteQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
	AlertTriangle,
	ArrowRight,
	Bell,
	ChevronLeft,
	ChevronRight,
	Clock,
	CreditCard,
	DollarSign,
} from "lucide-react";
import { useState } from "react";
import { getNotificationEvents } from "../../api/notifications-api";
import type { NotificationEventType } from "../../api/notifications-types";
import {
	formatIstanbulDateTime,
	getIstanbulCalendarDate,
} from "../../lib/istanbul-date";

function getNotificationTypeDetails(type: NotificationEventType): {
	title: string;
	description: string;
	link: string;
	linkLabel: string;
	icon: React.ReactNode;
} {
	switch (type) {
		case "CREDIT_CARD_DUE":
			return {
				title: "Kredi Kartı Ödeme Günü",
				description: "Kredi kartı ödeme günü bildirimi planlandı.",
				link: "/cards",
				linkLabel: "Kartları İncele",
				icon: <CreditCard size={18} aria-hidden="true" />,
			};
		case "CREDIT_CARD_DUE_SOON":
			return {
				title: "Kredi Kartı Ödeme Hatırlatması",
				description: "Kredi kartı ödemesi yaklaşıyor.",
				link: "/cards",
				linkLabel: "Kartları İncele",
				icon: <Clock size={18} aria-hidden="true" />,
			};
		case "BUDGET_THRESHOLD":
			return {
				title: "Aylık Harcama Eşiği",
				description: "Aylık harcama eşiği bildirimi oluşturuldu.",
				link: "/",
				linkLabel: "Özete Git",
				icon: <AlertTriangle size={18} aria-hidden="true" />,
			};
		case "NO_SPEND_CHECK":
			return {
				title: "Günlük Harcama Kontrolü",
				description: "Günlük harcama kontrolü oluşturuldu.",
				link: "/transactions",
				linkLabel: "Hareketlere Git",
				icon: <DollarSign size={18} aria-hidden="true" />,
			};
		default:
			return {
				title: "Bildirim",
				description: "Sistem bildirimi planlandı.",
				link: "/",
				linkLabel: "Ana Sayfa",
				icon: <Bell size={18} aria-hidden="true" />,
			};
	}
}

function shiftDateString(dateStr: string, deltaDays: number): string {
	const parts = dateStr.split("-").map(Number);
	const year = parts[0];
	const month = parts[1];
	const day = parts[2];
	if (!year || !month || !day) return dateStr;
	const d = new Date(Date.UTC(year, month - 1, day));
	d.setUTCDate(d.getUTCDate() + deltaDays);
	const y = d.getUTCFullYear();
	const m = String(d.getUTCMonth() + 1).padStart(2, "0");
	const dayStr = String(d.getUTCDate()).padStart(2, "0");
	return `${y}-${m}-${dayStr}`;
}

export function NotificationEventList() {
	const todayDateString = getIstanbulCalendarDate().dateString;
	const [selectedDate, setSelectedDate] = useState<string>(todayDateString);

	const eventsQuery = useInfiniteQuery({
		queryKey: ["notification-events", selectedDate],
		queryFn: ({ pageParam }) =>
			getNotificationEvents({
				date: selectedDate,
				limit: 50,
				...(pageParam ? { after: pageParam } : {}),
			}),
		initialPageParam: undefined as string | undefined,
		getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
		enabled: !!selectedDate,
	});

	const allEvents = eventsQuery.data?.pages.flatMap((page) => page.items) ?? [];
	const isToday = selectedDate === todayDateString;

	return (
		<div
			className="notification-event-list-section"
			data-testid="notification-events-section"
		>
			<div className="section-header">
				<div>
					<h2 className="section-title">Bildirim Geçmişi</h2>
					<span className="section-subtitle">
						{isToday
							? "Bugünkü bildirimler"
							: `${selectedDate} tarihli bildirimler`}
					</span>
				</div>

				<div className="date-navigation-controls" data-testid="date-navigation">
					<button
						type="button"
						className="btn btn-icon btn-secondary btn-sm"
						onClick={() => setSelectedDate((d) => shiftDateString(d, -1))}
						aria-label="Önceki Gün"
						data-testid="btn-prev-day"
					>
						<ChevronLeft size={18} aria-hidden="true" />
					</button>

					<input
						type="date"
						className="input-date"
						value={selectedDate}
						onChange={(e) => {
							if (e.target.value) {
								setSelectedDate(e.target.value);
							}
						}}
						aria-label="Tarih Seç"
						data-testid="input-notification-date"
					/>

					<button
						type="button"
						className="btn btn-icon btn-secondary btn-sm"
						onClick={() => setSelectedDate((d) => shiftDateString(d, 1))}
						aria-label="Sonraki Gün"
						data-testid="btn-next-day"
					>
						<ChevronRight size={18} aria-hidden="true" />
					</button>

					{!isToday && (
						<button
							type="button"
							className="btn btn-secondary btn-sm"
							onClick={() => setSelectedDate(todayDateString)}
							data-testid="btn-today"
						>
							Bugün
						</button>
					)}
				</div>
			</div>

			{eventsQuery.isLoading ? (
				<div className="loading-state" data-testid="events-loading">
					Bildirimler yükleniyor...
				</div>
			) : eventsQuery.isError ? (
				<div
					className="error-card card"
					role="alert"
					data-testid="events-error"
				>
					<p>Bildirimler yüklenirken bir hata oluştu.</p>
				</div>
			) : allEvents.length === 0 ? (
				<div
					className="empty-state-card card"
					data-testid="empty-events-message"
				>
					<Bell size={36} aria-hidden="true" className="empty-icon" />
					<h3 className="empty-title">Bildirim Bulunmuyor</h3>
					<p className="empty-message">
						Bu tarihe ait kayıtlı veya planlanan bir bildirim bulunmuyor.
					</p>
				</div>
			) : (
				<div className="events-grid" data-testid="events-list">
					{allEvents.map((evt) => {
						const details = getNotificationTypeDetails(evt.notificationType);
						return (
							<div
								key={evt.id}
								className="notification-event-card card"
								data-testid={`event-card-${evt.id}`}
							>
								<div className="event-card-header">
									<div className="event-type-badge">
										{details.icon}
										<span>{details.title}</span>
									</div>
									<span className="event-time">
										{formatIstanbulDateTime(evt.scheduledFor || evt.createdAt)}
									</span>
								</div>

								<p className="event-description">{details.description}</p>

								<div className="event-card-footer">
									<Link
										to={details.link}
										className="event-action-link"
										data-testid={`event-link-${evt.id}`}
									>
										<span>{details.linkLabel}</span>
										<ArrowRight size={14} aria-hidden="true" />
									</Link>
								</div>
							</div>
						);
					})}

					{eventsQuery.hasNextPage && (
						<div className="pagination-actions">
							<button
								type="button"
								className="btn btn-secondary"
								onClick={() => void eventsQuery.fetchNextPage()}
								disabled={eventsQuery.isFetchingNextPage}
								data-testid="btn-load-more-events"
							>
								{eventsQuery.isFetchingNextPage
									? "Yükleniyor..."
									: "Daha Fazla Bildirim Yükle"}
							</button>
						</div>
					)}
				</div>
			)}
		</div>
	);
}
