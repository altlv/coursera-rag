import { describe, it, expect } from 'vitest';
import {
  extractCodeBlocks,
  buildCanonicalSpellings,
  validateCodeSamples,
} from '../../server/answer-checks.js';

/*
 * Validating the code a model emits.
 *
 * For a documentation assistant the code is frequently the whole answer, so a
 * sample that does not compile is worse than prose that is merely vague. Two
 * defects were observed directly during development:
 *
 *   1. '@component' in lowercase - would not compile.
 *   2. '@Input()' and 'input()' mixed in a single sample - both real APIs, but
 *      one supersedes the other and using both together is incoherent.
 *
 * Casing is DERIVED from the corpus rather than hand-maintained. The docs already
 * contain the correct spellings, so a name the corpus only ever writes one way is
 * checkable without anyone curating a list that will go stale.
 *
 * Measured: of 2,033 normalised names, 1,908 have exactly one casing. The other
 * 125 are genuinely ambiguous - 'ViewChild' the decorator vs 'viewChild()' the
 * function, 'Input' vs 'input' - and those are skipped, because a casing check
 * cannot tell a legacy API from a modern one. That is what the API-pair check is
 * for, so the two cover each other's blind spot.
 *
 * Restricted to CODE BLOCKS. In prose "a component" is ordinary English, and
 * checking casing there would flag almost every answer.
 */

const chunk = (text) => ({ id: 'x', title: 't', path: '/p', url: '', text });

describe('extractCodeBlocks', () => {
  it('returns fenced blocks without the fences or language tag', () => {
    const blocks = extractCodeBlocks('Text.\n\n```ts\nconst a = 1;\n```\n\nMore.');
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toContain('const a = 1;');
    expect(blocks[0]).not.toContain('```');
    expect(blocks[0]).not.toMatch(/^ts/);
  });

  it('returns several blocks separately', () => {
    const blocks = extractCodeBlocks('```ts\na\n```\ntext\n```ts\nb\n```');
    expect(blocks).toHaveLength(2);
  });

  it('returns nothing for an answer with no code', () => {
    expect(extractCodeBlocks('Just prose about signals.')).toEqual([]);
  });

  it('ignores inline backticks, which are not samples', () => {
    // `signal()` in a sentence is a reference, not code to be compiled.
    expect(extractCodeBlocks('Use `signal()` to create one.')).toEqual([]);
  });
});

describe('buildCanonicalSpellings', () => {
  it('records the single casing a corpus uses for a name', () => {
    const canonical = buildCanonicalSpellings([
      chunk('Annotate with @Component and export the class.'),
      chunk('The @Component decorator takes a selector.'),
    ]);
    expect(canonical.get('component')).toBe('Component');
  });

  it('omits names the corpus spells more than one way', () => {
    // Both are real: the decorator and the signal query. Neither is "the" casing,
    // so the name must be excluded rather than arbitrarily resolved.
    const canonical = buildCanonicalSpellings([
      chunk('The @ViewChild decorator is legacy.'),
      chunk('Prefer the viewChild() function.'),
    ]);
    expect(canonical.has('viewchild')).toBe(false);
  });

  it('treats @Component and Component() as the same casing', () => {
    // The decoration differs; the casing does not. Counting these as a conflict
    // would exclude the very name the check was built for.
    const canonical = buildCanonicalSpellings([
      chunk('Use @Component here.'),
      chunk('The Component() factory is internal.'),
    ]);
    expect(canonical.get('component')).toBe('Component');
  });
});

