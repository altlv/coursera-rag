import fs from 'fs/promises';
import path from 'path';
import { describe, it, expect, beforeAll } from 'vitest';
import { SUPERSEDED_APIS, detectSupersededApis, supersededApiNote } from '../../server/api-pairs.js';
import { buildPrompt } from '../../server/rag.js';

/*
 * Superseded-API notes.
 *
 * Background: the assistant taught @ViewChild without mentioning viewChild(), and a
 * user marked it unhelpful. Two retrieval-side fixes measured WORSE - MMR took
 * hit@3 from 93% to 80-87%, and raising maxPerPage to 87% - because the imbalance is
 * inside one page (/guide/components/queries: 5 passages mention @ViewChild, 1
 * mentions viewChild()) and no page-level ranking change can reach that.
 *
 * So the model is told the fact directly. These tests cover the logic, plus one
 * check on the corpus itself - because a hand-maintained list of API changes is
 * exactly the kind of thing that silently goes stale.
 */

const chunk = (text) => ({ title: 't', path: '/p', text });

describe('detectSupersededApis', () => {
  it('finds a legacy API in the passages', () => {
    const found = detectSupersededApis([chunk('Use @ViewChild(ChildComponent) child!: Child;')]);
    expect(found.map((f) => f.old)).toContain('@ViewChild');
  });

  it('reports whether the replacement is present too', () => {
    /*
     * The decisive distinction. When both forms appear, the model already has what
     * it needs and the conflict rules in SYSTEM_PROMPT cover it. Only when the
     * replacement is ABSENT can the model not know it exists - and that is the case
     * that produced a wrong answer.
     */
    const legacyOnly = detectSupersededApis([chunk('Use @ViewChild to query a child.')]);
    expect(legacyOnly[0].alsoHasReplacement).toBe(false);

    const both = detectSupersededApis([
      chunk('Use @ViewChild to query a child, or viewChild() for the signal form.'),
    ]);
    expect(both[0].alsoHasReplacement).toBe(true);
  });

  it('finds nothing in passages with no legacy API', () => {
    expect(detectSupersededApis([chunk('Signals are a reactive primitive.')])).toEqual([]);
  });

  it('handles empty input', () => {
    expect(detectSupersededApis([])).toEqual([]);
    expect(detectSupersededApis(null)).toEqual([]);
  });

  it('looks across all passages, not just the first', () => {
    const found = detectSupersededApis([
      chunk('Signals are reactive.'),
      chunk('Use @HostListener to react to events.'),
    ]);
    expect(found.map((f) => f.old)).toContain('@HostListener');
  });
});

describe('supersededApiNote', () => {
  it('names the modern form when only the legacy one is present', () => {
    const note = supersededApiNote([chunk('Use @ViewChild to query a child.')]);
    expect(note).toContain('@ViewChild');
    expect(note).toMatch(/viewChild\(\)/);
  });

  it('stays silent when the replacement is already in the passages', () => {
    // Adding a note here would be noise, and risks the model repeating a caveat the
    // passages already make.
    const note = supersededApiNote([
      chunk('Use @ViewChild, or viewChild() for the signal-based form.'),
    ]);
    expect(note).toBeNull();
  });

  it('stays silent when no legacy API appears', () => {
    expect(supersededApiNote([chunk('Signals are reactive.')])).toBeNull();
  });

  it('tells the model not to invent details about the modern form', () => {
    // The note names the replacement without describing it. Without this
    // instruction the model would happily fabricate its signature.
    const note = supersededApiNote([chunk('Use @Input() to accept data.')]);
    expect(note).toMatch(/do not invent/i);
  });

  it('warns that the passages may not mention the change', () => {
    const note = supersededApiNote([chunk('Use @Output() to emit.')]);
    expect(note).toMatch(/may not mention/i);
  });
});

describe('buildPrompt integration', () => {
  it('includes the note when passages carry only a legacy API', () => {
    const { user } = buildPrompt('how do I query a child?', [
      chunk('Use @ViewChild(ChildComponent) to get a reference.'),
    ]);
    expect(user).toMatch(/viewChild\(\)/);
    expect(user).toMatch(/modern Angular prefers/i);
  });

  it('omits it entirely for passages with no legacy API', () => {
    const { user } = buildPrompt('what are signals?', [chunk('A signal wraps a value.')]);
    expect(user).not.toMatch(/modern Angular prefers/i);
  });

  it('keeps the passages and question intact', () => {
    const { user } = buildPrompt('q', [chunk('Use @ViewChild here.')]);
    expect(user).toContain('Use @ViewChild here.');
    expect(user).toContain('Question: q');
  });
});

/*
 * A hand-maintained list of API changes goes stale silently. This checks the claims
 * against the actual corpus, so an entry that stops being true fails a test instead
 * of quietly misinforming users.
 */
describe('the list matches the corpus', () => {
  let corpus = null;

  beforeAll(async () => {
    try {
      const meta = JSON.parse(
        await fs.readFile(path.resolve('docs/angular/chunks.json'), 'utf8'),
      );
      corpus = meta.chunks.map((c) => c.text).join('\n');
    } catch {
      corpus = null;
    }
  });

  it('every replacement named actually appears in the docs', () => {
    if (!corpus) return console.warn('skipped: no corpus - run npm run build-embeddings');

    const missing = SUPERSEDED_APIS.filter((api) => !api.replacementPattern.test(corpus));
    expect(
      missing.map((m) => `${m.old} -> ${m.replacement}`),
      'a replacement is claimed that the corpus never mentions',
    ).toEqual([]);
  });

  it('every legacy API named still appears, so the note is worth emitting', () => {
    if (!corpus) return;

    // If a legacy form has vanished from the docs entirely, the entry is dead weight
    // and the note can never fire.
    const absent = SUPERSEDED_APIS.filter((api) => !api.pattern.test(corpus));
    expect(absent.map((a) => a.old), 'a legacy API is listed that the corpus no longer mentions').toEqual([]);
  });

  /*
   * Regression. These are generic functions and the docs use the type-argument form
   * heavily - measured, `output<` appears 7 times against `output(` 4, and
   * `viewChild<` 5 against 3. The original patterns matched only `name(`, so a
   * passage writing `input<string>()` was read as NOT containing the replacement,
   * and the prompt gained a note urging an API the passage already demonstrated.
   *
   * The test above did not catch it because it joins the whole corpus: one plain
   * `input(` anywhere made every entry pass. Detection is per-passage in
   * production, so it has to be tested per-passage here.
   */
  it('detects a replacement written with generic type arguments', () => {
    for (const api of SUPERSEDED_APIS) {
      const name = api.replacement.replace('()', '').trim();
      if (!/^[a-z][A-Za-z]*$/.test(name)) continue; // 'the host object' has no call form

      expect(
        api.replacementPattern.test(`readonly x = ${name}<string>();`),
        `${api.replacement} is not detected when written as ${name}<string>()`,
      ).toBe(true);
      // The plain form must keep working.
      expect(api.replacementPattern.test(`readonly x = ${name}();`)).toBe(true);
    }
  });

  it('does not emit a note when the passage shows the replacement generically', () => {
    // The end-to-end consequence of the bug above: both forms present, so the
    // model already has what it needs and a note would repeat a caveat.
    const chunks = [
      { text: 'Legacy code uses @Input() for inputs.' },
      { text: 'Prefer the signal form: readonly name = input<string>();' },
    ];
    expect(supersededApiNote(chunks)).toBeFalsy();
  });
});
