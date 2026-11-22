/**
 * AUCTRA email templates. Every template returns a subject, an HTML body (inline styles,
 * table layout — what email clients actually render) and a plain-text alternative.
 *
 * All interpolated values go through `esc()`; URLs are additionally restricted to
 * http(s). Secrets (links, codes) only ever appear in the rendered message, never in logs.
 */

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

const esc = (v: string) =>
  v
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const safeUrl = (u: string) => {
  if (!/^https?:\/\//i.test(u))
    throw new Error('Refusing non-http(s) URL in email');
  return esc(u);
};

const INK = '#111214';
const PAPER = '#FAFAF9';
const MUTED = '#6B6B6B';
const LINE = '#E7E5E4';

interface LayoutInput {
  preheader: string;
  heading: string;
  /** Pre-escaped HTML paragraphs/blocks. */
  body: string;
  cta?: { label: string; url: string };
  footnote?: string;
  appUrl: string;
}

function layout(i: LayoutInput): string {
  const cta = i.cta
    ? `<tr><td style="padding:8px 0 24px">
        <a href="${safeUrl(i.cta.url)}" style="display:inline-block;background:${INK};color:#F5F5F4;text-decoration:none;font-weight:600;font-size:15px;padding:13px 22px;border-radius:10px">${esc(i.cta.label)}</a>
      </td></tr>`
    : '';
  const footnote = i.footnote
    ? `<tr><td style="padding-top:8px;font-size:13px;line-height:20px;color:${MUTED}">${esc(i.footnote)}</td></tr>`
    : '';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light"><title>${esc(i.heading)}</title></head>
<body style="margin:0;padding:0;background:${PAPER};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:${INK}">
<span style="display:none!important;opacity:0;color:transparent;height:0;width:0;overflow:hidden">${esc(i.preheader)}</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${PAPER};padding:32px 12px">
<tr><td align="center">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#FFFFFF;border:1px solid ${LINE};border-radius:16px;overflow:hidden">
    <tr><td style="background:${INK};padding:22px 32px">
      <span style="color:#F5F5F4;font-size:18px;font-weight:600;letter-spacing:0.28em">AUCTRA</span>
      <span style="color:#A8A29E;font-size:12px;letter-spacing:0.08em;padding-left:10px">LIVE AUCTIONS</span>
    </td></tr>
    <tr><td style="padding:32px">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
        <tr><td style="font-size:22px;line-height:30px;font-weight:600;letter-spacing:-0.01em;padding-bottom:12px">${esc(i.heading)}</td></tr>
        <tr><td style="font-size:15px;line-height:24px;color:#2B2B2B;padding-bottom:20px">${i.body}</td></tr>
        ${cta}
        ${footnote}
      </table>
    </td></tr>
    <tr><td style="border-top:1px solid ${LINE};padding:18px 32px;font-size:12px;line-height:18px;color:${MUTED}">
      AUCTRA is a portfolio demo marketplace. No real payments are processed.<br>
      <a href="${safeUrl(i.appUrl)}" style="color:${MUTED}">${esc(i.appUrl.replace(/^https?:\/\//, ''))}</a>
      · <a href="${safeUrl(`${i.appUrl}/settings`)}" style="color:${MUTED}">Notification settings</a>
    </td></tr>
  </table>
</td></tr></table>
</body></html>`;
}

const p = (t: string) => `<p style="margin:0 0 12px">${esc(t)}</p>`;

export function verificationEmail(input: {
  appUrl: string;
  link: string;
  code: string;
  ttlMinutes: number;
  displayName?: string | undefined;
}): RenderedEmail {
  const spaced = `${input.code.slice(0, 3)} ${input.code.slice(3)}`;
  const greeting = input.displayName ? `Hi ${input.displayName},` : 'Hi,';
  const body =
    p(greeting) +
    p(
      'Confirm your email address to start bidding on AUCTRA. Use the button below, or enter this code on the verification screen:',
    ) +
    `<div style="margin:18px 0 6px;padding:18px;border:1px solid ${LINE};border-radius:12px;background:${PAPER};text-align:center">
       <div style="font-family:'SFMono-Regular',Menlo,Consolas,monospace;font-size:32px;font-weight:600;letter-spacing:0.35em;color:${INK}">${esc(spaced)}</div>
       <div style="font-size:12px;color:${MUTED};padding-top:6px">Expires in ${input.ttlMinutes} minutes · single use</div>
     </div>`;
  return {
    subject: `${input.code} is your AUCTRA verification code`,
    html: layout({
      appUrl: input.appUrl,
      preheader: `Your code is ${spaced}. It expires in ${input.ttlMinutes} minutes.`,
      heading: 'Verify your email',
      body,
      cta: { label: 'Verify email address', url: input.link },
      footnote:
        "The link and the code belong to the same request — using either one confirms your address and retires both. If you didn't create an AUCTRA account, ignore this email.",
    }),
    text: `${greeting}

Confirm your email address to start bidding on AUCTRA.

Verification code: ${input.code}
Or open this link: ${input.link}

Both expire in ${input.ttlMinutes} minutes and work once. If you didn't create an AUCTRA account, ignore this email.`,
  };
}

export function passwordResetEmail(input: {
  appUrl: string;
  link: string;
  ttlMinutes: number;
}): RenderedEmail {
  return {
    subject: 'Reset your AUCTRA password',
    html: layout({
      appUrl: input.appUrl,
      preheader: 'Use this link to choose a new password.',
      heading: 'Reset your password',
      body:
        p(
          'We received a request to reset the password for your AUCTRA account.',
        ) +
        p(
          `The link below works once and expires in ${input.ttlMinutes} minutes. Resetting signs you out on every device.`,
        ),
      cta: { label: 'Choose a new password', url: input.link },
      footnote:
        "If you didn't ask for this, you can ignore this email — your password stays the same.",
    }),
    text: `Reset your AUCTRA password:

${input.link}

The link works once and expires in ${input.ttlMinutes} minutes. If you didn't ask for this, ignore this email — your password stays the same.`,
  };
}

export function securityEmail(input: {
  appUrl: string;
  title: string;
  message: string;
  details?: Record<string, string | undefined>;
}): RenderedEmail {
  const rows = Object.entries(input.details ?? {})
    .filter(([, v]) => v)
    .map(
      ([k, v]) =>
        `<tr><td style="padding:4px 12px 4px 0;color:${MUTED};font-size:13px">${esc(k)}</td><td style="padding:4px 0;font-size:13px">${esc(v!)}</td></tr>`,
    )
    .join('');
  return {
    subject: `AUCTRA security alert: ${input.title}`,
    html: layout({
      appUrl: input.appUrl,
      preheader: input.message,
      heading: input.title,
      body:
        p(input.message) +
        (rows
          ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:6px 0 12px">${rows}</table>`
          : ''),
      cta: { label: 'Review your sessions', url: `${input.appUrl}/settings` },
      footnote:
        "If this wasn't you, reset your password right away — that signs out every device.",
    }),
    text: `${input.title}

${input.message}
${Object.entries(input.details ?? {})
  .filter(([, v]) => v)
  .map(([k, v]) => `${k}: ${v}`)
  .join('\n')}

Review your sessions: ${input.appUrl}/settings
If this wasn't you, reset your password right away.`,
  };
}

export function notificationEmail(input: {
  appUrl: string;
  title: string;
  body: string;
  link?: string | undefined;
  linkLabel?: string | undefined;
}): RenderedEmail {
  return {
    subject: input.title,
    html: layout({
      appUrl: input.appUrl,
      preheader: input.body,
      heading: input.title,
      body: p(input.body),
      ...(input.link
        ? {
            cta: {
              label: input.linkLabel ?? 'Open in AUCTRA',
              url: input.link,
            },
          }
        : {}),
      footnote:
        'You receive this email because of your AUCTRA notification settings.',
    }),
    text: `${input.title}

${input.body}
${input.link ? `\n${input.link}\n` : ''}
Manage notification emails: ${input.appUrl}/settings`,
  };
}
