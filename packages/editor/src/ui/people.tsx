import { avatarTint, cx, initials, splitOverflow, type AvatarTint } from './logic';

export type AvatarSize = 24 | 28 | 32 | 40;

export interface PersonAvatarProps {
  name: string;
  src?: string;
  /** Defaults to a tint derived from the name. */
  tint?: AvatarTint;
  size?: AvatarSize;
  className?: string;
}

/** People are round. */
export function PersonAvatar({ name, src, tint, size = 28, className }: PersonAvatarProps) {
  return (
    <span role="img" aria-label={name} className={cx('rg-av', 'rg-av-person', `rg-av-${size}`, `rg-av-${tint ?? avatarTint(name)}`, className)}>
      {src ? <img src={src} alt="" className="rg-av-img" /> : <span aria-hidden>{initials(name)}</span>}
    </span>
  );
}

export interface AgentAvatarProps {
  name: string;
  /** Defaults to initials from the name, so Claude Code is CC and Cursor is Cu. */
  initials?: string;
  /** Teal when connected, neutral when not. Still dashed either way. */
  connected?: boolean;
  size?: AvatarSize;
  className?: string;
}

/** Agents are square and dashed. */
export function AgentAvatar({ name, initials: given, connected = true, size = 28, className }: AgentAvatarProps) {
  return (
    <span role="img" aria-label={`${name}, agent`} className={cx('rg-av', 'rg-av-agent', `rg-av-${size}`, !connected && 'is-offline', className)}>
      <span aria-hidden>{given ?? initials(name)}</span>
    </span>
  );
}

export type PresenceMember =
  | { kind: 'person'; name: string; src?: string; tint?: AvatarTint }
  | { kind: 'agent'; name: string; initials?: string; connected?: boolean };

export interface PresenceRowProps {
  members: PresenceMember[];
  /** How many to show before collapsing the rest into "+N". */
  max?: number;
  size?: AvatarSize;
  label?: string;
  className?: string;
}

export function PresenceRow({ members, max = 4, size = 28, label = 'Here now', className }: PresenceRowProps) {
  const { shown, hidden } = splitOverflow(members, max);
  const names = hidden.map((m) => m.name).join(', ');
  return (
    <ul aria-label={label} className={cx('rg-presence', className)}>
      {shown.map((m) => (
        <li key={`${m.kind}:${m.name}`}>
          {m.kind === 'person' ? <PersonAvatar name={m.name} src={m.src} tint={m.tint} size={size} /> : <AgentAvatar name={m.name} initials={m.initials} connected={m.connected} size={size} />}
        </li>
      ))}
      {hidden.length > 0 && (
        <li><span role="img" aria-label={`${hidden.length} more: ${names}`} title={names} className={cx('rg-av', 'rg-av-person', 'rg-av-more', `rg-av-${size}`)}><span aria-hidden>+{hidden.length}</span></span></li>
      )}
    </ul>
  );
}
