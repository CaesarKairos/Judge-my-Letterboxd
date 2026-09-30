// How much material an account can actually support.
//
// ANALYST_STRONG_FINDINGS used to be a single universal number (4), which made a 100-review
// account stop exactly where a 12-film account stops. The target below is an EXPLORATION
// objective, never an acceptance quota: `desired_findings` says how far the Analyst should
// search, `minimum_usable_findings` says when a shorter session is still a real session.
// The tiers are documented so a regression is explainable instead of guessed.
export const FINDINGS_TIERS = [
  {tier: 'small', ceiling: 40, desired: 4, minimum: 2},
  {tier: 'medium', ceiling: 110, desired: 6, minimum: 4},
  {tier: 'rich', ceiling: 320, desired: 8, minimum: 4},
  {tier: 'very_rich', ceiling: Infinity, desired: 10, minimum: 4}
];

// Semantic findings are not measurements: they have no pool to run out of, so the target gets a
// small headroom above the deterministic pool instead of being clamped by it.
export const SEMANTIC_TARGET_HEADROOM = 4;
// Every tier asks for the same floor once the account can sustain it: four findings are a
// session, three are a shorter session that is still shipped (never a failure).
const USABLE_FLOOR = 4;

const count = (rows) => (Array.isArray(rows) ? rows.length : 0);

// The signal is a reading of the whole account, not of one table: reviews and rewatches weigh
// more per row because each one is authored behaviour, rates and sessions weigh what they are,
// and the deterministic pool weighs a little so a rich candidate set still counts.
export function richnessSignal({profile = {}, analysis = {}} = {}) {
  const reviews = count(profile.reviews);
  const rated = (profile.films || []).filter(film => Number.isFinite(film?.rating)).length;
  const sessions = count(profile.sessions);
  const rewatches = (profile.sessions || []).filter(session => session?.rewatch).length;
  const lists = count(profile.lists);
  const tags = analysis.overview?.tags || 0;
  const pool = count(analysis.moments);
  return Math.round(reviews * 1 + rated * .3 + sessions * .35 + rewatches * 1.2 + lists * 1.5 + tags * .25 + pool * .4);
}

export function accountRichness({profile = {}, analysis = {}} = {}) {
  const signal = richnessSignal({profile, analysis});
  const pool = count(analysis.moments);
  const tier = FINDINGS_TIERS.find(row => signal < row.ceiling) || FINDINGS_TIERS.at(-1);
  const minimum = Math.min(USABLE_FLOOR, Math.max(1, pool));
  const desired = Math.min(tier.desired, Math.max(minimum, pool + SEMANTIC_TARGET_HEADROOM));
  return {
    signal,
    tier: tier.tier,
    pool,
    desired_findings: desired,
    minimum_usable_findings: minimum,
    // Kept for the diagnostic logs that already printed a target per session.
    target: desired,
    tier_desired: tier.desired
  };
}

export function editorialTarget(profile, analysis) {
  return accountRichness({profile, analysis});
}
