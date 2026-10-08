import { z } from 'zod';

export const notificationTypeSchema = z.enum(['mention', 'assign', 'comment', 'update']);
export type NotificationType = z.infer<typeof notificationTypeSchema>;

/** In-app preferences are deliberately limited to event classes the backend emits. */
export const notificationPreferencesSchema = z.object({
  mentions: z.boolean(),
  assignments: z.boolean(),
  comments: z.boolean(),
  updates: z.boolean(),
  email: z.boolean(),
  push: z.boolean(),
});
export type NotificationPreferences = z.infer<typeof notificationPreferencesSchema>;

export const defaultNotificationPreferences: NotificationPreferences = {
  mentions: true,
  assignments: true,
  comments: true,
  updates: true,
  email: false,
  push: false,
};

export const notificationSchema = z.object({
  id: z.string().min(1),
  eventId: z.string().min(1),
  type: notificationTypeSchema,
  actor: z.string().nullable(),
  entityKind: z.string().nullable(),
  entityId: z.string().nullable(),
  project: z.string().nullable(),
  task: z.string().nullable(),
  title: z.string(),
  body: z.string(),
  readAt: z.number().nullable(),
  createdAt: z.number(),
});
export type Notification = z.infer<typeof notificationSchema>;

export const notificationPageSchema = z.object({
  notifications: z.array(notificationSchema),
  page: z.object({ cursor: z.string().nullable(), isDone: z.boolean() }),
});
export type NotificationPage = z.infer<typeof notificationPageSchema>;

export const notificationListRequestSchema = z.object({
  workspace: z.string().min(1),
  unread: z.boolean().optional(),
  type: notificationTypeSchema.optional(),
  limit: z.number().int().min(1).max(100).default(25),
  cursor: z.string().optional(),
});

export const notificationPreferencePatchSchema = notificationPreferencesSchema.partial().strict();
export type NotificationPreferencePatch = z.infer<typeof notificationPreferencePatchSchema>;
