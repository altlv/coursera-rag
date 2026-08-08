import { describe, it, expect } from 'vitest';
import {
  GROUNDING_RULES,
  STYLES,
  DEFAULT_STYLE,
  resolveStyle,
  buildSystemPrompt,
  listStyles,
} from '../../server/answer-styles.js';
import { NO_ANSWER_SENTINEL } from '../../server/rag.js';

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

  it('tells the explanatory and tutor styles to answer before elaborating', () => {
    // The specific complaint being fixed: answers that open by restating a
    // definition instead of answering the question asked.
    for (const name of ['explanatory', 'tutor']) {
      expect(STYLES[name].rules).toMatch(/open with a direct answer/i);
    }
  });

  it('forbids inventing a pitfall in the tutor style', () => {
    // "What newcomers get wrong" is exactly the kind of helpful-sounding content
    // a model will happily fabricate.
    expect(STYLES.tutor.rules).toMatch(/never invent a pitfall/i);
  });

  it('exposes each style for a switcher, with a description', () => {
    const listed = listStyles();
    expect(listed).toHaveLength(Object.keys(STYLES).length);
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
