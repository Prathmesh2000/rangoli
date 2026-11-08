/**
 * Patterns, part 2: auth, collaboration, marketing, commerce, developer and dashboard screens.
 * Same contract as patterns.ts — one line expands into ordinary, editable layers.
 */
import type { PatternSpec } from './patterns.js';

const q = (s: string) => JSON.stringify(s);
const items = (s: string) => s.split('|').map((x) => x.trim()).filter(Boolean);
/** "name:value" split at the FIRST colon, so values may contain colons (09:12) */
const pairs = (s: string) => items(s).map((x) => { const i = x.indexOf(':'); return (i < 0 ? [x.trim(), ''] : [x.slice(0, i).trim(), x.slice(i + 1).trim()]) as readonly [string, string]; });
const lines = (...l: (string | false | undefined)[]) => l.filter((x): x is string => typeof x === 'string').join('\n');
const ind = (s: string, n: number) => s.split('\n').map((l) => (l ? '  '.repeat(n) + l : l)).join('\n');

export const MORE_PATTERNS: Record<string, PatternSpec> = {
  // ---------------------------------------------------------------- auth
  login: {
    category: 'Auth',
    description: 'Sign-in card: product name, email + password, remember me, forgot link, SSO option and sign-up link.',
    params: { product: 'Rangoli QA', title: 'Sign in to your workspace', sso: 'Continue with Google', signup: 'Create an account' },
    rdl: (p) => lines(
      `Login col gap5 p8 w400 fill:surface stroke:border rcard shadow:sm`,
      `  Brand row gap2 center`,
      `    Logo w28 h28 rcontrol fill:primary.600 middle`,
      `      Icon icon:flask w16 h16 color:white`,
      `    Product text title-sm ${q(p.product!)}`,
      `  Title text title ${q(p.title!)}`,
      p.sso && `  @Button variant=secondary wfill ${q(p.sso)}`,
      p.sso && `  @Divider "or"`,
      `  Fields col gap4 wfill`,
      `    EmailField col gap1.5 wfill`,
      `      Label text label "Work email"`,
      `      @Input type=email "you@company.com"`,
      `    PasswordField col gap1.5 wfill`,
      `      LabelRow row between wfill`,
      `        Label text label "Password"`,
      `        @Link "Forgot password?"`,
      `      @Input type=password "••••••••"`,
      `    @Checkbox "Keep me signed in"`,
      `  @Button variant=primary wfill "Sign in"`,
      p.signup && `  Footer row gap1 jcenter wfill`,
      p.signup && `    Text body-sm muted "New here?"`,
      p.signup && `    @Link ${q(p.signup)}`,
    ),
  },
  signup: {
    category: 'Auth',
    description: 'Create-account card with name, email, password rules and terms.',
    params: { title: 'Create your account', subtitle: 'Free for 14 days. No card needed.' },
    rdl: (p) => lines(
      `Signup col gap5 p8 w420 fill:surface stroke:border rcard shadow:sm`,
      `  Head col gap1`,
      `    Title text title ${q(p.title!)}`,
      `    Sub text body-sm muted ${q(p.subtitle!)}`,
      `  Fields col gap4 wfill`,
      `    NameRow row gap3 wfill`,
      `      First col gap1.5 wfill`,
      `        Label text label "First name"`,
      `        @Input "Asha"`,
      `      Last col gap1.5 wfill`,
      `        Label text label "Last name"`,
      `        @Input "Rao"`,
      `    Email col gap1.5 wfill`,
      `      Label text label "Work email"`,
      `      @Input type=email "you@company.com"`,
      `    Password col gap1.5 wfill`,
      `      Label text label "Password"`,
      `      @Input type=password "At least 12 characters"`,
      `      Rules row gap3 wrap`,
      `        Rule1 row gap1 center`,
      `          Icon icon:check w14 h14 color:status.success.fg`,
      `          Text caption muted "12+ characters"`,
      `        Rule2 row gap1 center`,
      `          Icon icon:check w14 h14 color:status.success.fg`,
      `          Text caption muted "A number"`,
      `    @Checkbox "I agree to the Terms and Privacy Policy"`,
      `  @Button variant=primary wfill "Create account"`,
    ),
  },
  'verify-code': {
    category: 'Auth',
    description: 'One-time code step: where it was sent, code boxes, resend timer.',
    params: { email: 'asha@company.com', value: '48' },
    rdl: (p) => lines(
      `Verify col gap5 p8 w400 middle fill:surface stroke:border rcard shadow:sm`,
      `  IconWrap w48 h48 rfull fill:status.info.bg middle`,
      `    Icon icon:mail w24 h24 color:status.info.fg`,
      `  Head col gap1 center`,
      `    Title text title align:center "Check your email"`,
      `    Sub text body-sm muted align:center ${q(`We sent a 6-digit code to ${p.email}`)}`,
      `  @OTP value=${q(p.value!)}`,
      `  @Button variant=primary wfill "Verify"`,
      `  Resend text caption muted align:center "Didn't get it? Resend in 0:42"`,
    ),
  },

  // ---------------------------------------------------------------- collaboration
  kanban: {
    category: 'Collaboration',
    description: 'Board with columns of cards (title, tags, assignee). columns="Name:count|…".',
    params: { columns: 'To do:3|In progress:2|In review:1|Done:2' },
    rdl: (p) => {
      const titles = ['Flaky login on Safari', 'Add visual tests for cart', 'Retry policy for payments', 'Migrate to new runner', 'Seed data for staging', 'Document selectors guide', 'Fix timezone in reports', 'Parallelise checkout suite'];
      const tags = ['bug', 'e2e', 'infra', 'docs'];
      const people = ['Asha Rao', 'Ben Ortiz', 'Chen Wei', 'Dana Kim'];
      let k = 0;
      return lines(
        `Kanban row gap4 wfill start`,
        ...pairs(p.columns!).map(([name, count]) => {
          const n = Math.max(0, Number(count) || 0);
          return lines(
            `  Column col gap2 p2 w272 fill:subtle rcard`,
            `    ColumnHead row between center px2 py1 wfill`,
            `      Name row gap2 center`,
            `        Title text label ${q(name)}`,
            `        @Badge variant=neutral ${q(String(n))}`,
            `      @IconButton icon=plus size=sm "Add card"`,
            ...Array.from({ length: n }, () => {
              const i = k++;
              return lines(
                `    Card col gap2 p3 wfill fill:surface stroke:border rcard`,
                `      Title text body-sm weight:500 ${q(titles[i % titles.length]!)}`,
                `      Meta row between center wfill`,
                `        @Tag ${q(tags[i % tags.length]!)}`,
                `        @Avatar size=xs ${q(people[i % people.length]!)}`,
              );
            }),
          );
        }),
      );
    },
  },
  comments: {
    category: 'Collaboration',
    description: 'Comment thread with replies, resolve action and a composer.',
    params: { count: '3' },
    rdl: (p) => {
      const c = [
        ['Asha Rao', '2h', 'This step times out on CI but passes locally — can we wait for the network to go idle instead of a fixed sleep?'],
        ['Ben Ortiz', '1h', 'Agreed. I will switch it to waitForResponse on the cart API.'],
        ['Chen Wei', '20m', 'Pushed a fix in #482. Mind re-running the suite?'],
      ].slice(0, Number(p.count) || 3);
      return lines(
        `Comments col gap4 p4 w420 fill:surface stroke:border rcard`,
        `  Head row between center wfill`,
        `    Title text title-sm ${q(`${c.length} comments`)}`,
        `    @Button variant=ghost size=sm "Resolve"`,
        ...c.map(([who, when, body], i) => lines(
          `  Comment row gap3 wfill${i > 0 ? ' pl8' : ''}`,
          `    @Avatar size=sm ${q(who!)}`,
          `    Body col gap1 wfill`,
          `      Meta row gap2 center`,
          `        Author text label ${q(who!)}`,
          `        When text caption muted ${q(when!)}`,
          `      Text body-sm ${q(body!)}`,
        )),
        `  Composer row gap2 center wfill`,
        `    @Input wfill "Reply… use @ to mention"`,
        `    @IconButton icon=send variant=primary "Send"`,
      );
    },
  },
  chat: {
    category: 'Collaboration',
    description: 'Messaging: header, incoming/outgoing bubbles with times, typing indicator and composer.',
    params: { name: 'Release bot', status: 'Online' },
    rdl: (p) => lines(
      `Chat col w400 h560 fill:surface stroke:border rcard clip`,
      `  Header row gap3 center p4 wfill stroke:border/1/solid/b`,
      `    @Avatar size=sm tone=primary ${q(p.name!)}`,
      `    Who col wfill`,
      `      Name text label ${q(p.name!)}`,
      `      Status text caption muted ${q(p.status!)}`,
      `    @IconButton icon=more "More"`,
      `  Messages col gap3 p4 wfill hfill`,
      `    In col gap1 maxw280`,
      `      Bubble col p3 fill:subtle r:12,12,12,4`,
      `        Text body-sm "Nightly run finished: 142 passed, 3 failed."`,
      `      Time text caption muted "09:12"`,
      `    Out col gap1 end maxw280`,
      `      Bubble col p3 fill:action.primary r:12,12,4,12`,
      `        Text body-sm color:text.onPrimary "Which ones failed?"`,
      `      Time text caption muted "09:13"`,
      `    In2 col gap1 maxw280`,
      `      Bubble col p3 fill:subtle r:12,12,12,4`,
      `        Text body-sm "Checkout › applies coupon, and 2 in Search."`,
      `      Time text caption muted "09:13"`,
      `    Typing row gap1 center`,
      `      Text caption muted "Release bot is typing…"`,
      `  Composer row gap2 center p3 wfill stroke:border/1/solid/t`,
      `    @IconButton icon=paperclip "Attach"`,
      `    @Input wfill "Message"`,
      `    @IconButton icon=send variant=primary "Send"`,
    ),
  },
  notifications: {
    category: 'Collaboration',
    description: 'Notification panel: tabs, unread markers, grouped items with icons and a footer action.',
    params: {},
    rdl: () => {
      const n = [
        ['alert', 'status.error', 'Nightly run failed', '3 tests failed in Checkout', '5m', true],
        ['message', 'status.info', 'Ben mentioned you', '“@Asha can you review the retry policy?”', '1h', true],
        ['check', 'status.success', 'Suite fixed', 'Payments regression passed 10 runs in a row', '3h', false],
        ['user', 'status.neutral', 'Dana joined the workspace', 'Invited by you', 'Yesterday', false],
      ] as const;
      return lines(
        `Notifications col w380 fill:surface stroke:border rcard shadow:lg clip`,
        `  Head row between center px4 pt4 pb2 wfill`,
        `    Title text title-sm "Notifications"`,
        `    @Link "Mark all read"`,
        `  @Tabs selected=0 "All|Mentions:1|Runs"`,
        `  List col wfill`,
        ...n.map(([icon, tone, title, body, when, unread]) => lines(
          `    Item row gap3 p4 wfill${unread ? ' fill:selected' : ''} stroke:border/1/solid/b`,
          `      IconWrap w32 h32 rfull fill:${tone}.bg middle`,
          `        Icon icon:${icon} w16 h16 color:${tone}.fg`,
          `      Body col gap0.5 wfill`,
          `        Title text body-sm weight:${unread ? 600 : 500} ${q(title)}`,
          `        Text caption muted ${q(body)}`,
          `      When text caption muted ${q(when)}`,
        )),
        `  Footer row jcenter p3 wfill`,
        `    @Button variant=ghost size=sm "View all notifications"`,
      );
    },
  },
  'onboarding-checklist': {
    category: 'Collaboration',
    description: 'Getting-started checklist with progress; steps="Title:done|…".',
    params: { title: 'Get started', steps: 'Create a project:done|Connect your repository:done|Run your first suite|Invite your team|Set up Slack alerts' },
    rdl: (p) => {
      const s = pairs(p.steps!);
      const done = s.filter(([, d]) => d === 'done').length;
      const next = s.findIndex(([, d]) => d !== 'done');
      return lines(
        `Checklist col gap4 p5 w380 fill:surface stroke:border rcard`,
        `  Head col gap2 wfill`,
        `    Row row between center wfill`,
        `      Title text title-sm ${q(p.title!)}`,
        `      Count text caption muted ${q(`${done} of ${s.length}`)}`,
        `    @ProgressBar size=sm value=${Math.round((done / s.length) * 100)}`,
        `  Steps col gap1 wfill`,
        ...s.map(([name, d], i) => lines(
          `    Step row gap3 center p2 wfill rcontrol${i === next ? ' fill:subtle' : ''}`,
          d === 'done' ? `      Done w20 h20 rfull fill:status.success.bg middle\n        Icon icon:check w12 h12 color:status.success.fg` : `      Todo w20 h20 rfull stroke:border.strong/1.5`,
          `      Text body-sm wfill${d === 'done' ? ' muted strike' : ''} ${q(name)}`,
          i === next ? `      @Button variant=primary size=sm "Start"` : false,
        )),
      );
    },
  },
  timeline: {
    category: 'Collaboration',
    description: 'Vertical timeline of events with dots, connector line, times and optional detail.',
    params: { events: 'Run started:09:00|Checkout suite failed:09:12|Retried 3 flaky tests:09:14|Fix deployed:10:02|Run passed:10:20' },
    rdl: (p) => {
      const e = pairs(p.events!);
      return lines(
        `Timeline col w420`,
        ...e.map(([what, when], i) => {
          const bad = /fail/i.test(what), good = /pass|fix/i.test(what);
          return lines(
            `  Event row gap3 wfill`,
            `    Rail col center w16`,
            `      Dot w12 h12 rfull fill:${bad ? 'status.error.fg' : good ? 'status.success.fg' : 'border.strong'} stroke:surface/2`,
            i < e.length - 1 ? `      Line w2 h36 fill:border` : false,
            `    Body col gap0.5 wfill pb4`,
            `      What text body-sm weight:500 ${q(what)}`,
            `      When text caption muted ${q(when)}`,
          );
        }),
      );
    },
  },

  // ---------------------------------------------------------------- marketing / content
  navbar: {
    category: 'Marketing',
    description: 'Website navigation: logo, links, sign-in and primary call to action.',
    params: { product: 'Rangoli QA', links: 'Product|Pricing|Docs|Customers', cta: 'Start free' },
    rdl: (p) => lines(
      `Navbar row between center gap10 px8 py4 wfill`,
      `  Brand row gap2 center`,
      `    Logo w28 h28 rcontrol fill:primary.600 middle`,
      `      Icon icon:flask w16 h16 color:white`,
      `    Product text title-sm ${q(p.product!)}`,
      `  Links row gap6 center`,
      ...items(p.links!).map((l) => `    @Link variant=muted ${q(l)}`),
      `  Actions row gap2 center`,
      `    @Button variant=ghost "Sign in"`,
      `    @Button variant=primary ${q(p.cta!)}`,
    ),
  },
  'feature-grid': {
    category: 'Marketing',
    description: 'Section title + grid of features (icon, title, one line). features="icon:Title:Body|…".',
    params: { title: 'Everything your QA team needs', subtitle: 'From the first test to the thousandth run.', features: 'flask:Author fast:Write tests in plain language or code.|play:Run anywhere:Parallel runs on every pull request.|bug:Catch flakes:Auto-retry and quarantine unstable tests.|chart:See trends:Pass rate, duration and failure hot spots.|bell:Get alerted:Slack and email when a run breaks.|lock:Stay secure:SSO, audit log and data residency.' },
    rdl: (p) => lines(
      `Features col gap8 p12 wfill`,
      `  Head col gap2 center wfill`,
      `    Title text headline align:center ${q(p.title!)}`,
      `    Sub text body-lg muted align:center ${q(p.subtitle!)}`,
      `  Grid grid cols3 gap6 wfill`,
      ...items(p.features!).map((f) => {
        const [icon = 'check', title = '', body = ''] = f.split(':');
        return lines(
          `    Feature col gap3 wfill`,
          `      IconWrap w40 h40 rcontrol fill:status.info.bg middle`,
          `        Icon icon:${icon} w20 h20 color:status.info.fg`,
          `      Title text title-sm ${q(title)}`,
          `      Body text body-sm muted ${q(body)}`,
        );
      }),
    ),
  },
  testimonial: {
    category: 'Marketing',
    description: 'Customer quote with name, role and company.',
    params: { quote: 'We cut our flaky test rate from 9% to under 1% in a month. Release days are boring again — in the best way.', name: 'Dana Kim', role: 'QA Lead, Northwind' },
    rdl: (p) => lines(
      `Testimonial col gap5 p8 w640 fill:surface stroke:border rcard`,
      `  @Rating value=5`,
      `  Quote text title weight:500 ${q(`“${p.quote}”`)}`,
      `  Person row gap3 center`,
      `    @Avatar size=md ${q(p.name!)}`,
      `    Who col`,
      `      Name text label ${q(p.name!)}`,
      `      Role text caption muted ${q(p.role!)}`,
    ),
  },
  faq: {
    category: 'Marketing',
    description: 'Frequently asked questions; first item open. items="Question:Answer|…".',
    params: { title: 'Questions, answered', items: 'Do I need to change my test framework?:No. Rangoli runs Playwright, Cypress and Selenium suites as they are.|How is pricing calculated?:By parallel runners, not by seats — invite your whole team.|Can we self-host?:Yes, on the Enterprise plan, in your own cloud account.' },
    rdl: (p) => {
      const qa = items(p.items!).map((x) => { const i = x.indexOf(':'); return [x.slice(0, i), x.slice(i + 1)] as const; });
      return lines(
        `Faq col gap4 w720`,
        `  Title text headline ${q(p.title!)}`,
        `  Items col wfill stroke:border/1/solid/t`,
        ...qa.map(([question, answer], i) => lines(
          `    Item col gap2 py4 wfill stroke:border/1/solid/b`,
          `      Row row between center wfill`,
          `        Question text title-sm ${q(question)}`,
          `        Icon icon:${i === 0 ? 'chevron-up' : 'chevron-down'} w20 h20 color:text.secondary`,
          i === 0 ? `      Answer text body muted ${q(answer)}` : false,
        )),
      );
    },
  },
  'logo-cloud': {
    category: 'Marketing',
    description: 'Social proof: a line of customer names set as quiet wordmarks.',
    params: { title: 'Trusted by QA teams at', names: 'Northwind|Globex|Initech|Umbrella|Hooli|Stark' },
    rdl: (p) => lines(
      `LogoCloud col gap5 py8 center wfill`,
      `  Title text caption muted upper ls:0.08em ${q(p.title!)}`,
      `  Logos row gap10 center wrap jcenter`,
      ...items(p.names!).map((x) => `    Mark text title weight:700 ls:-0.02em color:text.secondary ${q(x)}`),
    ),
  },
  'cta-band': {
    category: 'Marketing',
    description: 'Closing call to action on a strong brand surface.',
    params: { title: 'Ship with confidence', body: 'Start free. Connect CI in five minutes.', primary: 'Start free', secondary: 'Book a demo' },
    rdl: (p) => lines(
      `CtaBand row between center gap6 p10 wfill fill:primary.700 rcard`,
      `  Copy col gap2`,
      `    Title text headline color:white ${q(p.title!)}`,
      `    Body text body-lg color:primary.100 ${q(p.body!)}`,
      `  Actions row gap3 center`,
      p.secondary && `    @Button variant=ghost color:white ${q(p.secondary)}`,
      `    @Button variant=secondary ${q(p.primary!)}`,
    ),
  },
  pricing: {
    category: 'Marketing',
    description: 'Pricing tiers side by side; one featured. tiers="Name:Price:Blurb|…", featured = tier index (1-based).',
    params: { tiers: 'Starter:$0:For side projects|Team:$49:For teams shipping daily|Scale:$199:SSO, audit log, priority support', featured: '2', period: '/month' },
    rdl: (p) => {
      const perks = [['Unlimited test runs', '2 parallel runners'], ['Everything in Starter', '10 parallel runners', 'Flaky test detection'], ['Everything in Team', 'Unlimited runners', 'SSO and audit log']];
      return lines(
        `Pricing row gap4 wfill stretch`,
        ...items(p.tiers!).map((tier, i) => {
          const [name = '', price = '', blurb = ''] = tier.split(':');
          const feat = String(i + 1) === p.featured;
          return lines(
            `  Tier col gap4 p6 wfill fill:surface rcard ${feat ? 'stroke:action.primary/2 shadow:md' : 'stroke:border'}`,
            `    Head row between center wfill`,
            `      Name text title-sm ${q(name)}`,
            feat ? `      @Chip variant=info "Most popular"` : false,
            `    PriceRow row gap1 baseline`,
            `      Price text display ${q(price)}`,
            `      Period text body-sm muted ${q(p.period!)}`,
            `    Blurb text body-sm muted ${q(blurb)}`,
            `    @Button variant=${feat ? 'primary' : 'secondary'} wfill ${q(i === 0 ? 'Start free' : `Choose ${name}`)}`,
            `    Perks col gap2 wfill`,
            ...(perks[i % perks.length] ?? []).map((perk) => lines(
              `      Perk row gap2 center`,
              `        Icon icon:check w16 h16 color:status.success.fg`,
              `        Text body-sm ${q(perk)}`,
            )),
          );
        }),
      );
    },
  },
  'blog-grid': {
    category: 'Marketing',
    description: 'Article cards: cover image slot, category, title, excerpt, author and date.',
    params: { count: '3' },
    rdl: (p) => {
      const posts = [
        ['Engineering', 'How we made checkout tests 4× faster', 'Sharding, warm browsers and fewer fixed waits.', 'Chen Wei', 'Mar 4'],
        ['Guides', 'A field guide to flaky tests', 'The six root causes we see most, and how to fix each.', 'Asha Rao', 'Feb 21'],
        ['Product', 'Visual testing is now built in', 'Catch layout regressions before your users do.', 'Ben Ortiz', 'Feb 9'],
      ].slice(0, Number(p.count) || 3);
      return lines(
        `Blog grid cols3 gap6 wfill`,
        ...posts.map(([cat, title, excerpt, who, when]) => lines(
          `  Post col wfill fill:surface stroke:border rcard clip`,
          `    Cover image wfill h160 alt:${q(title!)}`,
          `    Body col gap2 p5 wfill`,
          `      Category text caption weight:600 color:text.link upper ls:0.06em ${q(cat!)}`,
          `      Title text title-sm ${q(title!)}`,
          `      Excerpt text body-sm muted ${q(excerpt!)}`,
          `      Byline row gap2 center pt2`,
          `        @Avatar size=xs ${q(who!)}`,
          `        Text caption muted ${q(`${who} · ${when}`)}`,
        )),
      );
    },
  },

  // ---------------------------------------------------------------- commerce
  'product-card': {
    category: 'Commerce',
    description: 'Product tile: image, name, rating, price (with optional old price) and add to cart.',
    params: { name: 'Field Notebook, dotted', price: '$18', was: '$24', rating: '4', reviews: '128' },
    rdl: (p) => lines(
      `Product col w260 fill:surface stroke:border rcard clip`,
      `  Media col wfill`,
      `    Photo image wfill h220 alt:${q(p.name!)}`,
      p.was && `    Sale row abs at:12,12 px2 py0.5 rfull fill:status.error.bg`,
      p.was && `      Text caption weight:600 color:status.error.fg "Sale"`,
      `  Body col gap2 p4 wfill`,
      `    Name text body weight:500 ${q(p.name!)}`,
      `    RatingRow row gap2 center`,
      `      @Rating value=${Number(p.rating) || 4}`,
      `      Count text caption muted ${q(`(${p.reviews})`)}`,
      `    PriceRow row gap2 baseline`,
      `      Price text title-sm ${q(p.price!)}`,
      p.was && `      Was text body-sm muted strike ${q(p.was)}`,
      `    @Button variant=secondary wfill "Add to cart"`,
    ),
  },
  'product-grid': {
    category: 'Commerce',
    description: 'Shop listing: filter bar, result count and a grid of product cards.',
    params: { count: '4' },
    rdl: (p) => {
      const prods = [['Field Notebook, dotted', '$18', '$24'], ['Brass Pen', '$42', ''], ['Canvas Tote', '$29', ''], ['Desk Mat, felt', '$36', '$45'], ['Pencil Set', '$12', ''], ['Leather Folio', '$68', '']].slice(0, Number(p.count) || 4);
      return lines(
        `Shop col gap5 wfill`,
        `  Bar row between center wfill`,
        `    Text body-sm muted ${q(`${prods.length} products`)}`,
        `    Filters row gap2`,
        `      @Select size=sm "Category: All"`,
        `      @Select size=sm "Sort: Popular"`,
        `  Grid grid cols${Math.min(4, prods.length)} gap4 wfill`,
        ...prods.map(([name, price, was]) => ind(`+product-card name=${q(name!)} price=${q(price!)} was=${q(was!)}`, 2)),
      );
    },
  },
  'cart-summary': {
    category: 'Commerce',
    description: 'Order summary: line items with quantity, promo code, totals and an action (action="" to omit inside a checkout).',
    params: { action: 'Checkout' },
    rdl: (p) => {
      const li = [['Field Notebook, dotted', '2', '$36.00'], ['Brass Pen', '1', '$42.00']];
      return lines(
        `Cart col gap4 p5 w360 fill:surface stroke:border rcard`,
        `  Title text title-sm "Order summary"`,
        `  Items col gap3 wfill`,
        ...li.map(([name, qty, price]) => lines(
          `    Line row gap3 center wfill`,
          `      Thumb image w48 h48 rcontrol alt:${q(name!)}`,
          `      Info col wfill`,
          `        Name text body-sm weight:500 ${q(name!)}`,
          `        Qty text caption muted ${q(`Qty ${qty}`)}`,
          `      Price text body-sm ${q(price!)}`,
        )),
        `  Promo row gap2 wfill`,
        `    @Input size=sm wfill "Promo code"`,
        `    @Button variant=secondary size=sm "Apply"`,
        `  @Divider`,
        `  Totals col gap2 wfill`,
        `    Sub row between wfill`,
        `      Text body-sm muted "Subtotal"`,
        `      Text body-sm "$78.00"`,
        `    Ship row between wfill`,
        `      Text body-sm muted "Shipping"`,
        `      Text body-sm "Free"`,
        `    Total row between wfill`,
        `      Text title-sm "Total"`,
        `      Text title-sm "$78.00"`,
        p.action && `  @Button variant=primary size=lg wfill ${q(p.action)}`,
      );
    },
  },
  checkout: {
    category: 'Commerce',
    description: 'Checkout page: steps, contact + shipping form beside the order summary.',
    params: {},
    rdl: () => lines(
      `Checkout col gap6 p8 wfill fill:canvas`,
      `  @Stepper current=1 "Cart|Shipping|Payment|Review"`,
      `  Body row gap8 wfill start`,
      `    Form col gap5 wfill`,
      `      Title text title "Shipping details"`,
      `      Row1 row gap3 wfill`,
      `        F1 col gap1.5 wfill`,
      `          Label text label "Full name"`,
      `          @Input "Asha Rao"`,
      `        F2 col gap1.5 wfill`,
      `          Label text label "Phone"`,
      `          @Input "+91 98xxxxxx10"`,
      `      F3 col gap1.5 wfill`,
      `        Label text label "Address"`,
      `        @Input "Flat, street, area"`,
      `      Row2 row gap3 wfill`,
      `        F4 col gap1.5 wfill`,
      `          Label text label "City"`,
      `          @Input "Pune"`,
      `        F5 col gap1.5 wfill`,
      `          Label text label "PIN code"`,
      `          @Input "411001"`,
      `      Delivery col gap2 wfill`,
      `        Label text label "Delivery"`,
      `        @Radio checked=true "Standard — free, 3–5 days"`,
      `        @Radio "Express — $9, tomorrow"`,
      `      Actions row gap2 jend wfill`,
      `        @Button variant=ghost "Back to cart"`,
      `        @Button variant=primary "Continue to payment"`,
      `    +cart-summary action=""`,
    ),
  },
  'order-tracking': {
    category: 'Commerce',
    description: 'Order status: progress steps, expected date and shipment events.',
    params: { order: '#48213', eta: 'Arrives Thursday, 14 Mar' },
    rdl: (p) => lines(
      `Order col gap5 p6 w560 fill:surface stroke:border rcard`,
      `  Head row between center wfill`,
      `    Title text title-sm ${q(`Order ${p.order}`)}`,
      `    @Chip variant=info "In transit"`,
      `  Eta text title ${q(p.eta!)}`,
      `  @Stepper current=2 "Ordered|Packed|Shipped|Delivered"`,
      `  +timeline events="Order placed:Mon 09:20|Packed at Pune warehouse:Mon 16:05|Handed to courier:Tue 08:40|Out for delivery:Thu 07:55"`,
    ),
  },

  // ---------------------------------------------------------------- developer & data
  'stack-trace': {
    category: 'Developer',
    description: 'Failure detail: error summary, highlighted stack frames (yours vs library), and actions.',
    params: { error: 'TimeoutError: locator.click: Timeout 30000ms exceeded', test: 'checkout › applies coupon' },
    rdl: (p) => lines(
      `Failure col gap4 p5 wfill fill:surface stroke:border rcard`,
      `  Head row gap3 center wfill`,
      `    @Status variant=failed`,
      `    Test text title-sm wfill ${q(p.test!)}`,
      `    @Button variant=secondary size=sm "Copy"`,
      `    @Button variant=primary size=sm "Re-run"`,
      `  @Alert variant=error title=${q(p.error!)} "waiting for getByRole('button', { name: 'Apply' }) to be enabled"`,
      `  @CodeBlock lang=sh title="Stack trace" highlight=1,2 "at CartPage.applyCoupon (tests/pages/cart.ts:42:18)\\nat tests/checkout.spec.ts:17:5\\nat node_modules/@playwright/test/lib/worker.js:301:11\\nat async Promise.all (index 0)"`,
    ),
  },
  'log-viewer': {
    category: 'Developer',
    description: 'Run logs: level filters, search and monospaced lines with levels and timestamps.',
    params: {},
    rdl: () => {
      const L = [['09:12:01', 'INFO', 'Starting suite "Checkout" on 4 workers'], ['09:12:03', 'INFO', 'Browser chromium 132 ready'], ['09:12:41', 'WARN', 'Retrying "applies coupon" (1/2)'], ['09:13:12', 'ERROR', 'TimeoutError: locator.click: Timeout 30000ms exceeded'], ['09:13:13', 'INFO', 'Saved trace to traces/applies-coupon.zip']];
      const tone: Record<string, string> = { INFO: 'text.secondary', WARN: 'status.warning.fg', ERROR: 'status.error.fg' };
      return lines(
        `Logs col wfill fill:surface stroke:border rcard clip`,
        `  Bar row gap2 center p3 wfill stroke:border/1/solid/b`,
        `    @Segmented size=sm selected=0 "All|Warnings|Errors"`,
        `    @SearchInput size=sm wfill "Filter logs"`,
        `    @IconButton icon=download "Download logs"`,
        `  Lines col py2 wfill fill:subtle`,
        ...L.map(([time, level, msg]) => lines(
          `    Line row gap3 px4 py0.5 wfill${level === 'ERROR' ? ' fill:status.error.bg' : ''}`,
          `      Time text code muted ${q(time!)}`,
          `      Level text code w48 weight:600 color:${tone[level!]} ${q(level!)}`,
          `      Msg text code wfill ${q(msg!)}`,
        )),
      );
    },
  },
  'rich-text-editor': {
    category: 'Developer',
    description: 'Text editor: formatting toolbar (block type, bold/italic/underline, lists, link, code, image) and content.',
    params: { title: 'Release notes', body: 'This release makes checkout tests faster and less flaky.' },
    rdl: (p) => lines(
      `Editor col wfill fill:surface stroke:border rcard clip`,
      `  Toolbar row gap1 center p2 wfill stroke:border/1/solid/b`,
      `    @Select size=sm "Paragraph"`,
      `    @Divider orientation=vertical`,
      `    @IconButton icon=bold size=sm "Bold"`,
      `    @IconButton icon=italic size=sm "Italic"`,
      `    @IconButton icon=underline size=sm "Underline"`,
      `    @Divider orientation=vertical`,
      `    @IconButton icon=list size=sm "Bulleted list"`,
      `    @IconButton icon=quote size=sm "Quote"`,
      `    @IconButton icon=code size=sm "Code"`,
      `    @Divider orientation=vertical`,
      `    @IconButton icon=link size=sm "Link"`,
      `    @IconButton icon=image size=sm "Image"`,
      `  Content col gap3 p6 wfill minh200`,
      `    Title text headline ${q(p.title!)}`,
      `    Text body ${q(p.body!)}`,
      `    Hint text body muted "Type / for commands"`,
    ),
  },
  'calendar-month': {
    category: 'Data',
    description: 'Month calendar with weekday header, today, selected day and event dots.',
    params: { month: 'March 2026', start: '0', days: '31', today: '12', selected: '18', events: '3,12,18,24' },
    rdl: (p) => {
      const start = Number(p.start) || 0, days = Number(p.days) || 31;
      const ev = new Set(items(p.events!.replace(/,/g, '|')).map(Number));
      const cells: string[] = [];
      for (let i = 0; i < start; i++) cells.push(`    Blank h40`);
      for (let d = 1; d <= days; d++) {
        const sel = String(d) === p.selected, today = String(d) === p.today;
        cells.push(lines(
          `    Day col center gap0.5 h40 pt1 rcontrol${sel ? ' fill:action.primary' : today ? ' stroke:action.primary/1' : ''}`,
          `      Num text body-sm${sel ? ' color:text.onPrimary weight:600' : today ? ' weight:600 color:text.link' : ''} ${q(String(d))}`,
          ev.has(d) ? `      Dot w4 h4 rfull fill:${sel ? 'text.onPrimary' : 'action.primary'}` : false,
        ));
      }
      return lines(
        `Calendar col gap3 p4 w336 fill:surface stroke:border rcard`,
        `  Head row between center wfill`,
        `    Month text title-sm ${q(p.month!)}`,
        `    Nav row gap1`,
        `      @IconButton icon=chevron-left size=sm "Previous month"`,
        `      @IconButton icon=chevron-right size=sm "Next month"`,
        `  Week grid cols7 wfill`,
        ...['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'].map((d) => `    Wd text caption muted align:center ${q(d)}`),
        `  Days grid cols7 gap1 wfill`,
        ...cells,
      );
    },
  },
  'file-list': {
    category: 'Data',
    description: 'Files with type icon, size, owner, modified time and row actions.',
    params: {},
    rdl: () => {
      const f = [['folder', 'Fixtures', '—', 'Asha Rao', 'Today'], ['image', 'checkout-baseline.png', '412 KB', 'Ben Ortiz', 'Yesterday'], ['code', 'checkout.spec.ts', '6 KB', 'Chen Wei', 'Mar 2'], ['download', 'run-48213-trace.zip', '18.4 MB', 'CI bot', 'Mar 1']];
      return lines(
        `Files col wfill fill:surface stroke:border rcard clip`,
        `  Head row gap4 px4 py2 wfill fill:subtle stroke:border/1/solid/b`,
        `    H1 text caption muted weight:600 wfill "Name"`,
        `    H2 text caption muted weight:600 w96 "Size"`,
        `    H3 text caption muted weight:600 w140 "Owner"`,
        `    H4 text caption muted weight:600 w96 "Modified"`,
        `    Sp w32`,
        ...f.map(([icon, name, size, owner, when]) => lines(
          `  Row row gap4 center px4 py2 wfill stroke:border/1/solid/b`,
          `    NameCell row gap3 center wfill`,
          `      Icon icon:${icon} w18 h18 color:text.secondary`,
          `      Text body-sm weight:500 truncate ${q(name!)}`,
          `    Size text body-sm muted w96 ${q(size!)}`,
          `    Owner row gap2 center w140`,
          `      @Avatar size=xs ${q(owner!)}`,
          `      Text body-sm truncate ${q(owner!)}`,
          `    When text body-sm muted w96 ${q(when!)}`,
          `    @IconButton icon=more size=sm "Actions"`,
        )),
      );
    },
  },
  'profile-card': {
    category: 'Collaboration',
    description: 'Person card: avatar, name, role, stats and actions.',
    params: { name: 'Asha Rao', role: 'QA Lead · Checkout team', stats: 'Runs:1.2K|Fixed:86|Reviews:214' },
    rdl: (p) => lines(
      `Profile col gap4 p6 w320 center fill:surface stroke:border rcard`,
      `  @Avatar size=lg tone=primary ${q(p.name!)}`,
      `  Who col gap1 center`,
      `    Name text title-sm align:center ${q(p.name!)}`,
      `    Role text body-sm muted align:center ${q(p.role!)}`,
      `  Stats row gap6 jcenter wfill py3 stroke:border/1/solid/tb`,
      ...pairs(p.stats!).map(([k, val]) => lines(
        `    Stat col center`,
        `      Value text title-sm ${q(val)}`,
        `      Key text caption muted ${q(k)}`,
      )),
      `  Actions row gap2 wfill`,
      `    @Button variant=secondary wfill "Message"`,
      `    @Button variant=primary wfill "Follow"`,
    ),
  },
  'search-results': {
    category: 'Data',
    description: 'Search page: query field, result count, filters and results with highlighted type.',
    params: { query: 'coupon' },
    rdl: (p) => {
      const r = [['Test case', 'Checkout › applies coupon', 'Verifies a valid coupon reduces the total and shows the discount line.'], ['Run', 'Nightly #48213 — failed at "applies coupon"', 'Timeout on the Apply button after 30s.'], ['Defect', 'BUG-1182: Coupon field accepts expired codes', 'Reported by Ben Ortiz · Open']];
      return lines(
        `Search col gap5 w720`,
        `  @SearchInput wfill ${q(p.query!)}`,
        `  Meta row between center wfill`,
        `    Text body-sm muted ${q(`${r.length} results for “${p.query}”`)}`,
        `    @Segmented size=sm selected=0 "All|Tests|Runs|Defects"`,
        `  Results col gap4 wfill`,
        ...r.map(([type, title, body]) => lines(
          `    Result col gap1 wfill pb4 stroke:border/1/solid/b`,
          `      Type text caption weight:600 color:text.link upper ls:0.06em ${q(type!)}`,
          `      Title text title-sm ${q(title!)}`,
          `      Body text body-sm muted ${q(body!)}`,
        )),
      );
    },
  },
  'chart-card': {
    category: 'Data',
    description: 'Dashboard card: title, period selector, headline number with delta, and a chart.',
    params: { title: 'Pass rate', value: '98.1%', delta: '+1.4 pts vs last week', kind: 'line', data: '94.1,95.3,93.8,96.2,96.9,97.4,98.1', labels: 'Mon|Tue|Wed|Thu|Fri|Sat|Sun', unit: '%' },
    rdl: (p) => lines(
      `ChartCard col gap4 p5 wfill fill:surface stroke:border rcard`,
      `  Head row between center wfill`,
      `    Title text title-sm ${q(p.title!)}`,
      `    @Select size=sm w160 "Last 7 days"`,
      `  Figure row gap3 baseline`,
      `    Value text display ${q(p.value!)}`,
      `    Delta text body-sm color:status.success.fg ${q(p.delta!)}`,
      `  @Chart kind=${p.kind} w560 h200 data=${q(p.data!)} labels=${q(p.labels!)} unit=${q(p.unit!)}`,
    ),
  },
};
