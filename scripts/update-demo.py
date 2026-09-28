from pathlib import Path
import json
ROOT = Path(__file__).resolve().parents[1]
p = json.loads((ROOT / 'output/presentation_script.json').read_text(encoding='utf-8'))
# Legacy opening_v1 has a stable structural sequence. Never match narrative text.
if 'top_four' not in p.get('opening', {}):
    request = json.loads((ROOT / 'output/final_writer_request.json').read_text(encoding='utf-8'))
    p['opening']['top_four'] = [{k: f[k] for k in ('film_key', 'title', 'year') if k in f}
                              for f in request.get('payload', {}).get('top_four_films', [])]
if p.get('template') == 'opening_v1' and p['opening'].get('top_four_archetype', {}).get('requested'):
    p['events'][3]['cue'] = 'top_four_reveal'
    if p['opening'].get('archetype_text'):
        p['events'][4]['role'] = 'archetype_phrase'
# Publish only the visual contract, never AI requests, diagnostics or raw exports.
p = {k: p[k] for k in ('version', 'template', 'locale', 'profile', 'stats', 'opening', 'events') if k in p}
# The Profile Review, the explainability summary and the generation metadata are produced by the
# Pages Function, not by this pipeline. A regeneration keeps what the committed demo already
# carries instead of silently dropping those sections.
WEB_ONLY = ('profile_review', 'explainability', 'generation_meta', 'render')
demo_path = ROOT / 'data/demo-presentation.json'
if demo_path.exists():
    previous = json.loads(demo_path.read_text(encoding='utf-8'))
    for key in WEB_ONLY:
        if key not in p and key in previous:
            p[key] = previous[key]
    if any(key in p for key in WEB_ONLY):
        p['version'] = 'presentation-v2'

p['demo'] = True
(ROOT / 'data/demo-presentation.json').write_text(json.dumps(p, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
print('Demo updated from the real presentation. Review its public content before deployment.')
