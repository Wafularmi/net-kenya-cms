import json
d = json.load(open(r'C:\Users\PASTOR~1\AppData\Local\Temp\batch.json'))
for k, v in sorted(d.items()):
    if isinstance(v, list):
        print(f'{k}: {len(v)}')
    else:
        print(f'{k}: (obj)')
