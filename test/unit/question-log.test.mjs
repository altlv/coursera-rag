import { describe, it, expect } from 'vitest';
import {
  redactSecrets,
  normalizeQuestion,
  buildIndex,
  DEFAULT_SIMILARITY_THRESHOLD,
} from '../../server/question-log.js';

/*
 * Question logging.
 *
 * The clustering rules are pure and synchronous on purpose, so they can be tested
 * without a filesystem - and re-run over the whole event log whenever the
 * threshold changes.
 */

/** A unit vector in 3-space, for readable similarity assertions. */
const unit = (x, y, z) => {
  const m = Math.hypot(x, y, z) || 1;
  return [x / m, y / m, z / m];
};

const ev = (question, vector, extra = {}) => ({
  question,
  vector,
  at: '2026-08-07T00:00:00.000Z',
  ...extra,
});

describe('redactSecrets', () => {
  it('strips OpenAI-style keys', () => {
    const out = redactSecrets('my key is sk-abcdefghijklmnopqrstuvwxyz123456 ok?');
    expect(out).not.toContain('sk-abcdefghijkl');
    expect(out).toContain('[REDACTED]');
  });

  it('strips Google and GitHub tokens', () => {
    expect(redactSecrets('AIzaSyD-1234567890abcdefghijklmnopqrstu')).toContain('[REDACTED]');
    expect(redactSecrets('ghp_1234567890abcdefghijklmnopqrstuvwx')).toContain('[REDACTED]');
  });

  it('strips bearer tokens', () => {
    expect(redactSecrets('Authorization: Bearer abcdefghijklmnopqrstuvwxyz')).toContain(
      '[REDACTED]',
    );
  });

  it('leaves ordinary questions untouched', () => {
    // Redaction must not mangle real questions - false positives would corrupt
    // the very data the log exists to collect.
    const q = 'how do I use inject() in a standalone component?';
    expect(redactSecrets(q)).toBe(q);
  });

  it('handles empty input', () => {
    expect(redactSecrets('')).toBe('');
    expect(redactSecrets(null)).toBe('');
  });
});

describe('normalizeQuestion', () => {
  it('ignores case, spacing and trailing punctuation', () => {
    expect(normalizeQuestion('  What ARE   Signals?? ')).toBe('what are signals');
  });

  it('keeps internal punctuation that carries meaning', () => {
    expect(normalizeQuestion('what is input()?')).toBe('what is input()');
  });
});

describe('buildIndex', () => {
  it('groups exact duplicates and counts them', () => {
    const clusters = buildIndex([
      ev('what are signals?', unit(1, 0, 0)),
      ev('What are signals?', unit(1, 0, 0)),
      ev('what are signals', unit(1, 0, 0)),
    ]);

    expect(clusters).toHaveLength(1);
    expect(clusters[0].total).toBe(3);
  });

  it('does NOT merge semantically by default', () => {
    /*
     * Automatic semantic merging is off because it was measured and does not work.
     * Across 30 known-distinct eval questions the maximum similarity between two
     * DIFFERENT questions was 0.712, while a genuine paraphrase scored 0.478 - the
     * distributions overlap completely, so no threshold separates them.
     */
    const clusters = buildIndex([
      ev('what are signals?', unit(1, 0, 0)),
      ev('explain Angular signals', unit(0.999, 0.04, 0)),
    ]);
    expect(clusters).toHaveLength(2);
  });

  it('never merges everything when the threshold is null', () => {
    // `score >= null` coerces to `score >= 0`, which would collapse the whole log
    // into one cluster. This pins the guard against that.
    const clusters = buildIndex(
      [ev('a', unit(1, 0, 0)), ev('b', unit(0, 1, 0)), ev('c', unit(0, 0, 1))],
      { threshold: null },
    );
    expect(clusters).toHaveLength(3);
  });

  it('KEEPS every distinct phrasing as its own variant when clustering is enabled', () => {
    /*
     * Collapsing phrasings would destroy the main thing real logs offer over
     * invented questions - how people actually word things - and each variant is a
     * candidate for the eval sets.
     */
    const clusters = buildIndex(
      [
        ev('what are signals?', unit(1, 0, 0)),
        ev('explain Angular signals', unit(0.99, 0.1, 0)),
        ev('what are signals?', unit(1, 0, 0)),
      ],
      { threshold: 0.9 },
    );

    expect(clusters[0].variants).toHaveLength(2);
    expect(clusters[0].variants.find((v) => v.text === 'what are signals?').count).toBe(2);
    expect(clusters[0].variants.find((v) => v.text === 'explain Angular signals').count).toBe(1);
  });

  it('does not merge below an explicit threshold', () => {
    const clusters = buildIndex(
      [ev('how do I test a component?', unit(1, 0, 0)), ev('how do I test a service?', unit(0.7, 0.7, 0))],
      { threshold: 0.9 },
    );
    expect(clusters).toHaveLength(2);
  });

  it('defaults semantic merging to disabled', () => {
    expect(DEFAULT_SIMILARITY_THRESHOLD).toBeNull();
  });

  it('respects an overridden threshold, so re-clustering is possible', () => {
    const events = [
      ev('a', unit(1, 0, 0)),
      ev('b', unit(0.8, 0.6, 0)),
    ];
    expect(buildIndex(events, { threshold: 0.99 })).toHaveLength(2);
    expect(buildIndex(events, { threshold: 0.5 })).toHaveLength(1);
  });

  it('orders clusters by how often they are asked', () => {
    const clusters = buildIndex([
      ev('rare question', unit(0, 1, 0)),
      ev('common question', unit(1, 0, 0)),
      ev('common question', unit(1, 0, 0)),
      ev('common question', unit(1, 0, 0)),
    ]);
    expect(clusters[0].canonical).toBe('common question');
    expect(clusters[0].total).toBe(3);
  });

  it('tallies outcomes and retrieved pages per cluster', () => {
    // This is what turns the log into eval-set material: a cluster that is often
    // asked and often refused is a gap worth fixing.
    const clusters = buildIndex([
      ev('what are signals?', unit(1, 0, 0), { status: 'answered', paths: ['/guide/signals'] }),
      ev('what are signals?', unit(1, 0, 0), { status: 'partial', paths: ['/guide/signals'] }),
    ]);

    expect(clusters[0].statuses).toEqual({ answered: 1, partial: 1 });
    expect(clusters[0].paths['/guide/signals']).toBe(2);
  });

  it('still groups when no vector is present', () => {
    // Vectors may be missing if retrieval failed; exact matching must still work.
    const clusters = buildIndex([ev('what are signals?', null), ev('What are signals?', null)]);
    expect(clusters).toHaveLength(1);
  });

  it('ignores blank questions', () => {
    expect(buildIndex([ev('   ', unit(1, 0, 0))])).toHaveLength(0);
  });

  it('records when a cluster was first and last seen', () => {
    const clusters = buildIndex([
      ev('q', unit(1, 0, 0), { at: '2026-01-01T00:00:00.000Z' }),
      ev('q', unit(1, 0, 0), { at: '2026-06-01T00:00:00.000Z' }),
    ]);
    expect(clusters[0].firstSeen).toBe('2026-01-01T00:00:00.000Z');
    expect(clusters[0].lastSeen).toBe('2026-06-01T00:00:00.000Z');
  });
});
