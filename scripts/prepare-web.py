"""Stage an allowlisted static site; never publish the repository root."""
from pathlib import Path
import shutil

ROOT = Path(__file__).resolve().parents[1]
DEST = ROOT / 'dist'
DEST.mkdir(exist_ok=True)
for name in ('index.html', '_routes.json', '_redirects', 'robots.txt'):
    shutil.copy2(ROOT / name, DEST / name)
for name in ('css', 'js', 'images', 'data'):
    shutil.copytree(ROOT / name, DEST / name, dirs_exist_ok=True)
print('Static site ready in dist/. Pages Functions remain in functions/.')
