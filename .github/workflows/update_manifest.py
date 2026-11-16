#!/usr/bin/env python3
"""원래 사이트의 최신 위치표(game manifest)를 받아 release.json과 manifest-<buildId>.json을 갱신한다.
(폴더 없이 저장소 맨 위에 둔다. GitHub 웹 업로드가 폴더를 못 올리기 때문.)

- release.json의 buildId가 바뀌었을 때만 위치표를 새로 받는다.
- 받은 위치표의 SHA-256이 buildId와 같은지 확인한다.
- 지금 버전과 바로 전 버전 위치표만 남기고 나머지는 지운다.

사용: python3 update_manifest.py
     python3 update_manifest.py --from-file 받은위치표.json   (사이트 대신 파일에서)
"""
import argparse
import hashlib
import json
import pathlib
import sys
import urllib.request

SOURCE = 'https://ios.reso.jhcloud.kr/'
ROOT = pathlib.Path(__file__).resolve().parent
DATA = ROOT
UA = 'Mozilla/5.0 (reso-personal-launcher manifest sync)'


def get(url: str) -> bytes:
    req = urllib.request.Request(url, headers={'User-Agent': UA, 'Cache-Control': 'no-cache'})
    try:
        with urllib.request.urlopen(req, timeout=60) as res:
            return res.read()
    except Exception as err:  # 네트워크 오류는 짧게 알리고 끝낸다
        raise SystemExit(f'받기 실패: {url} ({err}). 브라우저로 받아서 --from-file 로 넣어 주세요.')


def validate(manifest: dict) -> None:
    if manifest.get('format') != 1 or not isinstance(manifest.get('packs'), list) or not isinstance(manifest.get('files'), dict):
        raise SystemExit('위치표 형식이 올바르지 않습니다.')
    if 'index.html' not in manifest['files']:
        raise SystemExit('위치표에 index.html이 없습니다.')


def write_release(build_id: str, manifest: dict, raw_len: int, extra: dict) -> None:
    release = {
        'format': 1,
        'buildId': build_id,
        'gameVersion': str(manifest.get('gameVersion') or extra.get('gameVersion') or '?'),
        'manifestUrl': f'manifest-{build_id}.json',
        'manifestBytes': raw_len,
        'totalBytes': manifest.get('totalBytes'),
        'fileCount': manifest.get('fileCount'),
        'packCount': len(manifest['packs']),
    }
    for key in ('minimumIOS', 'archiveBytes'):
        if key in extra:
            release[key] = extra[key]
    (DATA / 'release.json').write_text(json.dumps(release, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


def prune(keep: set) -> None:
    for path in DATA.glob('manifest-*.json'):
        if path.stem.removeprefix('manifest-') not in keep:
            path.unlink()
            print('삭제:', path.name)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--from-file', help='사이트 대신 이미 받아 둔 위치표 JSON 파일을 쓴다')
    args = ap.parse_args()

    current = None
    release_path = DATA / 'release.json'
    if release_path.exists():
        current = json.loads(release_path.read_text(encoding='utf-8')).get('buildId')

    if args.from_file:
        raw = pathlib.Path(args.from_file).read_bytes()
        build_id = hashlib.sha256(raw).hexdigest()
        extra = {}
    else:
        remote = json.loads(get(SOURCE + 'release.json'))
        build_id = remote['buildId']
        extra = remote
        if build_id == current and (DATA / f'manifest-{build_id}.json').exists():
            print('변경 없음:', build_id[:8], remote.get('gameVersion'))
            return 0
        url = remote['manifestUrl']
        if not url.startswith('/game-manifest-'):
            raise SystemExit('예상과 다른 위치표 주소: ' + url)
        raw = get(SOURCE + url.lstrip('/'))
        if hashlib.sha256(raw).hexdigest() != build_id:
            raise SystemExit('받은 위치표의 해시가 buildId와 다릅니다.')

    manifest = json.loads(raw)
    validate(manifest)
    (DATA / f'manifest-{build_id}.json').write_bytes(raw)
    write_release(build_id, manifest, len(raw), extra)
    keep = {build_id} | ({current} if current else set())
    prune(keep)
    print('갱신:', (current or '없음')[:8], '→', build_id[:8], manifest.get('gameVersion'))
    return 0


if __name__ == '__main__':
    sys.exit(main())
