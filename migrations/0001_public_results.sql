CREATE TABLE IF NOT EXISTS public_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_key TEXT NOT NULL,
  profile_display TEXT NOT NULL,
  judge_number INTEGER NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  locale TEXT NOT NULL,
  description TEXT NOT NULL,
  presentation_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(profile_key, judge_number)
);
CREATE INDEX IF NOT EXISTS public_results_profile ON public_results(profile_key, judge_number);
