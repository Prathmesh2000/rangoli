import { describe, expect, it } from 'vitest';
import { createDocument } from './components.js';
import { lint } from './lint.js';
import { prototypeHtml } from './player.js';
import { serializePrototype } from './prototype.js';
import { applyRdl } from './rdl.js';

const setup = () => {
  const doc = createDocument();
  const a = applyRdl(doc, 'A col w400 h300 fill:surface\n  Text body "Plan: {{plan}}"\n  Panel col w100 h100 fill:subtle').created;
  const b = applyRdl(doc, 'B col w400 h300 fill:surface').created[0]!;
  return { doc, a: a[0]!, text: a[1]!, panel: a[2]!, b };
};

describe('prototype logic', () => {
  it('parses variables, conditions and visibility, and writes them back unchanged', () => {
    const { doc, a, panel, b } = setup();
    const script = `proto var plan=free seats=1 name="Asha Rao"\nproto #${a}\n  click set plan=pro seats=+1\n  click toggle agreed\n  click show #${panel}\n  key:x hide #${panel}\n  click toggle #${panel}\n  click navigate #${b} dissolve base out if plan=pro and seats>=2\n  click navigate #${b} dissolve base out if plan!=pro`;
    applyRdl(doc, script);
    const it = doc.data.prototype!.interactions[a]!;
    expect(doc.data.prototype!.variables).toEqual({ plan: 'free', seats: '1', name: 'Asha Rao' });
    expect(it[0]).toMatchObject({ action: 'set', variant: { plan: 'pro', seats: '+1' } });
    expect(it[1]).toMatchObject({ action: 'toggle', variable: 'agreed' });
    expect(it[2]).toMatchObject({ action: 'show', target: panel });
    expect(it[5]!.when).toEqual([{ name: 'plan', op: '=', value: 'pro' }, { name: 'seats', op: '>=', value: '2' }]);
    const out = serializePrototype(doc.data.prototype, {});
    expect(out).toContain('proto var plan=free seats=1 name="Asha Rao"');
    const again = createDocument();
    again.data.pages = doc.data.pages;
    applyRdl(again, out);
    expect(again.data.prototype).toEqual(doc.data.prototype);
  });

  it('undoes variable changes', () => {
    const { doc } = setup();
    applyRdl(doc, 'proto var a=1');
    applyRdl(doc, 'proto var b=2');
    expect(doc.data.prototype!.variables).toEqual({ a: '1', b: '2' });
    doc.undo();
    expect(doc.data.prototype!.variables).toEqual({ a: '1' });
    applyRdl(doc, 'proto var none');
    expect(doc.data.prototype!.variables).toBeUndefined();
  });

  it('rejects malformed logic with a useful message', () => {
    const { doc, a, b } = setup();
    expect(() => applyRdl(doc, `proto #${a}\n  click set`)).toThrow(/set needs/);
    expect(() => applyRdl(doc, `proto #${a}\n  click show`)).toThrow(/show needs/);
    expect(() => applyRdl(doc, `proto #${a}\n  click show #nope`)).toThrow(/not found/);
    expect(() => applyRdl(doc, `proto #${a}\n  click navigate #${b} if`)).toThrow(/condition/);
    expect(() => applyRdl(doc, `proto #${a}\n  click navigate #${b} if plan`)).toThrow(/condition/);
  });

  it('warns about a condition on a variable nothing sets', () => {
    const { doc, a, b } = setup();
    applyRdl(doc, `proto #${a}\n  click navigate #${b} if ghost=1`);
    expect(lint(doc).some((i) => i.code === 'P04' && i.message.includes('ghost'))).toBe(true);
    applyRdl(doc, 'proto var ghost=0');
    expect(lint(doc).some((i) => i.code === 'P04')).toBe(false);
  });

  it('ships variables and escapes them into the player', () => {
    const { doc } = setup();
    applyRdl(doc, 'proto var note="</script><b>"');
    const html = prototypeHtml(doc);
    expect(html).not.toContain('</script><b>');
    expect(html).toContain('"vars"');
  });
});
