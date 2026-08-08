import { describe, it, expect } from 'vitest';
import {
  GROUNDING_RULES,
  STYLES,
  DEFAULT_STYLE,
  resolveStyle,
  buildSystemPrompt,
  listStyles,
} from '../../server/answer-styles.js';
import { NO_ANSWER_SENTINEL, buildPrompt } from '../../server/rag.js';

/*
 * Answer styles.
 *
 * Answers read like citations from the documentation rather than replies to a
 * question - a direct consequence of grounding, not a bug. Styles let that be
 * changed without touching what the model is allowed to claim.
 *
 * The property these tests exist to protect: A STYLE CHANGES PRESENTATION, NEVER
 * GROUNDING. The failure mode is subtle and expensive - a friendlier prompt that
 * quietly lets the model paraphrase further from its sources produces answers that
 * feel better and are less true, and a warm confident voice makes a wrong answer
 * more persuasive. So the invariant is asserted rather than assumed.
 */

describe('grounding is identical across every style', () => {
  it('includes every grounding rule, verbatim, in all styles', () => {
    // Line by line rather than as one blob, so a failure names the missing rule.
    const rules = GROUNDING_RULES.split('\n').filter(Boolean);

    for (const name of Object.keys(STYLES)) {
      const prompt = buildSystemPrompt(name, NO_ANSWER_SENTINEL);
      for (const rule of rules) {
        expect(prompt, `style "${name}" is missing: ${rule.slice(0, 60)}...`).toContain(rule);
      }
    }
  });

  it('keeps the refusal instruction in every style', () => {
    // A style that softened this would be a style that hallucinates politely.
    for (const name of Object.keys(STYLES)) {
      const prompt = buildSystemPrompt(name, NO_ANSWER_SENTINEL);
      expect(prompt).toContain(NO_ANSWER_SENTINEL);
      expect(prompt).toContain('Do not apologise, explain, or answer from your own knowledge');
    }
  });

  it('never lets a style contradict a grounding rule', () => {
    /*
     * A blunt check for the obvious ways a "friendlier" style could undo the
     * constraints - by inviting outside knowledge, or by excusing citations.
     */
    const forbidden = [
      /use your own knowledge/i,
      /if you are unsure,? (?:guess|make)/i,
      /citations? (?:are )?optional/i,
      /you may omit (?:the )?citations?/i,
    ];

    for (const [name, style] of Object.entries(STYLES)) {
      for (const pattern of forbidden) {
        expect(pattern.test(style.rules), `style "${name}" matches ${pattern}`).toBe(false);
      }
    }
  });

  it('varies only the presentation half between styles', () => {
    // Two prompts differ, but everything they differ by belongs to the style.
    const a = buildSystemPrompt('concise', NO_ANSWER_SENTINEL);
    const b = buildSystemPrompt('tutor', NO_ANSWER_SENTINEL);
    expect(a).not.toBe(b);

    const linesOnlyInB = b.split('\n').filter((line) => !a.includes(line));
    for (const line of linesOnlyInB) {
      expect(STYLES.tutor.rules).toContain(line);
    }
  });
});

describe('resolveStyle', () => {
  it('accepts every defined style', () => {
    for (const name of Object.keys(STYLES)) expect(resolveStyle(name)).toBe(name);
  });

  it('falls back rather than throwing on an unknown name', () => {
    // A typo in a setting must not stop the assistant answering.
    expect(resolveStyle('shakespearean')).toBe(DEFAULT_STYLE);
    expect(resolveStyle(undefined)).toBe(DEFAULT_STYLE);
    expect(resolveStyle('')).toBe(DEFAULT_STYLE);
  });

  it('is not fooled by inherited properties', () => {
    // 'constructor' and 'toString' are on every object; neither is a style.
    expect(resolveStyle('constructor')).toBe(DEFAULT_STYLE);
    expect(resolveStyle('toString')).toBe(DEFAULT_STYLE);
  });
});

