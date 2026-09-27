from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from src.analyzer import analyze
from src.parser import read_export

path = Path(sys.argv[1])
style = analyze(read_export(path))['review_style']
print('reviews', style['review_count'])
for row in style['phrases'][:20]:
    print('phrase', row['phrase'], row['count'])
for name, row in style['markup'].items():
    print('markup', name, row['count'])
for row in style['intersections'][:20]:
    print('intersection', row['phrase'], row['markup'], row['count'])
