import type http from 'node:http';
import type {MailNotificationSettings, MailNotifier} from '../mail-notifier.js';
import type {MetadataStore} from '../metadata-store.js';
import {json, readJsonBody} from './utils.js';

export type MailSettingsRouteContext = {mailNotifier?: MailNotifier; metadata: MetadataStore};

/** Handles `/api/v1/mail-notifications`. Returns false when the request is not a mail settings route. */
export async function handleMailSettingsRoutes(
  ctx: MailSettingsRouteContext,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  u: URL
): Promise<boolean> {
  const send = (status: number, data: unknown) => {
    json(res, status, data);
    return true;
  };
  if (req.method === 'GET' && u.pathname === '/api/v1/mail-notifications')
    return send(200, {
      data: {available: !!ctx.mailNotifier, settings: ctx.mailNotifier?.getSettings() ?? null}
    });
  if (req.method === 'POST' && u.pathname === '/api/v1/mail-notifications') {
    if (!ctx.mailNotifier)
      throw Object.assign(new Error('MailDispatch is not configured at server startup'), {
        code: 'MAIL_NOTIFICATIONS_DISABLED'
      });
    const b = await readJsonBody(req),
      patch: Partial<MailNotificationSettings> = {};
    if ('enabled' in b) {
      if (typeof b.enabled !== 'boolean')
        throw Object.assign(new Error('enabled must be a boolean'), {
          code: 'INVALID_MAIL_NOTIFICATION_SETTINGS'
        });
      patch.enabled = b.enabled;
    }
    if ('aggregationDelaySeconds' in b) patch.aggregationDelaySeconds = Number(b.aggregationDelaySeconds);
    if ('includeResponse' in b) {
      if (typeof b.includeResponse !== 'boolean')
        throw Object.assign(new Error('includeResponse must be a boolean'), {
          code: 'INVALID_MAIL_NOTIFICATION_SETTINGS'
        });
      patch.includeResponse = b.includeResponse;
    }
    if ('includeSessionDetails' in b) {
      if (typeof b.includeSessionDetails !== 'boolean')
        throw Object.assign(new Error('includeSessionDetails must be a boolean'), {
          code: 'INVALID_MAIL_NOTIFICATION_SETTINGS'
        });
      patch.includeSessionDetails = b.includeSessionDetails;
    }
    if ('collabEscalations' in b) {
      if (typeof b.collabEscalations !== 'boolean')
        throw Object.assign(new Error('collabEscalations must be a boolean'), {
          code: 'INVALID_MAIL_NOTIFICATION_SETTINGS'
        });
      patch.collabEscalations = b.collabEscalations;
    }
    const settings = ctx.mailNotifier.updateSettings(patch);
    ctx.metadata.setSetting('mailNotifications', settings);
    return send(200, {data: {available: true, settings}});
  }
  return false;
}
