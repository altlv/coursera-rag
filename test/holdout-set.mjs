/*
 * Held-out evaluation set. NEVER used for tuning.
 *
 * Why it exists
 * -------------
 * Hybrid retrieval, the diversity cap and the score floor were all tuned while
 * measuring against test/golden-set.mjs, which now reports hit@3 13/13 and MRR
 * 1.000. A perfect score on the set you tuned against measures the tuning, not
 * the system - and it is saturated, so it cannot detect whether a change helped
 * or hurt. Contextual chunking was the first change to hit that wall: the golden
 * set reported identical numbers before and after, which is no evidence at all.
 *
 * How these questions differ, deliberately
 * ----------------------------------------
 * The golden set mostly asks about whole TOPICS, which page titles answer well -
 * "what are signals?" is served by a page called "Angular Signals". These target
 * specific details that live in the MIDDLE of long pages, where the passage has
 * no title-shaped hint of what it belongs to. That is exactly the case contextual
 * chunking is supposed to fix, so it is exactly what an honest test of it needs.
 *
 * Phrasing also avoids echoing page titles, so a match has to come from the body
 * rather than a lucky headline overlap.
 *
 * Rules for keeping this honest:
 *   - Do not tune anything while looking at these numbers.
 *   - Do not move a question here from the golden set, or vice versa.
 *   - If a question here starts failing, fix the system, not the question.
 */

export const HOLDOUT_SET = [
  {
    question: 'how do I stop Angular from checking part of the component tree?',
    acceptablePaths: ['/best-practices/skipping-subtrees', '/best-practices/runtime-performance'],
  },
  {
    question: 'what is the difference between ng-container and ng-content?',
    acceptablePaths: ['/guide/templates/ng-container', '/guide/templates/ng-content'],
  },
  {
    question: 'how can I run code outside change detection to avoid extra work?',
    acceptablePaths: ['/best-practices/zone-pollution', '/best-practices/runtime-performance'],
  },
  {
    question: 'how do I give a component access to the element it is rendered on?',
    acceptablePaths: ['/guide/components/host-elements', '/guide/components/dom-apis'],
  },
  {
    question: 'how do I load a route only when the user navigates to it?',
    acceptablePaths: ['/guide/routing/loading-strategies', '/best-practices/performance/lazy-loaded-routes'],
  },
  {
    question: 'how do I keep a heavy computation from slowing down rendering?',
    acceptablePaths: ['/best-practices/slow-computations', '/best-practices/runtime-performance'],
  },
  {
    question: 'how do I fetch data before a page is shown?',
    acceptablePaths: ['/guide/routing/data-resolvers'],
  },
  {
    question: 'how do I reuse validation logic across several fields?',
    acceptablePaths: ['/guide/forms/signals/cross-field-logic', '/guide/forms/form-validation'],
  },
  {
    question: 'how do I attach a directive without putting it in the template?',
    acceptablePaths: ['/guide/directives/directive-composition-api'],
  },
  {
    question: 'how do I find child elements from inside a component class?',
    acceptablePaths: ['/guide/components/queries', '/guide/signals/queries'],
  },
  {
    question: 'how do I cache HTTP responses between server and browser?',
    acceptablePaths: ['/guide/http/making-requests', '/guide/http/setup'],
  },
  {
    question: 'how do I make sure screen readers announce a change?',
    acceptablePaths: ['/best-practices/a11y'],
  },
  {
    question: 'how do I delay rendering until something becomes visible?',
    acceptablePaths: ['/guide/templates/defer', '/best-practices/performance/defer'],
  },
  {
    question: 'how do I share one instance of a service across only part of the app?',
    acceptablePaths: ['/guide/di/hierarchical-dependency-injection', '/guide/di/defining-dependency-providers'],
  },
  {
    question: 'how do I write a test that checks a form control became invalid?',
    acceptablePaths: ['/guide/forms/signals/testing', '/guide/forms/form-validation'],
  },
];
