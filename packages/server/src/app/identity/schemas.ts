/** Input rules for who a person is. */
import { z } from 'zod';
import { MIN_PASSWORD } from '../auth.js';

export const email = z.string().trim().toLowerCase().email().max(254);
export const personName = z.string().trim().min(1, 'Enter a name').max(80);
export const password = z.string().min(MIN_PASSWORD, `Use at least ${MIN_PASSWORD} characters`).max(200);
