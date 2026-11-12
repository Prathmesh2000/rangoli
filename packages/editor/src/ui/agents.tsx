import { GlyphDone, GlyphPickedUp, GlyphRun, GlyphWaiting } from './glyphs';
import { AGENT_DRAFTED, agentStatusCopy, cx, taskStatusCopy, type AgentConnection, type TaskState } from './logic';
import { AgentAvatar } from './people';

export interface AgentStatusProps {
  /** Omit when no agent is known: the avatar becomes an unknown agent. */
  agentName?: string;
  agentInitials?: string;
  connection: AgentConnection;
  /** `inline` for the top bar, `card` for the For agents panel. */
  variant?: 'inline' | 'card';
  /** Trailing content on the card, such as a run link or a connect button. */
  action?: React.ReactNode;
  className?: string;
}

/** Reports the connection only. Rangoli can't start an agent or say what one will do. */
export function AgentStatus({ agentName, agentInitials, connection, variant = 'inline', action, className }: AgentStatusProps) {
  const copy = agentStatusCopy(agentName, connection);
  const connected = connection.state === 'connected';
  const avatar = <AgentAvatar name={agentName ?? 'Unknown agent'} initials={agentName ? agentInitials : '?'} connected={connected} size={variant === 'card' ? 32 : 28} />;
  const tone = connected ? 'is-connected' : connection.state === 'token-expired' ? 'is-expired' : 'is-offline';
  if (variant === 'inline') {
    return (
      <span className={cx('rg-agentstatus', tone, className)}>
        {avatar}
        <span className="rg-agentstatus-text">{copy.name && <>{copy.name} </>}<span className="rg-agentstatus-state">{copy.state}</span></span>
      </span>
    );
  }
  return (
    <div className={cx('rg-agentcard', tone, className)}>
      {avatar}
      <div className="rg-agentcard-text">
        <div className="rg-agentcard-title">{copy.title}</div>
        <div className="rg-agentcard-detail">{copy.detail}</div>
      </div>
      {action && <div className="rg-agentcard-action">{action}</div>}
    </div>
  );
}

const TASK_MARK: Record<TaskState['status'], React.ReactNode> = {
  waiting: <GlyphWaiting />,
  'picked-up': <GlyphPickedUp />,
  running: <GlyphRun />,
  done: <GlyphDone />,
};

export interface TaskStatusProps {
  state: TaskState;
  className?: string;
}

/** Stretches to its row, with detail at the far edge; shrinks to fit inline. */
export function TaskStatus({ state, className }: TaskStatusProps) {
  const { label, meta } = taskStatusCopy(state);
  return (
    <span className={cx('rg-task', `rg-task-${state.status}`, className)}>
      <span className="rg-task-mark" aria-hidden>{TASK_MARK[state.status]}</span>
      <span className="rg-task-label">{label}</span>
      {meta && <span className="rg-task-meta">{meta}</span>}
    </span>
  );
}

export interface AgentLabelProps {
  /** Who ran it and for whom, such as "Claude Code, for Asha Menon". */
  attribution?: string;
  className?: string;
}

export function AgentLabel({ attribution, className }: AgentLabelProps) {
  return (
    <span className={cx('rg-agentlabel', className)}>
      <span className="rg-agentlabel-text">{AGENT_DRAFTED}</span>
      {attribution && <span className="rg-agentlabel-who">{attribution}</span>}
    </span>
  );
}
