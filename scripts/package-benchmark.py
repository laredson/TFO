"""Repackage the public benchmark payload; never rebuild the minigames."""
from pathlib import Path, PurePosixPath
import hashlib, io, json, tarfile, zipfile

BASE=Path(__file__).resolve().parents[1]
BENCH=BASE/'benchmarks/code-fragment-2026-10-07'
OUT=BASE/'dist/benchmark'
raw=(BENCH/'payload.tar.xz').read_bytes()
expected=(BENCH/'payload.sha256').read_text().split()[0]
assert hashlib.sha256(raw).hexdigest()==expected
content={}
with tarfile.open(fileobj=io.BytesIO(raw),mode='r:xz') as archive:
    for member in archive:
        path=PurePosixPath(member.name)
        assert member.isfile() and not path.is_absolute() and '..' not in path.parts
        assert member.name not in content
        content[member.name]=archive.extractfile(member).read()
index=json.loads(content['index.json'])
assert len(index)==7 and sum(n.endswith('.exe') for n in content)==7
OUT.mkdir(parents=True,exist_ok=True)

def make_zip(name, entries):
    target=OUT/name
    with zipfile.ZipFile(target,'w',compression=zipfile.ZIP_DEFLATED,compresslevel=6) as archive:
        for path, body in sorted(entries.items()):
            entry=zipfile.ZipInfo(path,date_time=(2026,10,7,0,0,0))
            entry.compress_type=zipfile.ZIP_DEFLATED
            entry.external_attr=0o100644<<16
            archive.writestr(entry,body,compresslevel=6)
    with zipfile.ZipFile(target) as archive:
        assert archive.testzip() is None
        assert all(archive.read(k)==v for k,v in entries.items())
    return target

make_zip('builds_code_fragment_7_modos.zip',{n.removeprefix('builds/'):v for n,v in content.items() if n.startswith('builds/')})
make_zip('fuentes_code_fragment_7_modos.zip',{n.removeprefix('sources/'):v for n,v in content.items() if n.startswith('sources/')})
stats={'README.md':content['README.md'],'index.json':content['index.json']}
for name,body in content.items():
    if name.startswith('statistics/'):
        relative=name.removeprefix('statistics/')
        stats[relative if relative=='METHOD.md' else 'data/'+relative]=body
make_zip('resultados_code_fragment_7_modos.zip',stats)
for item in index:
    stem=Path(item['zip']).stem
    entries={}
    for name,body in content.items():
        if name.startswith('builds/'+stem+'/'):
            entries[stem+'/Jugar/'+name.removeprefix('builds/'+stem+'/')]=body
        elif name.startswith('sources/'+stem+'/'):
            entries[stem+'/ProyectoDefold/'+name.removeprefix('sources/'+stem+'/')]=body
    entries[stem+'/configuracion-publica.json']=json.dumps(item,ensure_ascii=False,indent=2).encode()
    entries[stem+'/LEEME.md']=(f'# {item["game"]}\n\nModo: {item["label"]}\n\nExtrae el ZIP completo. El ejecutable y sus instrucciones están en Jugar. Los fuentes están en ProyectoDefold; abre game.project con Defold 1.13.1.\n\nEstado: {item["status"]}. Consulta el informe del benchmark para las limitaciones. No hay evaluación humana de diversión ni comprensión infantil.\n').encode()
    make_zip(item['zip'],entries)
manifest=[{'name':p.name,'bytes':p.stat().st_size,'sha256':hashlib.sha256(p.read_bytes()).hexdigest()} for p in sorted(OUT.glob('*.zip'))]
(OUT/'BENCHMARK_SHA256SUMS.txt').write_text(''.join(f'{p["sha256"]}  {p["name"]}\n' for p in manifest),encoding='ascii')
(OUT/'benchmark-manifest.json').write_text(json.dumps({'status':'partial','completedBuilds':7,'pendingModes':['maximum','max_hq','custom_astra_ultra'],'files':manifest},indent=2)+'\n',encoding='utf-8')
print(json.dumps(manifest))
