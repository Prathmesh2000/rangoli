/**
 * Patterns: larger building blocks (tables, forms, modals, navigation …) inserted with ONE line:
 *
 *   +table cols="Name|Status|Duration|Started" rows=5
 *   +page-header title="Test runs" primary="New run"
 *
 * A pattern expands into ordinary nodes (frames + library components), so the result is fully
 * editable, lintable and themeable. Patterns may be nested anywhere a node line is allowed.
 */
export interface PatternSpec {
  category: 'Layout' | 'Navigation' | 'Forms' | 'Overlays' | 'Data' | 'Feedback' | 'Marketing' | 'Testing';
  description: string;
  params: Record<string, string>; // name → default (documented)
  rdl: (p: Record<string, string>) => string;
}

const q = (s: string) => JSON.stringify(s);
const items = (s: string) => s.split('|').map((x) => x.trim()).filter(Boolean);
const indent = (s: string, n = 1) => s.split('\n').map((l) => (l ? '  '.repeat(n) + l : l)).join('\n');
const STATUSES = ['passed', 'failed', 'passed', 'flaky', 'passed', 'running', 'skipped', 'passed'];
const RUN_NAMES = ['Checkout flow', 'Login smoke test', 'Payments regression', 'Search relevance', 'Profile settings', 'Cart API contract', 'Mobile onboarding', 'Invoice export'];
const DURATIONS = ['04:12', '00:58', '11:40', '02:05', '01:31', '06:47', '03:22', '00:44'];
const WHEN = ['2 hours ago', '3 hours ago', 'Yesterday', 'Yesterday', '2 days ago', 'Running', '3 days ago', 'Last week'];
const NAV_ICON: Record<string, string> = { dashboard: 'grid', overview: 'grid', home: 'home', 'test cases': 'list', tests: 'list', runs: 'play', 'test runs': 'play', suites: 'folder', reports: 'chart', defects: 'bug', bugs: 'bug', projects: 'layers', team: 'user', members: 'user', settings: 'settings', integrations: 'layers', notifications: 'bell' };

