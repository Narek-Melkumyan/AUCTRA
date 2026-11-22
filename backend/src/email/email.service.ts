import { Global, Inject, Injectable, Logger, Module } from '@nestjs/common';
import { Resend } from 'resend';
import { AppConfig } from '../config/app-config.js';
import {
  notificationEmail,
  passwordResetEmail,
  securityEmail,
  verificationEmail,
  type RenderedEmail,
} from './templates.js';

export interface EmailMessage extends RenderedEmail {
  to: string;
  /** Template tag for logs/metrics, e.g. "verify-email". Never contains secrets. */
  template: string;
  /** Provider-side idempotency key so a retried send is not delivered twice. */
  idempotencyKey?: string;
}

export interface EmailSendResult {
  /** True only when a real provider accepted the message. */
  delivered: boolean;
  providerMessageId?: string;
  /** Machine-readable reason when not delivered (never contains message content). */
  reason?: string;
  /** Whether trying again later can succeed (rate limits, provider outages, network). */
  retryable?: boolean;
}

export interface EmailProvider {
  readonly name: 'resend' | 'log' | 'disabled';
  send(message: EmailMessage): Promise<EmailSendResult>;
}

export const EMAIL_PROVIDER = Symbol('EMAIL_PROVIDER');

/** The subset of the Resend client this app uses (lets tests inject a fake). */
export interface ResendLike {
  emails: {
    send(
      payload: {
        from: string;
        to: string[];
        subject: string;
        html: string;
        text: string;
        tags?: { name: string; value: string }[];
      },
      options?: { idempotencyKey?: string },
    ): Promise<{
      data: { id: string } | null;
      error: {
        name: string;
        message: string;
        statusCode: number | null;
      } | null;
    }>;
  };
}

const RETRYABLE_RESEND_ERRORS = new Set([
  'rate_limit_exceeded',
  'application_error',
  'internal_server_error',
  'concurrent_idempotent_requests',
  'daily_quota_exceeded',
]);

/** Sends through Resend (https://resend.com). Logs only the template, recipient domain and outcome. */
export class ResendEmailProvider implements EmailProvider {
  readonly name = 'resend' as const;
  private readonly logger = new Logger('Email');

  constructor(
    private readonly client: ResendLike,
    private readonly from: string,
  ) {}

  async send(message: EmailMessage): Promise<EmailSendResult> {
    const domain = redactEmail(message.to);
    try {
      const res = await this.client.emails.send(
        {
          from: this.from,
          to: [message.to],
          subject: message.subject,
          html: message.html,
          text: message.text,
          tags: [{ name: 'template', value: message.template }],
        },
        message.idempotencyKey
          ? { idempotencyKey: message.idempotencyKey }
          : undefined,
      );
      if (res.error || !res.data) {
        const name = res.error?.name ?? 'unknown_error';
        const retryable =
          RETRYABLE_RESEND_ERRORS.has(name) ||
          (res.error?.statusCode ?? 0) >= 500;
        this.logger.error(
          `Resend rejected "${message.template}" to ${domain}: ${name} (${res.error?.statusCode ?? '-'}) ${res.error?.message ?? ''}`.trim(),
        );
        return { delivered: false, reason: `resend:${name}`, retryable };
      }
      this.logger.log(
        `Sent "${message.template}" to ${domain} (resend id ${res.data.id})`,
      );
      return { delivered: true, providerMessageId: res.data.id };
    } catch (err) {
      // Network failures, DNS, timeouts: the SDK throws instead of returning an error.
      this.logger.error(
        `Resend request for "${message.template}" to ${domain} failed: ${(err as Error).message}`,
      );
      return {
        delivered: false,
        reason: 'resend:network_error',
        retryable: true,
      };
    }
  }
}

/**
 * Development provider: reports `delivered: false` and keeps the last messages in memory
 * for tests. With `printBodies` (development only, never production/test) it prints the
 * plain-text body so a developer can follow verification links without a provider.
 */
export class LogEmailProvider implements EmailProvider {
  readonly name = 'log' as const;
  private readonly logger = new Logger('Email');
  readonly outbox: EmailMessage[] = [];

  constructor(private readonly printBodies: boolean) {}

  async send(message: EmailMessage): Promise<EmailSendResult> {
    this.outbox.push(message);
    if (this.outbox.length > 100) this.outbox.shift();
    if (this.printBodies) {
      this.logger.warn(
        `[DEV EMAIL — NOT DELIVERED] to=${message.to} subject="${message.subject}"\n${message.text}`,
      );
    } else {
      this.logger.debug(
        `Email provider not configured; "${message.template}" to ${redactEmail(message.to)} was not delivered.`,
      );
    }
    return {
      delivered: false,
      reason: 'no-provider-configured',
      retryable: false,
    };
  }
}