describe('validateCodeSamples', () => {
  const canonical = buildCanonicalSpellings([
    chunk('Annotate the class with @Component and pass a selector.'),
    chunk('Inject HttpClient to make requests, and call inject() in the field initialiser.'),
    chunk('Register routes with provideRouter in the application config.'),
  ]);

  it('flags a miscased API name in a sample', () => {
    // The defect actually observed from a model.
    const result = validateCodeSamples({
      answer: '```ts\n@component({ selector: "app-x" })\nexport class X {}\n```',
      canonical,
    });
    expect(result.casing).toHaveLength(1);
    expect(result.casing[0]).toMatchObject({ found: 'component', expected: 'Component' });
    expect(result.ok).toBe(false);
  });

  it('accepts correctly cased code', () => {
    const result = validateCodeSamples({
      answer: '```ts\n@Component({})\nexport class X {\n  http = inject(HttpClient);\n}\n```',
      canonical,
    });
    expect(result.casing).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('ignores casing in prose, where lowercase is ordinary English', () => {
    // "a component" must not be reported. Without this the check fires on
    // virtually every answer and becomes noise.
    const result = validateCodeSamples({
      answer: 'You define a component and register it with providerouter somewhere.',
      canonical,
    });
    expect(result.casing).toEqual([]);
  });

  it('ignores names the corpus does not know', () => {
    // User-defined names in an illustrative sample have no canonical spelling.
    const result = validateCodeSamples({
      answer: '```ts\nconst myThing = new WidgetFactory();\n```',
      canonical,
    });
    expect(result.casing).toEqual([]);
  });

  it('ignores names the corpus spells several ways', () => {
    const ambiguous = buildCanonicalSpellings([
      chunk('The @ViewChild decorator.'),
      chunk('The viewChild() function.'),
    ]);
    const result = validateCodeSamples({
      answer: '```ts\n@ViewChild("x") thing;\n```',
      canonical: ambiguous,
    });
    expect(result.casing).toEqual([]);
  });

  it('flags a sample mixing a superseded API with its replacement', () => {
    // The second observed defect: both are real APIs, but using them together in
    // one sample is incoherent - one supersedes the other.
    const result = validateCodeSamples({
      answer: '```ts\nclass X {\n  @Input() a: string;\n  b = input<string>();\n}\n```',
      canonical,
    });
    expect(result.mixedApi).toHaveLength(1);
    expect(result.mixedApi[0]).toMatchObject({ old: '@Input()', replacement: 'input()' });
    expect(result.ok).toBe(false);
  });

  it('does not flag a sample using only the modern API', () => {
    const result = validateCodeSamples({
      answer: '```ts\nclass X {\n  b = input<string>();\n}\n```',
      canonical,
    });
    expect(result.mixedApi).toEqual([]);
  });

  it('does not flag a sample using only the legacy API', () => {
    /*
     * Deliberate. Teaching the legacy form alone is a currency problem, not an
     * incoherence one, and it is already handled by the prompt note from
     * api-pairs.js. Flagging it here would duplicate that and punish an answer
     * faithfully reflecting a page that only documents the old way.
     */
    const result = validateCodeSamples({
      answer: '```ts\nclass X {\n  @Input() a: string;\n}\n```',
      canonical,
    });
    expect(result.mixedApi).toEqual([]);
  });

  it('checks each block separately, so two samples are not conflated', () => {
    // Showing the old way and then the new way in two blocks is good teaching.
    // Only a mix WITHIN one sample is incoherent.
    const result = validateCodeSamples({
      answer: '```ts\n@Input() a: string;\n```\n\nOr the modern form:\n\n```ts\nb = input<string>();\n```',
      canonical,
    });
    expect(result.mixedApi).toEqual([]);
  });

  it('reports how many samples it examined', () => {
    // Same reasoning as the attribution check: "0 problems" must be
    // distinguishable from "nothing was looked at".
    expect(validateCodeSamples({ answer: 'prose only', canonical }).blocks).toBe(0);
    expect(
      validateCodeSamples({ answer: '```ts\nconst a = 1;\n```', canonical }).blocks,
    ).toBe(1);
  });

  it('survives an empty answer and a missing canonical map', () => {
    expect(validateCodeSamples({ answer: '', canonical }).ok).toBe(true);
    expect(validateCodeSamples({ answer: '```ts\n@component({})\n```' }).ok).toBe(true);
  });
});
