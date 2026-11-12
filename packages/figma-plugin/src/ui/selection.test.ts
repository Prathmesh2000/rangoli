import { describe, expect, it } from 'vitest';

import { SelectionModel } from './selection.js';

const ORDER = ['p1', 'p2'];

describe('SelectionModel', () => {
  it('starts empty', () => {
    const model = new SelectionModel();
    expect(model.isEmpty()).toBe(true);
    expect(model.toSelection(ORDER)).toEqual({ pages: [] });
  });

  it('takes a whole page without needing its frames listed', () => {
    const model = new SelectionModel();
    model.setPage('p1', true);
    expect(model.pageState('p1')).toBe('all');
    expect(model.isFrameChecked('p1', 'anything')).toBe(true);
    expect(model.toSelection(ORDER)).toEqual({ pages: [{ pageId: 'p1', nodeIds: null }] });
  });

  it('turns a whole page into an explicit list when one frame is unticked', () => {
    const model = new SelectionModel();
    model.setKnownFrames('p1', ['a', 'b', 'c']);
    model.setPage('p1', true);
    model.setFrame('p1', 'b', false);
    expect(model.pageState('p1')).toBe('some');
    expect(model.toSelection(ORDER)).toEqual({ pages: [{ pageId: 'p1', nodeIds: ['a', 'c'] }] });
  });

  it('returns frames and pages in document order, whatever the tick order', () => {
    const model = new SelectionModel();
    model.setKnownFrames('p1', ['a', 'b']);
    model.setFrame('p2', 'x', true);
    model.setFrame('p1', 'b', true);
    model.setFrame('p1', 'a', true);
    expect(model.toSelection(ORDER)).toEqual({
      pages: [
        { pageId: 'p1', nodeIds: ['a', 'b'] },
        { pageId: 'p2', nodeIds: ['x'] },
      ],
    });
  });

  it('clears a page when its last frame is unticked', () => {
    const model = new SelectionModel();
    model.setFrame('p1', 'a', true);
    model.setFrame('p1', 'a', false);
    expect(model.pageState('p1')).toBe('none');
    expect(model.isEmpty()).toBe(true);
  });

  it('replaces frame picks when the page checkbox changes', () => {
    const model = new SelectionModel();
    model.setFrame('p1', 'a', true);
    model.setPage('p1', false);
    expect(model.isEmpty()).toBe(true);
  });
});
