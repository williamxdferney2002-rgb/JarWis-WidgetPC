"""Summarize synthetic WGC/DXGI crops; never opens user screenshots.
python -B src-tauri/tests-manual/flicker-analyze.py <runtime-dir>
Pillow + numpy must already be available. Per-frame metadata is preserved.
"""
import json, sys
from pathlib import Path
import numpy as np
from PIL import Image

root = Path(sys.argv[1]).resolve()
data = json.loads((root/'results.json').read_text(encoding='utf-8'))
output = []
for run in data['runs']:
    roi = data['shield']['roi']
    expected = run['before']['rect'][0] + run['before']['rect'][2]/2
    rows = []
    for frame in run['frames']:
        a = np.array(Image.open(root/frame['file']).convert('RGB'))
        # Upper 50 physical pixels of the island; backdrop RGB=(39,77,87).
        a = a[15:65]
        mask = (a[:,:,0]<32)&(a[:,:,1]<40)&(a[:,:,2]<50)
        cols = np.where(mask.sum(axis=0)>3)[0]
        bbox = [int(cols[0])+roi[0],int(cols[-1])+1+roi[0]] if len(cols) else None
        center = sum(bbox)/2 if bbox else None
        shift = center-expected if center is not None else None
        rows.append({**frame,'headerX':bbox,'centerErrorPx':shift,
                     'blank':bbox is None,'jump':shift is not None and abs(shift)>6,
                     'whitePixels':int((a.min(axis=2)>240).sum())})
    gaps = [(b['qpc']-a['qpc'])/10000 for a,b in zip(rows,rows[1:])]
    output.append({'label':run['label'],'mode':run['mode'],'scenario':run['scenario'],
                   'action':run['action'],'frames':len(rows),'jumpFrames':sum(r['jump'] for r in rows),
                   'blankFrames':sum(r['blank'] for r in rows),
                   'maxCenterErrorPx':max((abs(r['centerErrorPx'] or 0) for r in rows),default=0),
                   'medianGapMs':float(np.median(gaps)) if gaps else None,
                   'maxGapMs':max(gaps,default=None),'rows':rows})
(root/'analysis.json').write_text(json.dumps(output),encoding='utf-8')
for r in output:
    print(json.dumps({k:v for k,v in r.items() if k!='rows'}))