describe('the styles themselves', () => {
  it('keeps concise as the original behaviour, so the change is reversible', () => {
    expect(STYLES.concise.rules).toContain('Prefer short, concrete explanations');
  });

  it('states behaviours rather than adjectives', () => {
    /*
     * The first version of these styles asked for "a direct answer" and "short,
     * concrete explanations" and changed NOTHING, because a model already believes
     * it is doing those things. Generic quality adjectives are no-ops.
     *
     * A crude proxy for "is this checkable": every style must contain at least one
     * absolute instruction, not just preferences.
     */
    for (const [name, style] of Object.entries(STYLES)) {
      // `concise` is exempt: it preserves the original preference-worded prompt
      // on purpose, as the baseline every other style is measured against.
      if (name === 'concise') continue;
      expect(
        /NEVER|Never|ENTIRE|must not|Do not|Begin with|Address the reader/.test(style.rules),
        `style "${name}" reads as preferences rather than behaviours`,
      ).toBe(true);
    }
  });

  it('requires the novelty styles to keep facts and code intact', () => {
    /*
     * lolcat and yoda exist to prove presentation is separable from truth. That
     * only holds if they are explicitly told to mangle the prose and nothing else -
     * a misspelled API name would be a genuinely wrong answer.
     */
    for (const name of ['lolcat', 'yoda']) {
      expect(STYLES[name].rules).toMatch(/FACTS must still be exactly right/);
      expect(STYLES[name].rules).toMatch(/citation must still be correct/);
      expect(STYLES[name].rules).toMatch(/code block/);
    }
  });

  it('forbids the opening that prompted all of this', () => {
    /*
     * The complaint was answers that begin "Dependency Injection (DI) is a design
     * pattern..." - the documentation's own first sentence. Asking politely for "a
     * direct answer" did nothing; forbidding the specific opening is what a model
     * can actually act on.
     */
    expect(STYLES.tutor.rules).toMatch(/must not name the feature/i);
    expect(STYLES.tutor.rules).toMatch(/Begin with the PROBLEM/);
  });

  it('forbids inventing a pitfall in the tutor style', () => {
    // "What newcomers get wrong" is exactly the kind of helpful-sounding content
    // a model will happily fabricate.
    expect(STYLES.tutor.rules).toMatch(/never invent a pitfall/i);
  });

  it('keeps the measurement baseline off the menu', () => {
    /*
     * `concise` is how "did this voice cost anything" gets answered, so it stays
     * defined and reachable via ANSWER_STYLE - but it is not a personality and has
     * no business in a switcher labelled Voice.
     */
    expect(STYLES.concise.hidden).toBe(true);
    expect(listStyles().map((s) => s.name)).not.toContain('concise');
    expect(resolveStyle('concise')).toBe('concise');
  });

  it('offers exactly the three voices', () => {
    expect(listStyles().map((s) => s.label)).toEqual(['Tutor', 'LOLcatz', 'Yoda']);
  });

  it('exposes each style for a switcher, with a description', () => {
    const listed = listStyles();
    expect(listed).toHaveLength(Object.keys(STYLES).filter((n) => !STYLES[n].hidden).length);
    for (const style of listed) {
      expect(style.name).toBeTruthy();
      expect(style.label).toBeTruthy();
      expect(style.description).toBeTruthy();
    }
  });

  it('defaults to a style that actually exists', () => {
    expect(Object.keys(STYLES)).toContain(DEFAULT_STYLE);
  });
});

describe('the styles are actually wired in', () => {
  /*
   * Every test above passed while buildPrompt was still using a hard-coded
   * SYSTEM_PROMPT and ignoring the style entirely. The styles were correct, the
   * assembly was correct, and nothing connected them - so switching voice in the
   * UI changed nothing at all.
   *
   * That is the same lesson as the store: testing a pure function proves the
   * function, never that anything calls it.
   */
  const chunks = [{ title: 'T', path: '/p', url: '', text: 'some passage text' }];

  it('produces a different system prompt per style', () => {
    const a = buildPrompt('q', chunks, { style: 'lolcat' });
    const b = buildPrompt('q', chunks, { style: 'tutor' });
    expect(a.system).not.toBe(b.system);
    expect(a.system).toContain('LOLspeak');
    expect(b.system).not.toContain('LOLspeak');
  });

  it('keeps the grounding rules in whatever style is asked for', () => {
    for (const name of Object.keys(STYLES)) {
      const { system } = buildPrompt('q', chunks, { style: name });
      expect(system).toContain('Answer ONLY using the numbered context passages');
      expect(system).toContain(NO_ANSWER_SENTINEL);
    }
  });

  it('falls back to the default style when none is given', () => {
    const fallback = buildPrompt('q', chunks, {});
    const explicit = buildPrompt('q', chunks, { style: DEFAULT_STYLE });
    expect(fallback.system).toBe(explicit.system);
  });

  it('does not let the user prompt vary with style', () => {
    // Only the SYSTEM half is presentation. The passages and the question must be
    // byte-identical, or comparing voices would not be comparing like with like.
    const a = buildPrompt('q', chunks, { style: 'lolcat' });
    const b = buildPrompt('q', chunks, { style: 'yoda' });
    expect(a.user).toBe(b.user);
  });
});
