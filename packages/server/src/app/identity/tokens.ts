/** Re-checking an API token at each agent tool call: still live, still covering the project, and with what scopes. */
import { tokenActor } from '../db.js';
import type { As } from '../http/context.js';
import type { TokenScope } from './scopes.js';

/** The scopes this token holds on this project right now, or null when it no longer works there. */
export type TokenGrants = (userId: string, tokenId: string, projectId: string) => Promise<TokenScope[] | null>;

export const createTokenGrants = (as: As): TokenGrants => (userId, tokenId, projectId) =>
  tokenActor.run(tokenId, async () => {
    const [row] = await as(userId, (q) => q<{ scopes: TokenScope[] | null }>(`SELECT token_scopes_on($1) AS scopes`, [projectId]));
    return row?.scopes ?? null;
  });
