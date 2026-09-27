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
p = {k: p[k] for k in ('version', 'template', 'locale', 'profile', 'stats', 'opening', 'events')}
p['demo'] = True
(ROOT / 'data/demo-presentation.json').write_text(json.dumps(p, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
print('Demo updated from the real presentation. Review its public content before deployment.')