export const PATTERNS: Record<string, PatternSpec> = {
  // ---------------------------------------------------------------- layout
  'page-header': {
    category: 'Layout',
    description: 'Page title with context line, optional breadcrumbs and actions (one primary).',
    params: { title: 'Test runs', subtitle: 'Nightly and on-demand runs across all suites', primary: 'New run', secondary: 'Export', crumbs: '' },
    rdl: (p) => `PageHeader col gap3 wfill
${p.crumbs ? `  @Breadcrumbs ${q(p.crumbs)}\n` : ''}  HeaderRow row between center wfill
    Heading col gap1
      Title text headline ${q(p.title!)}
${p.subtitle ? `      Subtitle text body muted ${q(p.subtitle)}\n` : ''}    Actions row gap2 center
${p.secondary ? `      @Button variant=secondary ${q(p.secondary)}\n` : ''}${p.primary ? `      @Button variant=primary ${q(p.primary)}` : ''}`,
  },
  'section-header': {
    category: 'Layout',
    description: 'Section title with an optional link action on the right.',
    params: { title: 'Recent runs', action: 'View all' },
    rdl: (p) => `SectionHeader row between center wfill
  Title text title-sm ${q(p.title!)}
${p.action ? `  @Link ${q(p.action)}` : ''}`,
  },
  card: {
    category: 'Layout',
    description: 'Content card with title, body and an optional action.',
    params: { title: 'Checkout regression', body: '142 tests · last run 2 hours ago', action: 'Open suite', width: '360' },
    rdl: (p) => `Card col gap3 p5 w${p.width} fill:surface stroke:border r3
  Title text title-sm ${q(p.title!)}
  Body text body-sm muted ${q(p.body!)}
${p.action ? `  @Button variant=secondary size=sm ${q(p.action)}` : ''}`,
  },
  stat: {
    category: 'Data',
    description: 'KPI tile: label, value and change. better=up|down says which direction is good (auto: failures, flaky, duration, errors → down).',
    params: { label: 'Pass rate', value: '96.4%', delta: '+1.2%', better: 'auto' },
    rdl: (p) => {
      const lowerIsBetter = p.better === 'down' || (p.better === 'auto' && /fail|flak|error|duration|time|bug|defect|block/i.test(p.label!));
      const improved = p.delta!.startsWith('-') === lowerIsBetter;
      return `Stat col gap1 p4 wfill fill:surface stroke:border r3
  Label text caption muted ${q(p.label!)}
  Value text size:28 weight:600 ${q(p.value!)}
${p.delta ? `  @Chip variant=${improved ? 'success' : 'error'} ${q(p.delta)}` : ''}`;
    },
  },
  stats: {
    category: 'Data',
    description: 'Row of KPI tiles. items = "Label:Value:Delta|…"; colour follows whether the change is good for that metric.',
    params: { items: 'Pass rate:96.4%:+1.2%|Failed tests:6:-2|Avg duration:11m 40s:+30s|Flaky:3:+1' },
    rdl: (p) => `Stats row gap4 wfill\n${items(p.items!).map((it) => {
      const [label = '', value = '', delta = ''] = it.split(':');
      return indent(PATTERNS.stat!.rdl({ label, value, delta, better: 'auto' }));
    }).join('\n')}`,
  },
  toolbar: {
    category: 'Layout',
    description: 'Search + filter selects + view switch above a list or table.',
    params: { search: 'Search runs', filters: 'All suites|Last 7 days|Any status', views: 'List|Board' },
    rdl: (p) => `Toolbar row gap2 center wfill
  Search row w320
    @SearchInput size=sm ${q(p.search!)}
${items(p.filters!).map((f) => `  @Select size=sm w160 ${q(f)}`).join('\n')}
  Spacer row wfill h1
${p.views ? `  @Segmented size=sm selected=0 ${q(p.views)}` : ''}`,
  },
  'sidebar-nav': {
    category: 'Navigation',
    description: 'App sidebar: brand, primary nav (icons), selected item, footer user.',
    params: { brand: 'AI Test Management', items: 'Dashboard|Test cases|Runs|Suites|Reports|Settings', selected: '2', user: 'Prathmesh Agrawal' },
    rdl: (p) => {
      const sel = Number(p.selected ?? 0);
      return `Sidebar col between w248 hfill p3 fill:surface name:"Sidebar"
  Top col gap4
    Brand row gap2 center px2 py2
      Mark w24 h24 fill:primary.600 r2 middle
        Icon icon:check w14 h14 color:white
      Text label ${q(p.brand!)}
    Nav col gap0.5 role:navigation
${items(p.items!).map((it, i) => `      Item${i} row gap3 center px3 h36 wfill r2${i === sel ? ' fill:selected color:link' : ' color:text.secondary'}${i === sel ? ' role:current' : ''}
        Icon icon:${NAV_ICON[it.toLowerCase()] ?? 'list'} w18 h18
        Text label ${q(it)}`).join('\n')}
  Footer row gap2 center px2 py2
    @Avatar size=sm ${q(p.user!)}
    Text body-sm wfill truncate ${q(p.user!)}
    @IconButton size=sm icon=logout "Sign out"`;
    },
  },
  topbar: {
    category: 'Navigation',
    description: 'App top bar: search, notifications, user.',
    params: { search: 'Search test cases, runs, suites', user: 'Prathmesh Agrawal', notifications: '3' },
    rdl: (p) => `Topbar row between center px5 h56 wfill fill:surface name:"Top bar"
  Search row w420
    @SearchInput shortcut=/ ${q(p.search!)}
  Right row gap2 center
    @IconButton icon=bell ${q(`Notifications${p.notifications ? ` (${p.notifications} new)` : ''}`)}
    @Avatar size=sm ${q(p.user!)}`,
  },
  footer: {
    category: 'Layout',
    description: 'Page footer with copyright and links.',
    params: { text: '© 2026 Your Company', links: 'Status|Docs|Privacy' },
    rdl: (p) => `Footer row between center py4 wfill
  Copy text caption muted ${q(p.text!)}
  Links row gap4
${items(p.links!).map((l) => `    @Link variant=muted ${q(l)}`).join('\n')}`,
  },
  'empty-state': {
    category: 'Feedback',
    description: 'Says what this is, why it is empty, and the one action to fix it.',
    params: { icon: 'flask', title: 'No test runs yet', body: 'Runs appear here after your first suite executes. Start one now or connect CI.', action: 'Start a run' },
    rdl: (p) => `EmptyState col gap3 middle p8 wfill
  IconWrap w48 h48 fill:subtle rfull middle
    Icon icon:${p.icon} w24 h24 color:text.secondary
  Title text title-sm align:center ${q(p.title!)}
  Body text body-sm muted align:center maxw400 ${q(p.body!)}
${p.action ? `  @Button variant=secondary ${q(p.action)}` : ''}`,
  },

  // ---------------------------------------------------------------- forms
  'form-field': {
    category: 'Forms',
    description: 'Label above input with optional help or error text. kind=input|select|textarea.',
    params: { label: 'Work email', placeholder: 'name@company.com', help: '', error: '', optional: 'false', kind: 'input', value: '' },
    rdl: (p) => {
      const ctl =
        p.kind === 'select' ? `@Select ${q(p.value || p.placeholder!)}` : p.kind === 'textarea' ? `@Textarea ${q(p.placeholder!)}` : `@Input${p.error ? ' state=error' : ''}${p.value ? ` value=${q(p.value)}` : ''} ${q(p.placeholder!)}`;
      return `Field col gap1.5 wfill
  LabelRow row gap1 center
    Label text label ${q(p.label!)}
${p.optional === 'true' ? '    Optional text caption muted "(optional)"\n' : ''}  ${ctl}
${p.error ? `  Error text caption color:status.error.fg ${q(p.error)}` : p.help ? `  Help text caption muted ${q(p.help)}` : ''}`;
    },
  },
  form: {
    category: 'Forms',
    description: 'Vertical form: fields "Label:placeholder|…", then actions aligned with the fields.',
    params: { title: 'New test suite', fields: 'Suite name:e.g. Checkout regression|Repository:org/repo|Branch:main', submit: 'Create suite', cancel: 'Cancel' },
    rdl: (p) => `Form col gap5 w480
${p.title ? `  Title text title ${q(p.title)}\n` : ''}${items(p.fields!).map((f) => {
      const [label = '', placeholder = ''] = f.split(':');
      return indent(PATTERNS['form-field']!.rdl({ label, placeholder, help: '', error: '', optional: 'false', kind: 'input', value: '' }));
    }).join('\n')}
  Actions row gap2 jend wfill
${p.cancel ? `    @Button variant=ghost ${q(p.cancel)}\n` : ''}    @Button variant=primary ${q(p.submit!)}`,
  },
  'radio-group': {
    category: 'Forms',
    description: 'Fieldset with a legend and one-of-many options.',
    params: { legend: 'Run schedule', options: 'Nightly|On every push|Manually', selected: '0' },
    rdl: (p) => `RadioGroup col gap2 role:radiogroup
  Legend text label ${q(p.legend!)}
${items(p.options!).map((o, i) => `  @Radio checked=${i === Number(p.selected) ? 'true' : 'false'} ${q(o)}`).join('\n')}`,
  },
  'settings-row': {
    category: 'Forms',
    description: 'Setting with title, description and a control (switch|select|button).',
    params: { title: 'Retry failed tests', desc: 'Automatically re-run a failed test once before marking it failed.', control: 'switch', value: 'true' },
    rdl: (p) => `SettingRow row between center gap6 py4 wfill
  Text col gap0.5 maxw560
    Title text body ${q(p.title!)}
    Desc text body-sm muted ${q(p.desc!)}
  ${p.control === 'select' ? `@Select w200 ${q(p.value!)}` : p.control === 'button' ? `@Button variant=secondary size=sm ${q(p.value!)}` : `@Switch checked=${p.value === 'false' ? 'false' : 'true'}`}`,
  },
  'file-upload': {
    category: 'Forms',
    description: 'Drop zone with browse button and accepted types.',
    params: { title: 'Drop test results here', hint: 'JUnit XML or JSON · up to 50 MB', action: 'Browse files' },
    rdl: (p) => `Upload col gap2 middle p6 wfill fill:subtle stroke:border.strong r3
  Icon icon:upload w24 h24 color:text.secondary
  Title text body align:center ${q(p.title!)}
  Hint text caption muted align:center ${q(p.hint!)}
  @Button variant=secondary size=sm ${q(p.action!)}`,
  },
  'date-picker': {
    category: 'Forms',
    description: 'Month calendar (popover) with a selected day.',
    params: { month: 'November 2026', start: '0', days: '30', selected: '8' },
    rdl: (p) => {
      const start = Number(p.start), days = Number(p.days), sel = Number(p.selected);
      const cells: string[] = [];
      for (let i = 0; i < start; i++) cells.push(`    Empty${i} h32`);
      for (let d = 1; d <= days; d++) cells.push(`    D${d} h32 middle r2${d === sel ? ' fill:action.primary color:onPrimary' : ''}\n      Text label ${q(String(d))}`);
      return `DatePicker col gap2 p3 w288 fill:surface stroke:border r3 shadow:md role:dialog
  Head row between center
    @IconButton size=sm icon=chevron-left "Previous month"
    Month text label ${q(p.month!)}
    @IconButton size=sm icon=chevron-right "Next month"
  Weekdays cols7
${['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'].map((w) => `    W${w} row h24 middle\n      Text caption muted ${q(w)}`).join('\n')}
  Days cols7 gap0.5
${cells.join('\n')}`;
    },
  },
  combobox: {
    category: 'Forms',
    description: 'Open autocomplete: input + suggestion list with the active option checked.',
    params: { value: 'check', options: 'Checkout flow|Checkout API|Check-in kiosk', selected: '0' },
    rdl: (p) => `Combobox col gap1 w320
  @Input icon=search value=${q(p.value!)} "Search suites"
  Listbox col p1 fill:surface stroke:border r3 shadow:md role:listbox
${items(p.options!).map((o, i) => `    Option${i} row between center px3 h36 r2${i === Number(p.selected) ? ' fill:selected' : ''}
      Text body ${q(o)}
${i === Number(p.selected) ? '      Icon icon:check w16 h16 color:link' : ''}`).join('\n')}`,
  },

  // ---------------------------------------------------------------- overlays
  modal: {
    category: 'Overlays',
    description: 'Dialog: title says the action, body says the consequence, buttons say the outcome.',
    params: { title: 'Delete test suite?', body: 'This removes 142 test cases and their run history. This cannot be undone.', primary: 'Delete suite', secondary: 'Cancel', danger: 'true' },
    rdl: (p) => `Modal col gap5 p6 w480 fill:surface r4 shadow:lg role:dialog name:"Modal"
  Head row between start
    Title text title ${q(p.title!)}
    @IconButton size=sm icon=close "Close"
  Body text body muted ${q(p.body!)}
  Actions row gap2 jend
    @Button variant=secondary ${q(p.secondary!)}
    @Button variant=${p.danger === 'true' ? 'danger' : 'primary'} ${q(p.primary!)}`,
  },
  drawer: {
    category: 'Overlays',
    description: 'Side sheet for details or longer forms.',
    params: { title: 'Run details', primary: 'Re-run', secondary: 'Close' },
    rdl: (p) => `Drawer col w440 h720 fill:surface shadow:lg role:dialog name:"Drawer"
  Head row between center p5
    Title text title ${q(p.title!)}
    @IconButton size=sm icon=close "Close"
  @Divider
  Body col gap5 p5 hfill
${indent(PATTERNS['description-list']!.rdl({ items: 'Run ID:RUN-2481|Suite:Checkout regression|Branch:main|Commit:9f2c1ab|Triggered by:Asha Rao' }), 2)}
    @RunBar passed=142 failed=3 skipped=5 "Results"
  @Divider
  Actions row gap2 jend p4
    @Button variant=secondary ${q(p.secondary!)}
    @Button variant=primary ${q(p.primary!)}`,
  },
  'dropdown-menu': {
    category: 'Overlays',
    description: 'Menu of actions. "—" = separator; items starting with ! are destructive. icon via "Name>icon".',
    params: { items: 'Rename>edit|Duplicate>copy|Download results>download|—|!Delete>trash' },
    rdl: (p) => `Menu col p1 w224 fill:surface stroke:border r3 shadow:md role:menu
${items(p.items!).map((raw, i) => {
      if (raw === '—' || raw === '-') return `  Sep${i} row py1\n    @Divider`;
      const danger = raw.startsWith('!');
      const [label = '', icon] = raw.replace(/^!/, '').split('>');
      return `  Item${i} row gap2 center px3 h32 r2 role:menuitem${danger ? ' color:status.error.fg' : ''}
${icon ? `    Icon icon:${icon} w16 h16${danger ? '' : ' color:text.secondary'}\n` : ''}    Text body ${q(label)}`;
    }).join('\n')}`,
  },
  popover: {
    category: 'Overlays',
    description: 'Small anchored panel with title, text and a link.',
    params: { title: 'Flaky test', body: 'Failed in 2 of the last 10 runs on main.', action: 'See history' },
    rdl: (p) => `Popover col gap2 p4 w280 fill:surface stroke:border r3 shadow:md role:dialog
  Title text label ${q(p.title!)}
  Body text body-sm muted ${q(p.body!)}
${p.action ? `  @Link ${q(p.action)}` : ''}`,
  },
  'command-palette': {
    category: 'Overlays',
    description: 'Keyboard-first search across actions and entities.',
    params: { placeholder: 'Type a command or search…', items: 'Start a run>play>R|Create test case>plus>C|Go to reports>chart>G R|Invite teammate>user>' },
    rdl: (p) => `Palette col w560 fill:surface r4 shadow:lg role:dialog name:"Command palette"
  SearchRow row p3
    @SearchInput ${q(p.placeholder!)}
  @Divider
  Results col gap0.5 p2 role:listbox
    Group text caption muted "Actions"
${items(p.items!).map((raw, i) => {
      const [label = '', icon = 'list', key = ''] = raw.split('>');
      return `    Item${i} row gap3 center px3 h40 r2${i === 0 ? ' fill:selected' : ''}
      Icon icon:${icon} w16 h16 color:text.secondary
      Text body wfill ${q(label)}
${key ? `      @Kbd ${q(key)}` : ''}`;
    }).join('\n')}`,
  },
  'toast-stack': {
    category: 'Feedback',
    description: 'Stacked toasts (bottom corner).',
    params: { items: 'success:Run started|neutral:Results exported|error:Could not reach runner' },
    rdl: (p) => `Toasts col gap2
${items(p.items!).map((it) => {
      const [variant = 'neutral', msg = ''] = it.split(':');
      return `  @Toast variant=${variant}${variant === 'success' ? ' action=Undo' : ''} ${q(msg)}`;
    }).join('\n')}`,
  },

  // ---------------------------------------------------------------- data
  table: {
    category: 'Data',
    description: 'Data table: header, rows with sensible cell types (Status column → status, Duration → mono), optional selection and pagination.',
    params: { cols: 'Run|Status|Duration|Started', rows: '5', select: 'false', pagination: 'true' },
    rdl: (p) => {
      const cols = items(p.cols!);
      const n = Math.min(20, Number(p.rows) || 5);
      const sel = p.select === 'true';
      const width = (c: string, i: number) => (i === 0 ? 'wfill' : /status/i.test(c) ? 'w120' : /owner|user|assignee/i.test(c) ? 'w160' : 'w112');
      const cell = (c: string, r: number, i: number) => {
        if (i === 0) return `      Cell0 col gap0.5 wfill\n        Name text body ${q(RUN_NAMES[r % RUN_NAMES.length]!)}\n        Id text caption muted mono ${q(`RUN-${2481 - r}`)}`;
        if (/status/i.test(c)) return `      Cell${i} row ${width(c, i)}\n        @Status variant=${STATUSES[r % STATUSES.length]}`;
        if (/duration|time/i.test(c)) return `      Cell${i} text body mono ${width(c, i)} ${q(DURATIONS[r % DURATIONS.length]!)}`;
        if (/owner|user|assignee/i.test(c)) return `      Cell${i} row gap2 center ${width(c, i)}\n        @Avatar size=xs ${q(['Asha Rao', 'Dev Patel', 'Mira Shah'][r % 3]!)}\n        Text body-sm ${q(['Asha Rao', 'Dev Patel', 'Mira Shah'][r % 3]!)}`;
        return `      Cell${i} text body-sm muted ${width(c, i)} ${q(WHEN[r % WHEN.length]!)}`;
      };
      const rowsRdl = Array.from({ length: n }, (_, r) => `  Row${r + 1} col wfill\n${r > 0 ? '    @Divider\n' : ''}    Line row px4 py3 gap4 center wfill\n${sel ? `      @Checkbox checked=${r === 1 ? 'true' : 'false'}\n` : ''}${cols.map((c, i) => cell(c, r, i)).join('\n')}`).join('\n');
      return `Table col wfill fill:surface stroke:border r3 clip role:table name:"Table"
  HeaderRow row px4 py2 gap4 center wfill fill:subtle role:row
${sel ? '    @Checkbox checked=false\n' : ''}${cols.map((c, i) => `    H${i} text label muted ${width(c, i)} ${q(c)}`).join('\n')}
${rowsRdl}${p.pagination === 'true' ? `\n  @Divider\n  Foot row between center px4 py2 wfill\n    Count text body-sm muted ${q(`1–${n} of 248`)}\n    @Pagination page=1 pages=50` : ''}`;
    },
  },
  list: {
    category: 'Data',
    description: 'List rows with avatar/icon, primary + secondary text, meta and chevron.',
    params: { items: 'Checkout regression:142 tests · main|Login smoke:24 tests · main|Payments:318 tests · release', icon: 'folder' },
    rdl: (p) => `List col wfill fill:surface stroke:border r3 role:list
${items(p.items!).map((it, i) => {
      const [title = '', meta = ''] = it.split(':');
      return `  Item${i} col wfill
${i > 0 ? '    @Divider\n' : ''}    Line row gap3 center px4 py3 wfill role:listitem
      Icon icon:${p.icon} w18 h18 color:text.secondary
      Texts col gap0.5 wfill
        Title text body ${q(title)}
        Meta text caption muted ${q(meta)}
      Icon icon:chevron-right w16 h16 color:text.secondary`;
    }).join('\n')}`,
  },
  'activity-feed': {
    category: 'Data',
    description: 'Who did what, when. items = "Name:did something:time|…".',
    params: { items: 'Asha Rao:started Checkout regression:2m ago|CI:marked Login smoke as flaky:1h ago|Dev Patel:commented on RUN-2479:3h ago' },
    rdl: (p) => `Activity col gap4 wfill
${items(p.items!).map((it, i) => {
      const [name = '', what = '', when = ''] = it.split(':');
      return `  Event${i} row gap3 start wfill
    @Avatar size=sm ${q(name)}
    Body col gap0.5 wfill
      Text body-sm ${q(`${name} ${what}`)}
      Time text caption muted ${q(when)}`;
    }).join('\n')}`,
  },
  accordion: {
    category: 'Data',
    description: 'Expandable sections. items = "Question::Answer|…", open = index.',
    params: { items: 'Why are some tests marked flaky?::A test is flaky when it both passes and fails on the same commit within the last 10 runs.|How long are runs kept?::Runs are kept for 90 days, then archived.|Can I re-run a single test?::Yes — open the run and choose Re-run on the test row.', open: '0' },
    rdl: (p) => `Accordion col wfill fill:surface stroke:border r3
${items(p.items!).map((it, i) => {
      const [title = '', body = ''] = it.split('::');
      const open = i === Number(p.open);
      return `  Section${i} col wfill
${i > 0 ? '    @Divider\n' : ''}    Head row between center px4 py3 wfill role:button
      Title text label ${q(title)}
      Icon icon:${open ? 'chevron-down' : 'chevron-right'} w16 h16 color:text.secondary
${open ? `    Body row px4 pb4 wfill\n      Text body-sm muted ${q(body)}` : ''}`;
    }).join('\n')}`,
  },
  tree: {
    category: 'Data',
    description: 'Two-level tree. items = "Folder>child,child|Folder>child".',
    params: { items: 'Checkout>Cart,Payment,Confirmation|Auth>Login,SSO|Search>Relevance', selected: 'Payment' },
    rdl: (p) => `Tree col gap0.5 w260 role:tree
${items(p.items!).map((it, i) => {
      const [folder = '', kids = ''] = it.split('>');
      return `  Node${i} row gap2 center px2 h32 wfill r2 role:treeitem
    Icon icon:chevron-down w14 h14 color:text.secondary
    Icon icon:folder w16 h16 color:text.secondary
    Text label ${q(folder)}
${kids.split(',').filter(Boolean).map((k, j) => `  Leaf${i}x${j} row gap2 center pl8 h32 wfill r2 role:treeitem${k === p.selected ? ' fill:selected color:link' : ''}
    Icon icon:list w16 h16${k === p.selected ? '' : ' color:text.secondary'}
    Text body-sm ${q(k)}`).join('\n')}`;
    }).join('\n')}`,
  },
  'description-list': {
    category: 'Data',
    description: 'Key/value details. items = "Key:Value|…" (ids/commits render mono).',
    params: { items: 'Run ID:RUN-2481|Branch:main|Commit:9f2c1ab|Triggered by:Asha Rao' },
    rdl: (p) => `Details col gap3 wfill
${items(p.items!).map((it, i) => {
      const [k = '', ...rest] = it.split(':');
      const val = rest.join(':');
      const mono = /^(RUN-|[0-9a-f]{7,}$)/.test(val);
      return `  Pair${i} row gap4 wfill\n    Key text body-sm muted w140 ${q(k)}\n    Value text body-sm${mono ? ' mono' : ''} wfill ${q(val)}`;
    }).join('\n')}`,
  },
  'avatar-group': {
    category: 'Data',
    description: 'A few avatars + overflow count.',
    params: { names: 'Asha Rao|Dev Patel|Mira Shah', more: '4' },
    rdl: (p) => `Avatars row gap1 center
${items(p.names!).map((n) => `  @Avatar size=sm ${q(n)}`).join('\n')}
${Number(p.more) > 0 ? `  @Chip variant=neutral ${q(`+${p.more}`)}` : ''}`,
  },

  // ---------------------------------------------------------------- testing (app-specific)
  'run-summary': {
    category: 'Testing',
    description: 'Run card: name, status, result bar, duration and time.',
    params: { title: 'Checkout regression', status: 'failed', passed: '139', failed: '3', skipped: '5', flaky: '2', duration: '11m 40s', when: '2 hours ago' },
    rdl: (p) => `RunSummary col gap3 p5 wfill fill:surface stroke:border r3
  Head row between center wfill
    Title text title-sm ${q(p.title!)}
    @Status variant=${p.status}
  @RunBar passed=${p.passed} failed=${p.failed} skipped=${p.skipped} flaky=${p.flaky}
  Meta row gap4 center
    Dur row gap1.5 center
      Icon icon:clock w14 h14 color:text.secondary
      Text caption muted ${q(p.duration!)}
    When row gap1.5 center
      Icon icon:calendar w14 h14 color:text.secondary
      Text caption muted ${q(p.when!)}`,
  },
  'test-case': {
    category: 'Testing',
    description: 'Test case detail: title, tags, steps with expected results, last results.',
    params: { title: 'User can pay with a saved card', id: 'TC-1042', tags: 'checkout|payments|smoke', steps: 'Open cart with 2 items::Cart shows total|Choose saved card::Card ending 4242 selected|Confirm payment::Order confirmation appears' },
    rdl: (p) => `TestCase col gap5 p6 wfill fill:surface stroke:border r3
  Head col gap2
    IdRow row gap2 center
      Id text caption muted mono ${q(p.id!)}
${items(p.tags!).map((tg) => `      @Tag ${q(tg)}`).join('\n')}
    Title text title ${q(p.title!)}
  Steps col gap3 role:list
${items(p.steps!).map((s, i) => {
      const [action = '', expected = ''] = s.split('::');
      return `    Step${i} row gap3 start wfill role:listitem
      Num w24 h24 fill:subtle rfull middle
        Text caption ${q(String(i + 1))}
      Body col gap0.5 wfill
        Action text body ${q(action)}
        Expected text body-sm muted ${q(`Expected: ${expected}`)}`;
    }).join('\n')}
  @RunBar size=sm passed=18 failed=1 flaky=1 "Last 20 runs"`,
  },

  // ---------------------------------------------------------------- marketing
  hero: {
    category: 'Marketing',
    description: 'Landing hero: specific headline (no "supercharge"), one-line value, primary + secondary CTA.',
    params: { title: 'Know which tests to trust.', body: 'Track runs, catch flaky tests, and share results with your team — in one calm place.', primary: 'Start free', secondary: 'See a demo' },
    rdl: (p) => `Hero col gap6 py16 maxw760
  Title text size:56 weight:700 ${q(p.title!)}
  Body text size:20 muted ${q(p.body!)}
  CTAs row gap3
    @Button variant=primary size=lg ${q(p.primary!)}
    @Button variant=secondary size=lg ${q(p.secondary!)}`,
  },
};

