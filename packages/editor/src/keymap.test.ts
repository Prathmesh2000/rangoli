import { describe, expect, it } from 'vitest';
import { actionFor, clearKeys, conflictFor, keysFor, remap, resetKeys, shortcutLabel } from './keymap';

const key = (k: string, mods: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean }> = {}) => ({ key: k, ctrlKey: false, metaKey: false, altKey: false, ...mods });

describe('single-key shortcuts (WCAG 2.1.4)', () => {
  it('maps default keys, case-insensitively, and never with a modifier', () => {
    resetKeys();
    expect(actionFor(key('r'))).toBe('tool.rect');
    expect(actionFor(key('R'))).toBe('tool.rect');
    expect(actionFor(key('r', { ctrlKey: true }))).toBeUndefined();
    expect(actionFor(key('Backspace'))).toBe('delete');
  });

  it('remaps a key and takes it from the action that had it', () => {
    resetKeys();
    expect(conflictFor('v', 'tool.rect')).toBe('tool.select');
    remap('tool.rect', 'v');
    expect(actionFor(key('v'))).toBe('tool.rect');
    expect(actionFor(key('r'))).toBeUndefined();
    expect(keysFor('tool.select')).toEqual([]);
    expect(shortcutLabel('tool.rect')).toBe('V');
    resetKeys();
    expect(actionFor(key('v'))).toBe('tool.select');
  });

  it('can turn a shortcut off, and refuses navigation keys', () => {
    resetKeys();
    clearKeys('add');
    expect(actionFor(key('a'))).toBeUndefined();
    remap('add', 'Tab');
    expect(keysFor('add')).toEqual([]);
    remap('add', 'ArrowUp');
    expect(keysFor('add')).toEqual([]);
    resetKeys();
    expect(shortcutLabel('pan')).toBe('Space');
  });
});