export class DisabledEmailProvider implements EmailProvider {
  readonly name = 'disabled' as const;
  async send(): Promise<EmailSendResult> {
    return { delivered: false, reason: 'email-disabled', retryable: false };
  }
}

export function redactEmail(email: string): string {
  const [local = '', domain = ''] = email.split('@');
  return `${local.slice(0, 1)}***@${domain}`;
}

export const VERIFICATION_TTL_MINUTES = 15;
export const RESET_TTL_MINUTES = 30;

@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);

  constructor(
    @Inject(EMAIL_PROVIDER) readonly provider: EmailProvider,
    private readonly config: AppConfig,
  ) {}

  get configured(): boolean {
    return this.provider.name === 'resend';
  }

  /** Absolute frontend URL. Tokens travel in the query string of an emailed link only. */
  link(path: string, params: Record<string, string> = {}): string {
    const url = new URL(path, `${this.config.appPublicUrl}/`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    return url.toString();
  }

  /**
   * Sends with one quick retry for transient failures. Auth emails are time-critical, so
   * they are sent inline; notification emails go through the delivery worker instead.
   */
  async send(message: EmailMessage): Promise<EmailSendResult> {
    let res = await this.provider.send(message);
    if (!res.delivered && res.retryable) {
      await new Promise((r) => setTimeout(r, 400));
      res = await this.provider.send(message);
    }
    return res;
  }

  sendVerification(
    to: string,
    input: {
      token: string;
      code: string;
      requestId: string;
      displayName?: string;
    },
  ) {
    const rendered = verificationEmail({
      appUrl: this.config.appPublicUrl,
      link: this.link('/verify-email', { token: input.token }),
      code: input.code,
      ttlMinutes: VERIFICATION_TTL_MINUTES,
      displayName: input.displayName,
    });
    return this.send({
      ...rendered,
      to,
      template: 'verify-email',
      idempotencyKey: `verify-email/${input.requestId}`,
    });
  }

  sendPasswordReset(to: string, token: string, requestId: string) {
    const rendered = passwordResetEmail({
      appUrl: this.config.appPublicUrl,
      link: this.link('/reset-password', { token }),
      ttlMinutes: RESET_TTL_MINUTES,
    });
    return this.send({
      ...rendered,
      to,
      template: 'password-reset',
      idempotencyKey: `password-reset/${requestId}`,
    });
  }

  sendSecurityAlert(
    to: string,
    input: {
      title: string;
      message: string;
      details?: Record<string, string | undefined>;
    },
  ) {
    return this.send({
      ...securityEmail({ appUrl: this.config.appPublicUrl, ...input }),
      to,
      template: 'security-alert',
    });
  }

  /** Security-alert layout for ACCOUNT_SECURITY notifications. */
  renderSecurity(title: string, message: string) {
    return securityEmail({ appUrl: this.config.appPublicUrl, title, message });
  }

  /** Notification email (no inline retry: the delivery worker owns retries). */
  sendNotification(
    to: string,
    input: {
      title: string;
      body: string;
      path?: string | undefined;
      deliveryId: string;
    },
  ) {
    return this.provider.send({
      ...notificationEmail({
        appUrl: this.config.appPublicUrl,
        title: input.title,
        body: input.body,
        link: input.path ? this.link(input.path) : undefined,
      }),
      to,
      template: 'notification',
      idempotencyKey: `notification/${input.deliveryId}`,
    });
  }

  /** Safe to call in a fire-and-forget context: never throws. */
  async sendSafe(fn: () => Promise<EmailSendResult>): Promise<EmailSendResult> {
    try {
      return await fn();
    } catch (err) {
      this.logger.error(`Email send failed: ${(err as Error).message}`);
      return { delivered: false, reason: 'exception', retryable: false };
    }
  }
}

@Global()
@Module({
  providers: [
    {
      provide: EMAIL_PROVIDER,
      inject: [AppConfig],
      useFactory: (config: AppConfig): EmailProvider => {
        if (config.emailProvider === 'resend')
          return new ResendEmailProvider(
            new Resend(config.resendApiKey) as unknown as ResendLike,
            config.emailFrom,
          );
        if (config.emailProvider === 'disabled')
          return new DisabledEmailProvider();
        return new LogEmailProvider(config.nodeEnv === 'development');
      },
    },
    EmailService,
  ],
  exports: [EmailService, EMAIL_PROVIDER],
})
export class EmailModule {}
