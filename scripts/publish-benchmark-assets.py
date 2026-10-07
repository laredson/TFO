"""Attach benchmark assets to the existing RC without replacing any asset."""
from pathlib import Path
import hashlib, json, os, urllib.request, urllib.parse

repo=os.environ['GITHUB_REPOSITORY']
assert repo=='laredson/TFO'
token=os.environ['GH_TOKEN']
api='https://api.github.com/repos/'+repo
headers={'Authorization':'Bearer '+token,'User-Agent':'TFO-benchmark-publication','Accept':'application/vnd.github+json','X-GitHub-Api-Version':'2026-03-10'}
def request(url, method='GET', body=None, kind=None):
    h=dict(headers)
    if kind:h['Content-Type']=kind
    with urllib.request.urlopen(urllib.request.Request(url,data=body,headers=h,method=method),timeout=120) as response:
        return json.load(response)
release=request(api+'/releases/tags/v1.0.0-rc.3')
assert release['prerelease'] is True and release['draft'] is False
assets={a['name']:a for a in request(api+f'/releases/{release["id"]}/assets?per_page=100')}
out=Path('dist/benchmark')
for path in sorted(out.iterdir()):
    if path.suffix not in {'.zip','.txt','.json'}:continue
    data=path.read_bytes();digest='sha256:'+hashlib.sha256(data).hexdigest()
    if path.name in assets:
        old=assets[path.name]
        if old.get('digest')!=digest:
            raise RuntimeError('Existing asset differs; refusing overwrite: '+path.name)
        print('Already verified: '+path.name)
        continue
    url=f'https://uploads.github.com/repos/{repo}/releases/{release["id"]}/assets?name='+urllib.parse.quote(path.name)
    asset=request(url,'POST',data,'application/zip' if path.suffix=='.zip' else 'application/octet-stream')
    assert asset['size']==len(data) and asset.get('digest')==digest
    print('Published '+asset['name']+' '+asset['browser_download_url'])
marker='## Comparativa parcial Code Fragment'
if marker not in (release.get('body') or ''):
    body=(release.get('body') or '')+'\n\n'+marker+'\n\nSiete builds Windows y sus fuentes; Máximo, MaxHQ y Custom Astra ultra pendientes. Cinco tienen recorrido automático completo; Luna low y HQ conservan validación incompleta. Los tiempos incluyen interrupciones y el coste es una referencia API, no cuota ni facturación. No hay valoración humana de diversión.\n\n- [Descargar las siete builds](https://github.com/laredson/TFO/releases/download/v1.0.0-rc.3/builds_code_fragment_7_modos.zip)\n- [Resultados, límites y descargas individuales](https://github.com/laredson/TFO/tree/main/benchmarks/code-fragment-2026-10-07)\n- [Tablas de resultados y método](https://github.com/laredson/TFO/releases/download/v1.0.0-rc.3/resultados_code_fragment_7_modos.zip)\n\nLa prerelease conserva su condición de candidata; no se ha promovido a Latest.\n'
    request(api+f'/releases/{release["id"]}','PATCH',json.dumps({'body':body}).encode(),'application/json')
print('Benchmark publication verified; plugin assets and release status preserved.')
