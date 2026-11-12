import { useState } from 'react';
import { AgentLabel, AgentStatus, TaskStatus } from './agents';
import { Button, IconButton } from './Button';
import { Field, Input, Segmented, Select, Textarea } from './forms';
import { STAGES, type TaskState } from './logic';
import { Menu } from './Menu';
import { NoteComposer } from './NoteComposer';
import { AgentAvatar, PersonAvatar, PresenceRow, type PresenceMember } from './people';
import { Rail, RailGroup, RailItem } from './Rail';
import { StageBadge, StatusDot } from './status';
import { FloatingPanel, Sheet, Toast, ToastRegion } from './surfaces';
import { Tabs } from './Tabs';
import { Tooltip } from './Tooltip';

/* Stand-in icons for the demo only. The app passes its own. */
const Icon = ({ d }: { d: string }) => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>
);
const home = <Icon d="M3 11 12 3l9 8M5 9.5V21h14V9.5" />;
const search = <Icon d="M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14Zm5-2 5 5" />;
const flag = <Icon d="M5 21V4h13l-3 4 3 4H5" />;
const frame = <Icon d="M8 3v18M16 3v18M3 8h18M3 16h18" />;
const more = <Icon d="M5 12h.01M12 12h.01M19 12h.01" />;

const PRESENCE: PresenceMember[] = [
  { kind: 'person', name: 'Priya Rao' },
  { kind: 'person', name: 'Asha Menon' },
  { kind: 'agent', name: 'Claude Code' },
  { kind: 'person', name: 'Lena Fischer' },
  { kind: 'person', name: 'Daniel Cho' },
];

const TASKS: TaskState[] = [
  { status: 'waiting' },
  { status: 'picked-up', agentName: 'Claude Code', at: '14:41' },
  { status: 'running', run: 31, secondsSinceWrite: 3 },
  { status: 'running', run: 31, secondsSinceWrite: 720 },
  { status: 'done', run: 29 },
];

const Section = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <section className="rg-gallery-section"><h3>{title}</h3>{children}</section>
);

