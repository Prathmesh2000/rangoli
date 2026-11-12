/** Local mode: the system's Edge or Chrome, in this process, exactly as a desktop install has always worked. */
import { EDIT_PAGE_OPTIONS, pageOptions, runEdit, runShot, type Page } from './execute.js';
import type { Renderer } from './port.js';

type Browser = { newPage(o: object): Promise<Page>; close(): Promise<void> };

/** Environment values Chromium never needs. Kept out of its environment even in local mode. */
const SECRET_ENV = /^(DB_|DATABASE_URL$|APP_DATABASE_URL$|AWS_|S3_|SES_|RENDER_SIGNING)|PASSWORD|SECRET|TOKEN/i;

export function browserEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter((e): e is [string, string] => e[1] !== undefined && !SECRET_ENV.test(e[0])));
}

export function inProcessRenderer(): Renderer {
  let browserP: Promise<Browser> | null = null;

  const browser = (): Promise<Browser> => {
    browserP ??= (async () => {
      let pw: { chromium: { launch(o: object): Promise<Browser> } };
      try {
        pw = (await import('playwright-core')) as unknown as typeof pw;
      } catch {
        throw new Error('Screenshots need playwright-core (npm i playwright-core) and Microsoft Edge or Google Chrome installed.');
      }
      const env = browserEnv();
      // a container has a known browser binary and cannot use Chromium's sandbox
      if (process.env.RANGOLI_BROWSER_PATH) return pw.chromium.launch({ executablePath: process.env.RANGOLI_BROWSER_PATH, headless: true, args: ['--no-sandbox'], env });
      for (const channel of ['msedge', 'chrome']) {
        try {
          return await pw.chromium.launch({ channel, headless: true, env });
        } catch {
          /* try next */
        }
      }
      throw new Error('No Edge or Chrome found for screenshots.');
    })();
    browserP.catch(() => (browserP = null));
    return browserP;
  };

  const withPage = async <T>(options: object, work: (p: Page) => Promise<T>): Promise<T> => {
    const page = await (await browser()).newPage(options);
    try {
      return await work(page);
    } finally {
      await page.close();
    }
  };

  return {
    shot: (job) => withPage(pageOptions(job), (p) => runShot(p, job)),
    edit: (job) => withPage(EDIT_PAGE_OPTIONS, (p) => runEdit(p, job)),
    close: async () => {
      if (browserP) await (await browserP).close().catch(() => undefined);
      browserP = null;
    },
  };
}
