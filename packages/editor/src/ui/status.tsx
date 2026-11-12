import { cx, type StageName } from './logic';

export type DotTone = 'neutral' | 'signed' | 'agent' | 'warn' | 'fail';

const MARK: Record<DotTone, React.ReactNode> = {
  neutral: <circle cx="6" cy="6" r="4" style={{ fill: 'var(--rg-text-2)' }} />,
  signed: <circle cx="6" cy="6" r="4.25" style={{ fill: 'var(--rg-seal)', stroke: 'var(--rg-seal-line)', strokeWidth: 1.5 }} />,
  agent: <circle cx="6" cy="6" r="4.25" style={{ fill: 'none', stroke: 'var(--rg-agent)', strokeWidth: 1.5, strokeDasharray: '2 1.34' }} />,
  warn: <path d="M6 1.5 11 10.5H1Z" style={{ fill: 'var(--rg-warn)' }} />,
  fail: <path d="M6 1 11 6 6 11 1 6Z" style={{ fill: 'var(--rg-fail)' }} />,
};

export interface StatusDotProps {
  tone: DotTone;
  /** Required, so status never rests on colour alone. */
  label: string;
  /** Keeps the label for screen readers but shows only the mark. */
  hideLabel?: boolean;
  className?: string;
}

export function StatusDot({ tone, label, hideLabel, className }: StatusDotProps) {
  return (
    <span className={cx('rg-dot', className)}>
      <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" focusable="false">{MARK[tone]}</svg>
      <span className={hideLabel ? 'rg-visually-hidden' : undefined}>{label}</span>
    </span>
  );
}

export interface StageBadgeProps {
  stage: StageName;
  /** The approved version, such as "v12". Only approvals bind, so this is the only state a stage shows. */
  approvedVersion?: string;
  className?: string;
}

export function StageBadge({ stage, approvedVersion, className }: StageBadgeProps) {
  return (
    <span className={cx('rg-stage', className)}>
      {stage}
      {approvedVersion && <StatusDot tone="signed" label={`Approved ${approvedVersion}`} />}
    </span>
  );
}