function Board({ theme }: { theme: 'light' | 'dark' }) {
  const [view, setView] = useState('Desktop');
  const [tab, setTab] = useState('inspect');
  const [stage, setStage] = useState<string>('Visual');
  const [sheet, setSheet] = useState(false);
  const [toasts, setToasts] = useState<string[]>([]);
  const [left, setLeft] = useState('Nothing left yet.');
  const addToast = (text: string) => setToasts((t) => [...t.filter((x) => x !== text), text]);
  const dropToast = (text: string) => setToasts((t) => t.filter((x) => x !== text));

  return (
    <div className="rg-gallery" data-theme={theme}>
      <h2 className="rg-gallery-title">UI kit, {theme}</h2>

      <Section title="Buttons">
        <div className="rg-gallery-row">
          <Button variant="primary">Send for review</Button>
          <Button>Open on canvas</Button>
          <Button variant="quiet">Discard</Button>
          <Button size="sm">Compare</Button>
          <Button variant="seal" size="lg">Approve v14 as Lena Fischer</Button>
          <Button disabled>Disabled</Button>
          <Button busy>Busy</Button>
          <IconButton label="Frame tool" icon={frame} />
          <IconButton label="Search" icon={search} pressed />
          <IconButton label="Small" size="sm" icon={more} />
        </div>
      </Section>

      <Section title="Fields">
        <div className="rg-gallery-form">
          <Field label="Width"><Input mono defaultValue="332 fill" /></Field>
          <Field label="Radius" hint="From the library"><Select defaultValue="md" options={[{ value: 'sm', label: 'radius.sm' }, { value: 'md', label: 'radius.md' }]} /></Field>
          <Field label="Exception note for the failed check" required error="An approver needs a note to sign past a failed check."><Textarea placeholder="Why this can ship" /></Field>
        </div>
      </Section>

      <Section title="Segmented and tabs">
        <Segmented label="Viewport" value={view} onChange={setView} options={[{ value: 'Desktop', label: 'Desktop' }, { value: 'Tablet', label: 'Tablet' }, { value: 'Mobile', label: 'Mobile' }]} />
        <Tabs label="Inspector" value={tab} onChange={setTab} tabs={[{ id: 'inspect', label: 'Inspect' }, { id: 'layers', label: 'Layers' }, { id: 'comments', label: 'Comments', count: 4 }, { id: 'checks', label: 'Checks', count: 1 }]}>
          Showing {tab}.
        </Tabs>
      </Section>

      <Section title="Rail">
        <div className="rg-gallery-rails">
          {[false, true].map((expanded) => (
            <Rail key={String(expanded)} label={expanded ? 'Project, expanded' : 'Project'} expanded={expanded} footer={<IconButton label="Collapse" icon={more} />}>
              <RailItem icon={home} label="Home" />
              <RailGroup label="Stages">
                {STAGES.map((s) => <RailItem key={s} icon={s === 'Discovery' ? search : flag} label={s} active={s === stage} signedLabel={s === 'Visual' || s === 'Handoff' ? 'Approved v12' : undefined} onClick={() => setStage(s)} />)}
              </RailGroup>
            </Rail>
          ))}
        </div>
      </Section>

      <Section title="People and agents">
        <div className="rg-gallery-row">
          <PersonAvatar name="Asha Menon" />
          <PersonAvatar name="Priya Rao" size={32} />
          <PersonAvatar name="Lena Fischer" size={40} />
          <AgentAvatar name="Claude Code" />
          <AgentAvatar name="Cursor" size={32} connected={false} />
          <PresenceRow members={PRESENCE} max={4} />
        </div>
      </Section>

      <Section title="Status">
        <div className="rg-gallery-row">
          <StatusDot tone="neutral" label="Draft" />
          <StatusDot tone="signed" label="Approved v12" />
          <StatusDot tone="agent" label="Agent, unreviewed" />
          <StatusDot tone="warn" label="3 test sessions logged, 5 suggested" />
          <StatusDot tone="fail" label="Save card label is 3.9:1 on mobile" />
          <StageBadge stage="Wireframes" />
          <StageBadge stage="Visual" approvedVersion="v12" />
        </div>
      </Section>

      <Section title="Menu, tooltip, toast, sheet">
        <div className="rg-gallery-row">
          <Menu label="Run actions" trigger={(p) => <Button {...p}>Run 31</Button>} items={[
            { id: 'reviewed', label: 'Mark reviewed', onSelect: () => addToast('Run 31 marked reviewed by Asha Menon') },
            { id: 'refuse', label: 'Refuse further writes', onSelect: () => addToast('Run 31 can no longer write') },
            { id: 'locked', label: 'Peek outside Review', disabled: true, onSelect: () => undefined },
            { id: 'undo', label: 'Undo whole run', onSelect: () => addToast('Run 31 undone') },
          ]} />
          <Tooltip content="Open the signing sheet"><Button onClick={() => setSheet(true)}>Open sheet</Button></Tooltip>
          <Tooltip content="More"><IconButton label="More" icon={more} /></Tooltip>
          <Button onClick={() => addToast('Run 30 undone, 2 layers stayed')}>Show toast</Button>
        </div>
        <ToastRegion>
          {toasts.map((t) => <Toast key={t} action={{ label: 'Open', onClick: () => dropToast(t) }} onDismiss={() => dropToast(t)}>{t}</Toast>)}
          <Toast tone="fail" autoDismissMs={null} onDismiss={() => undefined}>Couldn't save this note. Your text is still here.</Toast>
        </ToastRegion>
        <Sheet open={sheet} onClose={() => setSheet(false)} title="Approve v14" description="You approve this exact version, not the working copy."
          footer={<Button variant="seal" size="lg" style={{ width: '100%' }} onClick={() => setSheet(false)}>Approve v14 as Lena Fischer</Button>}>
          <Field label="Exception note for the failed check" required><Textarea /></Field>
        </Sheet>
      </Section>

      <Section title="Agent status">
        <div className="rg-gallery-row">
          <AgentStatus agentName="Claude Code" connection={{ state: 'connected', tokenOwner: 'Asha' }} />
          <AgentStatus connection={{ state: 'not-connected' }} />
          <AgentStatus agentName="Cursor" connection={{ state: 'token-expired', tokenOwner: 'Priya' }} />
        </div>
        <div className="rg-gallery-rows">
          <AgentStatus variant="card" agentName="Claude Code" connection={{ state: 'connected', tokenOwner: 'Asha' }} />
          <AgentStatus variant="card" connection={{ state: 'not-connected' }} />
          <AgentStatus variant="card" agentName="Cursor" connection={{ state: 'last-seen', tokenOwner: 'Priya', lastSeen: '18:11 yesterday' }} />
          <AgentStatus variant="card" agentName="Cursor" connection={{ state: 'token-expired', tokenOwner: 'Priya' }} />
        </div>
      </Section>

      <Section title="Task status and agent label">
        <FloatingPanel title="For agents" meta="5 open" className="rg-gallery-rows">
          <div className="rg-gallery-rows">{TASKS.map((t, i) => <TaskStatus key={i} state={t} className="rg-gallery-task" />)}</div>
        </FloatingPanel>
        <AgentLabel attribution="Claude Code, for Asha Menon" />
      </Section>

      <Section title="Note composer">
        <NoteComposer targetName="Button / Primary" targetContext="Payment, desktop" connectedAgent="Claude Code" onLeave={(e) => setLeft(`Left ${e.kind}: ${e.text}`)} onClose={() => setLeft('Closed.')} />
        <p data-testid="composer-result">{left}</p>
      </Section>
    </div>
  );
}

/** Every kit component in both themes, with sample data from the mockups. Not mounted by the app. */
export function UiGallery() {
  return (
    <>
      <Board theme="light" />
      <Board theme="dark" />
    </>
  );
}
