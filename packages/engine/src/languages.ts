/**
 * Design languages: one knob set → a complete token system (colour, type, density, shape,
 * elevation, motion). The library reads only tokens, so switching language restyles every
 * component and pattern without touching a layer.
 *
 * These are *inspired by* well-known systems — implementation-neutral approximations of their
 * proportions and feel, not copies of their assets. Fonts degrade to system stacks offline.
 */
import type { TokenTree } from './model.js';
import { defaultTokens, type DefaultTokenOptions } from './tokens.js';

export interface DesignLanguage {
  id: string;
  name: string;
  /** one line: what it feels like */
  feel: string;
  /** where it fits — helps agents and humans pick */
  bestFor: string;
  options: DefaultTokenOptions;
}

const SYSTEM_SANS = ['system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'sans-serif'];

export const LANGUAGES: Record<string, DesignLanguage> = {
  rangoli: {
    id: 'rangoli', name: 'Rangoli (default)',
    feel: 'Calm, neutral product UI — 36px controls, 6px corners, quiet shadows.',
    bestFor: 'SaaS dashboards, internal tools, anything that should get out of the way.',
    options: {},
  },
  material: {
    id: 'material', name: 'Material-style',
    feel: 'Tonal and friendly — pill buttons, 40px controls, 12px cards, emphasized easing, regular-weight headings.',
    bestFor: 'Consumer apps, Android-first products, Google-ecosystem tools.',
    options: {
      brand: '#00658f',
      fontSans: ['Roboto', 'Google Sans', ...SYSTEM_SANS],
      fontDisplay: ['Google Sans', 'Roboto', ...SYSTEM_SANS],
      radius: [4, 8, 12, 16, 28], radiusControl: 'full', radiusCard: '3',
      controls: { xs: 24, sm: 32, md: 40, lg: 48 },
      type: {
        label: { size: 14, line: 20, weight: 500, tracking: '0.01em' },
        body: { size: 14, line: 20 }, 'body-lg': { size: 16, line: 24 },
        'title-sm': { size: 16, line: 24, weight: 500 },
        title: { size: 22, line: 28, weight: 400, tracking: '0' },
        headline: { size: 28, line: 36, weight: 400, tracking: '0' },
        display: { size: 36, line: 44, weight: 400, tracking: '-0.01em' },
      },
      shadows: {
        sm: ['0 1px 2px rgba(0,0,0,.3), 0 1px 3px 1px rgba(0,0,0,.15)', '0 1px 2px rgba(0,0,0,.6), 0 1px 3px 1px rgba(0,0,0,.3)'],
        md: ['0 1px 3px rgba(0,0,0,.3), 0 4px 8px 3px rgba(0,0,0,.15)', '0 1px 3px rgba(0,0,0,.6), 0 4px 8px 3px rgba(0,0,0,.3)'],
        lg: ['0 4px 4px rgba(0,0,0,.3), 0 8px 12px 6px rgba(0,0,0,.15)', '0 4px 4px rgba(0,0,0,.6), 0 8px 12px 6px rgba(0,0,0,.3)'],
      },
      easeOut: [0.05, 0.7, 0.1, 1], motionSpeed: 1.25,
    },
  },
  fluent: {
    id: 'fluent', name: 'Fluent-style',
    feel: 'Crisp and productive — 32px controls, 4px corners, semibold labels, layered ambient shadows.',
    bestFor: 'Productivity and Windows-first apps, enterprise tools, Office-like editors.',
    options: {
      brand: '#0f6cbd',
      fontSans: ['Segoe UI Variable', 'Segoe UI', ...SYSTEM_SANS],
      radius: [2, 4, 6, 8, 12], radiusControl: '2', radiusCard: '4',
      controls: { xs: 20, sm: 24, md: 32, lg: 40 },
      type: {
        label: { size: 14, line: 20, weight: 600 },
        body: { size: 14, line: 20 }, caption: { size: 12, line: 16 },
        title: { size: 20, line: 28, weight: 600, tracking: '0' },
        headline: { size: 28, line: 36, weight: 600, tracking: '0' },
        display: { size: 40, line: 52, weight: 600, tracking: '0' },
      },
      shadows: {
        sm: ['0 0 2px rgba(0,0,0,.12), 0 2px 4px rgba(0,0,0,.14)', '0 0 2px rgba(0,0,0,.24), 0 2px 4px rgba(0,0,0,.28)'],
        md: ['0 0 2px rgba(0,0,0,.12), 0 8px 16px rgba(0,0,0,.14)', '0 0 2px rgba(0,0,0,.24), 0 8px 16px rgba(0,0,0,.28)'],
        lg: ['0 0 8px rgba(0,0,0,.12), 0 32px 64px rgba(0,0,0,.14)', '0 0 8px rgba(0,0,0,.24), 0 32px 64px rgba(0,0,0,.28)'],
      },
      easeOut: [0.1, 0.9, 0.2, 1], motionSpeed: 0.85,
    },
  },
  cupertino: {
    id: 'cupertino', name: 'Apple-style (Cupertino)',
    feel: 'Airy and touch-sized — 44px controls, 17px body, continuous rounded corners, soft wide shadows.',
    bestFor: 'iOS/macOS-feeling products, consumer apps, premium hardware/brand sites.',
    options: {
      brand: '#0a72e8',
      fontSans: ['-apple-system', 'SF Pro Text', 'BlinkMacSystemFont', 'Helvetica Neue', 'system-ui', 'sans-serif'],
      fontDisplay: ['-apple-system', 'SF Pro Display', 'BlinkMacSystemFont', 'Helvetica Neue', 'system-ui', 'sans-serif'],
      neutralTint: 0.004,
      radius: [6, 8, 10, 14, 20], radiusControl: '3', radiusCard: '4',
      controls: { xs: 28, sm: 34, md: 44, lg: 50 },
      type: {
        caption: { size: 12, line: 16 }, label: { size: 15, line: 20, weight: 600 },
        'body-sm': { size: 15, line: 20 }, body: { size: 17, line: 22 }, 'body-lg': { size: 19, line: 24 },
        'title-sm': { size: 17, line: 22, weight: 600 },
        title: { size: 22, line: 28, weight: 700, tracking: '0' },
        headline: { size: 28, line: 34, weight: 700, tracking: '0.01em' },
        display: { size: 34, line: 41, weight: 700, tracking: '0.01em' },
      },
      shadows: {
        sm: ['0 1px 3px rgba(0,0,0,.08)', '0 1px 3px rgba(0,0,0,.5)'],
        md: ['0 4px 16px rgba(0,0,0,.08)', '0 4px 16px rgba(0,0,0,.5)'],
        lg: ['0 12px 40px rgba(0,0,0,.12)', '0 12px 40px rgba(0,0,0,.6)'],
      },
      easeOut: [0.25, 1, 0.5, 1], motionSpeed: 1.15,
    },
  },
  carbon: {
    id: 'carbon', name: 'Enterprise (Carbon-style)',
    feel: 'Square, flat, information-dense — 40px controls, 0 radius, no decorative shadow, light-weight large headings.',
    bestFor: 'Data-heavy enterprise software, admin consoles, regulated industries.',
    options: {
      brand: '#0f62fe', neutralSeed: '#6f6f6f', neutralTint: 0,
      fontSans: ['IBM Plex Sans', 'Helvetica Neue', 'Arial', 'sans-serif'],
      fontMono: ['IBM Plex Mono', 'ui-monospace', 'Menlo', 'Consolas', 'monospace'],
      radius: [0, 0, 0, 0, 0], radiusControl: '0', radiusCard: '0',
      controls: { xs: 24, sm: 32, md: 40, lg: 48 },
      type: {
        caption: { size: 12, line: 16, tracking: '0.02em' },
        label: { size: 14, line: 18, weight: 400, tracking: '0.01em' },
        body: { size: 14, line: 20, tracking: '0.01em' }, 'body-lg': { size: 16, line: 24 },
        'title-sm': { size: 16, line: 22, weight: 600 },
        title: { size: 20, line: 28, weight: 400, tracking: '0' },
        headline: { size: 28, line: 36, weight: 400, tracking: '0' },
        display: { size: 42, line: 50, weight: 300, tracking: '0' },
      },
      shadows: {
        sm: ['none', 'none'],
        md: ['0 2px 6px rgba(0,0,0,.3)', '0 2px 6px rgba(0,0,0,.8)'],
        lg: ['0 2px 6px rgba(0,0,0,.3)', '0 2px 6px rgba(0,0,0,.8)'],
      },
      easeOut: [0, 0, 0.38, 0.9], motionSpeed: 0.6,
    },
  },
  editorial: {
    id: 'editorial', name: 'Editorial',
    feel: 'Reading-first — serif headlines, warm paper neutrals, 16px body with long line height, hairline rules over boxes.',
    bestFor: 'Publishing, documentation, blogs, research and long-form reading products.',
    options: {
      brand: '#9a3b26', neutralSeed: '#8b6b3d', neutralTint: 0.018,
      fontSans: ['Inter', 'Source Sans 3', ...SYSTEM_SANS],
      fontDisplay: ['Source Serif 4', 'Charter', 'Iowan Old Style', 'Georgia', 'serif'],
      radius: [2, 3, 4, 6, 8], radiusControl: '1', radiusCard: '2',
      type: {
        caption: { size: 12, line: 18 },
        label: { size: 12, line: 16, weight: 600, tracking: '0.08em', textCase: 'uppercase' },
        'body-sm': { size: 14, line: 22 }, body: { size: 16, line: 26 }, 'body-lg': { size: 19, line: 30, family: 'display' },
        'title-sm': { size: 18, line: 26, weight: 600, family: 'display' },
        title: { size: 26, line: 32, weight: 600, tracking: '-0.005em' },
        headline: { size: 36, line: 42, weight: 600, tracking: '-0.015em' },
        display: { size: 52, line: 56, weight: 600, tracking: '-0.025em' },
      },
      shadows: {
        sm: ['0 1px 0 rgba(60,40,10,.08)', '0 1px 0 rgba(0,0,0,.5)'],
        md: ['0 6px 20px -8px rgba(60,40,10,.18)', '0 6px 20px -8px rgba(0,0,0,.6)'],
        lg: ['0 24px 48px -16px rgba(60,40,10,.22)', '0 24px 48px -16px rgba(0,0,0,.7)'],
      },
      easeOut: [0.22, 1, 0.36, 1], motionSpeed: 1.3,
    },
  },
  playful: {
    id: 'playful', name: 'Playful',
    feel: 'Chunky and warm — rounded type, pill controls, 20px cards, heavy headings, springy overshoot motion.',
    bestFor: 'Consumer, education, kids, games-adjacent and community products; onboarding moments.',
    options: {
      brand: '#d9480f',
      fontSans: ['Nunito', 'Quicksand', 'ui-rounded', 'system-ui', 'sans-serif'],
      radius: [8, 12, 16, 20, 28], radiusControl: 'full', radiusCard: '4',
      controls: { xs: 28, sm: 36, md: 44, lg: 52 },
      type: {
        label: { size: 15, line: 20, weight: 700 },
        body: { size: 15, line: 22 }, 'body-sm': { size: 14, line: 20 },
        'title-sm': { size: 17, line: 24, weight: 800 },
        title: { size: 22, line: 28, weight: 800, tracking: '-0.01em' },
        headline: { size: 30, line: 36, weight: 800, tracking: '-0.02em' },
        display: { size: 42, line: 46, weight: 900, tracking: '-0.03em' },
      },
      shadows: {
        sm: ['0 2px 0 rgba(16,24,40,.10)', '0 2px 0 rgba(0,0,0,.6)'],
        md: ['0 4px 0 rgba(16,24,40,.10), 0 8px 20px -6px rgba(16,24,40,.18)', '0 4px 0 rgba(0,0,0,.6)'],
        lg: ['0 6px 0 rgba(16,24,40,.10), 0 20px 40px -10px rgba(16,24,40,.25)', '0 6px 0 rgba(0,0,0,.6), 0 20px 40px -10px rgba(0,0,0,.7)'],
      },
      easeOut: [0.34, 1.56, 0.64, 1], motionSpeed: 1.2,
      controlShadow: ['0 2px 0 rgba(16,24,40,.12)', '0 2px 0 rgba(0,0,0,.6)'],
    },
  },
  brutalist: {
    id: 'brutalist', name: 'Neo-brutalist',
    feel: 'Loud and honest — square corners, hard offset shadows, grotesk display type, uppercase labels, instant motion.',
    bestFor: 'Portfolios, creative tools, indie products and marketing sites that want attitude.',
    options: {
      brand: '#1f3bff', neutralTint: 0,
      fontSans: ['Helvetica Neue', 'Arial', 'sans-serif'],
      fontDisplay: ['Space Grotesk', 'Archivo Black', 'Arial Black', 'Helvetica Neue', 'Arial', 'sans-serif'],
      fontMono: ['JetBrains Mono', 'ui-monospace', 'Menlo', 'Consolas', 'monospace'],
      radius: [0, 0, 0, 0, 0], radiusControl: '0', radiusCard: '0',
      controls: { xs: 28, sm: 36, md: 44, lg: 52 },
      type: {
        label: { size: 14, line: 18, weight: 700, tracking: '0.04em', textCase: 'uppercase' },
        caption: { size: 12, line: 16, family: 'mono' },
        'title-sm': { size: 17, line: 22, weight: 800, family: 'display' },
        title: { size: 24, line: 28, weight: 800, tracking: '-0.01em' },
        headline: { size: 36, line: 38, weight: 800, tracking: '-0.03em' },
        display: { size: 56, line: 56, weight: 900, tracking: '-0.04em' },
      },
      shadows: {
        sm: ['3px 3px 0 #111111', '3px 3px 0 #f2f2f2'],
        md: ['5px 5px 0 #111111', '5px 5px 0 #f2f2f2'],
        lg: ['8px 8px 0 #111111', '8px 8px 0 #f2f2f2'],
      },
      easeOut: [0.5, 0, 0.5, 1], motionSpeed: 0.5,
      inkBorders: true, controlShadow: ['3px 3px 0 #111111', '3px 3px 0 #f2f2f2'],
    },
  },
  web3: {
    id: 'web3', name: 'Web3',
    feel: 'Technical and luminous — geometric display type, mono details, soft pills, glowing elevation.',
    bestFor: 'dApps, protocols, NFT drops and crypto landing pages. Pair with the Neon or Midnight theme.',
    options: {
      brand: '#0ea47a',
      fontSans: ['Inter', ...SYSTEM_SANS],
      fontDisplay: ['Space Grotesk', 'Inter', ...SYSTEM_SANS],
      fontMono: ['JetBrains Mono', 'ui-monospace', 'Menlo', 'Consolas', 'monospace'],
      radius: [6, 10, 14, 18, 24], radiusControl: '4', radiusCard: '4',
      controls: { xs: 24, sm: 34, md: 40, lg: 48 },
      type: {
        label: { size: 14, line: 20, weight: 600 },
        title: { size: 22, line: 28, weight: 600, tracking: '-0.01em' },
        headline: { size: 32, line: 38, weight: 600, tracking: '-0.02em' },
        display: { size: 56, line: 60, weight: 600, tracking: '-0.03em' },
      },
      shadows: {
        sm: ['0 1px 3px rgba(14,164,122,.14)', '0 0 12px rgba(34,230,168,.14)'],
        md: ['0 6px 20px -4px rgba(14,164,122,.22)', '0 0 28px rgba(34,230,168,.2)'],
        lg: ['0 18px 48px -8px rgba(14,164,122,.3)', '0 0 60px rgba(34,230,168,.28)'],
      },
      easeOut: [0.16, 1, 0.3, 1], motionSpeed: 1.1,
    },
  },
  dense: {
    id: 'dense', name: 'Dense data',
    feel: 'Maximum information per pixel — 28px controls, 13px body, tight radii; for experts who live in the tool.',
    bestFor: 'Trading, observability, IDE-like tools, spreadsheets, log and test-result explorers.',
    options: {
      radius: [2, 4, 4, 6, 8], radiusControl: '2', radiusCard: '3',
      controls: { xs: 20, sm: 24, md: 28, lg: 32 },
      type: {
        caption: { size: 12, line: 16 }, label: { size: 12, line: 16, weight: 500 },
        'body-sm': { size: 12, line: 16 }, body: { size: 13, line: 18 }, 'body-lg': { size: 14, line: 20 },
        'title-sm': { size: 14, line: 20, weight: 600 },
        title: { size: 16, line: 22, weight: 600, tracking: '0' },
        headline: { size: 20, line: 26, weight: 600, tracking: '-0.01em' },
        display: { size: 24, line: 30, weight: 600, tracking: '-0.015em' },
        code: { size: 12, line: 16 },
      },
      motionSpeed: 0.7,
    },
  },
};

export interface LanguageInfo {
  id: string;
  /** user overrides kept on top of the language (brand, fonts, radius…) */
  options: DefaultTokenOptions;
}

/** Build the full token tree for a language; overrides (e.g. the user's brand) win. */
export function languageTokens(id: string, overrides: DefaultTokenOptions = {}): TokenTree {
  const lang = LANGUAGES[id];
  if (!lang) throw new Error(`unknown design language "${id}" — try: ${Object.keys(LANGUAGES).join(', ')}`);
  const base = lang.options;
  const opts: DefaultTokenOptions = { ...base, ...overrides, type: { ...base.type, ...overrides.type } };
  const tree = defaultTokens(opts);
  const info: LanguageInfo = { id, options: overrides };
  (tree as Record<string, unknown>).$extensions = { rangoli: { language: info } };
  return tree;
}

/** Which language (and overrides) a token tree was built from; documents made before languages are "rangoli". */
export function languageOf(tree: TokenTree): LanguageInfo {
  const ext = (tree as { $extensions?: { rangoli?: { language?: LanguageInfo } } }).$extensions;
  return ext?.rangoli?.language ?? { id: 'rangoli', options: {} };
}

export function languageHelp(): string {
  return Object.values(LANGUAGES).map((l) => `${l.id} — ${l.name}: ${l.feel} Best for: ${l.bestFor}`).join('\n');
}

/**
 * Add tokens introduced by newer versions (control sizes, radius roles, display font…) to an older
 * document's tree, generated from its own language. Never changes a token that already exists.
 */
export function upgradeTokens(tree: TokenTree): TokenTree {
  const lang = languageOf(tree);
  if (!LANGUAGES[lang.id]) return tree;
  const fresh = languageTokens(lang.id, lang.options);
  const fill = (into: Record<string, unknown>, from: Record<string, unknown>) => {
    for (const [k, v] of Object.entries(from)) {
      if (k.startsWith('$')) continue;
      if (!(k in into)) into[k] = structuredClone(v);
      else if (v && typeof v === 'object' && !('$value' in v) && into[k] && typeof into[k] === 'object' && !('$value' in (into[k] as object))) fill(into[k] as Record<string, unknown>, v as Record<string, unknown>);
    }
  };
  fill(tree as Record<string, unknown>, fresh as Record<string, unknown>);
  return tree;
}

export * from './fonts.js';
export * from './themes.js';
export * from './scene3d.js';
export * from './icons-svg.js';