// ---------------------------------------------------------------- expansion

const PARAM = /([\w-]+)=("(?:[^"\\]|\\.)*"|\S+)/g;

/**
 * Expand `+pattern key=value …` lines into RDL (recursively, keeping indentation).
 * Unknown patterns or parameters produce readable errors.
 */
export function expandPatterns(src: string, depth = 0): string {
  if (depth > 4) throw new Error('Patterns nested too deeply');
  if (!src.includes('+')) return src;
  return src
    .split(/\r?\n/)
    .map((line) => {
      const m = /^(\s*)\+([\w-]+)(.*)$/.exec(line);
      if (!m) return line;
      const [, ws = '', name = '', rest = ''] = m;
      const spec = PATTERNS[name];
      if (!spec) throw new Error(`Unknown pattern "+${name}". Available: ${Object.keys(PATTERNS).join(', ')}`);
      const params: Record<string, string> = { ...spec.params };
      for (const pm of rest.matchAll(PARAM)) {
        const key = pm[1]!;
        if (!(key in spec.params)) throw new Error(`+${name} has no parameter "${key}". Parameters: ${Object.keys(spec.params).join(', ')}`);
        params[key] = pm[2]!.startsWith('"') ? (JSON.parse(pm[2]!) as string) : pm[2]!;
      }
      const body = spec.rdl(params).split('\n').filter((l) => l.trim()).map((l) => ws + l).join('\n');
      return expandPatterns(body, depth + 1);
    })
    .join('\n');
}

export function patternHelp(name?: string): string {
  const list = name ? Object.entries(PATTERNS).filter(([k]) => k === name) : Object.entries(PATTERNS);
  if (!list.length) return `No pattern "${name}".`;
  return list
    .map(([k, s]) => (name ? `+${k} — ${s.description}\n  params: ${Object.entries(s.params).map(([pk, pv]) => `${pk}=${q(pv)}`).join(' ')}` : `+${k} [${s.category}] — ${s.description}`))
    .join('\n');
}
