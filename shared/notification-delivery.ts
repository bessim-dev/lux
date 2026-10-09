export const NOTIFICATION_TITLE_BYTES = 180;
export const NOTIFICATION_BODY_BYTES = 2_000;
export const NOTIFICATION_MAX_ATTEMPTS = 5;
export const NOTIFICATION_LEASE_MS = 30_000;
export const NOTIFICATION_TIMEOUT_MS = 5_000;

export type NotificationDeliveryRecipient = { tenant: string; subject: string };

export type NotificationDeliveryEvent = {
  externalEventId: string;
  kind: string;
  priority: 'normal';
  title: string;
  body: string;
  occurredAt: string;
  recipients: NotificationDeliveryRecipient[];
  data: { notificationId: string; workspace: string; eventId: string; project?: string; task?: string };
};

/** Truncate by UTF-8 byte length without splitting a code point. */
export function truncateUtf8(value: string, maxBytes: number): string {
  if (new TextEncoder().encode(value).length <= maxBytes) return value;
  let result = '';
  let bytes = 0;
  for (const character of value) {
    const next = new TextEncoder().encode(character).length;
    if (bytes + next > maxBytes) break;
    result += character;
    bytes += next;
  }
  return result;
}

export function deliveryEvent(input: {
  notificationId: string;
  workspace: string;
  eventId: string;
  idempotencyKey: string;
  type: string;
  title: string;
  body: string;
  recipient: string;
  createdAt: number;
  project?: string;
  task?: string;
}): NotificationDeliveryEvent {
  return {
    externalEventId: input.idempotencyKey,
    kind: `lux.notification.${input.type}`,
    priority: 'normal',
    title: truncateUtf8(input.title, NOTIFICATION_TITLE_BYTES),
    body: truncateUtf8(input.body, NOTIFICATION_BODY_BYTES),
    occurredAt: new Date(input.createdAt).toISOString(),
    recipients: [{ tenant: `lux:${input.workspace}`, subject: `member:${input.recipient}` }],
    data: {
      notificationId: input.notificationId,
      workspace: input.workspace,
      eventId: input.eventId,
      ...(input.project ? { project: input.project } : {}),
      ...(input.task ? { task: input.task } : {}),
    },
  };
}
