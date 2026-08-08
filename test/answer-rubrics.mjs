/*
 * What a correct ANSWER has to say, per question.
 *
 * Kept separate from golden-set.mjs and holdout-set.mjs on purpose: those describe
 * what retrieval must find, this describes what generation must say. Same
 * questions, different concern, and mixing them would mean a change to one
 * silently altering the other.
 *
 * Shape: question -> list of alternative-GROUPS. Every group must be satisfied by
 * at least one of its alternatives.
 *
 *   'how do I loop over a list?': [['@for', 'ngFor']]
 *
 * Alternatives exist because a correct answer may legitimately phrase a thing
 * differently, and because this corpus documents both modern and legacy APIs. An
 * answer teaching either is factually correct - demanding one exact spelling would
 * score a correct answer as a failure, the same mistake as asserting one exact
 * page instead of a set of acceptable ones.
 *
 * A requirement is deliberately the API or concept the answer MUST name, not a
 * paraphrase of the whole answer. This measures wrong and incomplete. It says
 * nothing about whether the prose is clear or well-ordered, and it should not
 * pretend to.
 *
 * Every requirement here is verified to appear in the corpus by
 * test/unit/rubrics.test.mjs. A term the docs never use is a bug in the rubric,
 * not a failure of the model - and without that check a rubric slowly becomes a
 * list of things the system can never satisfy.
 *
 * No entry for 'Got milk?' or 'What does CSS stand for?': those are scored on
 * STATUS, and a correct response to them mentions nothing in particular.
 */

export const ANSWER_RUBRICS = {
  // ---- golden set -------------------------------------------------------
  /*
   * 'signal(' not 'signal()'. The first version failed a correct answer that wrote
   * `signal(0)` - and the corpus agrees: `signal()` with empty parentheses appears
   * twice, `signal(0)` and `signal(false)` twelve times each. The requirement was
   * written from memory instead of from the documents.
   */
  'what are signals?': [['signal(', 'signal function']],
  'how do I react to a signal changing?': [['effect(', 'effect()']],
  'how do I pass data into a component?': [['input(', '@Input']],
  'how do I loop over a list in a template?': [['@for', 'ngFor']],
  'how does two-way binding work?': [['ngModel', 'model(', '[(']],
  'how do I validate a form?': [['Validators', 'validator']],
  'what are reactive forms?': [['FormControl', 'FormGroup']],
  'how do I protect a route from unauthorised users?': [['CanActivate', 'guard']],
  'how do I make an HTTP request?': [['HttpClient']],
  'how do I add an HTTP interceptor?': [['interceptor']],
  'how do I create an injectable service?': [['@Injectable', 'Injectable']],
  'what is content projection?': [['ng-content']],
  'what is a structural directive?': [['ng-template', 'ngIf', 'ngFor', '@if']],

  // ---- held-out set -----------------------------------------------------
  'how do I stop Angular from checking part of the component tree?': [
    ['OnPush', 'detach', 'ChangeDetectorRef'],
  ],
  'what is the difference between ng-container and ng-content?': [
    ['ng-container'],
    ['ng-content'],
  ],
  'how can I run code outside change detection to avoid extra work?': [
    ['runOutsideAngular', 'NgZone'],
  ],
  'how do I give a component access to the element it is rendered on?': [
    ['ElementRef', 'host'],
  ],
  'how do I load a route only when the user navigates to it?': [
    ['loadComponent', 'loadChildren', 'lazy'],
  ],
  'how do I keep a heavy computation from slowing down rendering?': [
    ['web worker', 'pure pipe', 'computed'],
  ],
  'how do I fetch data before a page is shown?': [['resolve']],
  'how do I reuse validation logic across several fields?': [['validate', 'schema']],
  'how do I attach a directive without putting it in the template?': [['hostDirectives']],
  'how do I find child elements from inside a component class?': [
    ['viewChild', 'ViewChild', 'contentChild'],
  ],
  /*
   * The first version listed 'withHttpTransferCache', which does NOT match
   * 'withHttpTransferCacheOptions' - requirements are matched on whole words, so a
   * prefix does not count. A correct answer naming the real API was scored as a
   * failure. The rubric also assumed the answer would come from the acceptable
   * PAGES, but /best-practices/performance/ssr outranked them and uses different
   * vocabulary. Both fixed by reading the corpus instead of guessing.
   */
  'how do I cache HTTP responses between server and browser?': [
    ['withHttpTransferCacheOptions', 'withNoHttpTransferCache', 'transferCache', 'TransferState'],
  ],
  'how do I make sure screen readers announce a change?': [['aria-live', 'LiveAnnouncer', 'aria']],
  'how do I delay rendering until something becomes visible?': [['@defer', 'defer']],
  'how do I share one instance of a service across only part of the app?': [
    ['providers', 'injector'],
  ],
  'how do I write a test that checks a form control became invalid?': [['invalid']],
};

/** Requirements for a question, or [] when nobody has written any. */
export function rubricFor(question) {
  return ANSWER_RUBRICS[question] ?? [];
}
