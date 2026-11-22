-- Notifications for buyer–seller messages. Additive enum value only.
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'DIRECT_MESSAGE';
