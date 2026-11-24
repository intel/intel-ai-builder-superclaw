/** Channel icons and the status pill used on the Identities page. */
export function TelegramIcon(props: { size?: number }) {
  const s = () => props.size ?? 20;
  return (
    <svg width={s()} height={s()} viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="10" fill="var(--dls-provider-telegram-brand)" />
      <path d="M7 12.5l2.5 2L16 8.5" stroke="white" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
      <path d="M9.5 14.5l-.5 3 2-1.5" stroke="white" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  );
}

export function SlackIcon(props: { size?: number }) {
  const s = () => props.size ?? 20;
  return (
    <svg width={s()} height={s()} viewBox="0 0 24 24" fill="none">
      <path d="M14.5 2a2 2 0 012 2v4.5h-2a2 2 0 010-4h0V2z" fill="var(--dls-slack-brand-pink)" />
      <path d="M2 9.5a2 2 0 012-2h4.5v2a2 2 0 01-4 0V9.5z" fill="var(--dls-slack-brand-cyan)" />
      <path d="M9.5 22a2 2 0 01-2-2v-4.5h2a2 2 0 010 4v2.5z" fill="var(--dls-slack-brand-green)" />
      <path d="M22 14.5a2 2 0 01-2 2h-4.5v-2a2 2 0 014 0h2.5z" fill="var(--dls-slack-brand-yellow)" />
      <path d="M8.5 9.5h2v2h-2z" fill="var(--dls-slack-brand-cyan)" />
      <path d="M13.5 9.5h2v2h-2z" fill="var(--dls-slack-brand-yellow)" />
      <path d="M8.5 14.5h2v-2h-2z" fill="var(--dls-slack-brand-green)" />
      <path d="M13.5 14.5h2v2h-2z" fill="var(--dls-slack-brand-pink)" />
    </svg>
  );
}

export function GmailIcon(props: { size?: number }) {
  const s = () => props.size ?? 20;
  return (
    <svg width={s()} height={s()} viewBox="52 42 88 66">
      <path d="M58 108h14V74L52 59v43c0 3.32 2.69 6 6 6" fill="var(--dls-gmail-brand-blue)" />
      <path d="M120 108h14c3.32 0 6-2.69 6-6V59l-20 15" fill="var(--dls-gmail-brand-green)" />
      <path d="M120 48v26l20-15v-8c0-7.42-8.47-11.65-14.4-7.2" fill="var(--dls-gmail-brand-yellow)" />
      <path d="M72 74V48l24 18 24-18v26L96 92" fill="var(--dls-gmail-brand-red)" />
      <path d="M52 51v8l20 15V48l-5.6-4.2c-5.94-4.45-14.4-.22-14.4 7.2" fill="var(--dls-gmail-brand-red-dark)" />
    </svg>
  );
}

/* ---- Status pill sub-component ---- */

export function StatusPill(props: { label: string; value: string; ok: boolean }) {
  return (
    <div class="flex-1 rounded-control border border-dls-border bg-dls-surface px-3.5 py-2.5">
      <div class="text-label text-dls-secondary mb-0.5">{props.label}</div>
      <div class={`text-body font-semibold ${props.ok ? "text-dls-text" : "text-dls-secondary"}`}>{props.value}</div>
    </div>
  );
}

/* ---- Main ---- */
