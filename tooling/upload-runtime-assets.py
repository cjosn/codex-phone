import hashlib
import http.client
import json
import os
import sys
import urllib.request

TOKEN = os.environ.get('GITHUB_TOKEN', '')
REPO = 'cjosn/codex-phone'
TAG = os.environ.get('RELEASE_TAG', 'v1.6.3')
API = 'https://api.github.com'
DIST = r'C:\Users\13721\Documents\deepseek-harness\default-workspace\codex-go\dist'
TAR = os.path.join(DIST, 'runtime-arm64-v8a.tar.xz')
MANIFEST = os.path.join(DIST, 'runtime-arm64-v8a.json')

if not TOKEN:
    sys.exit('GITHUB_TOKEN missing')

HEAD = {
    'Authorization': 'Bearer ' + TOKEN,
    'User-Agent': 'codex-pocket-runtime-upload',
    'Accept': 'application/vnd.github+json',
}


def api(path, method='GET', body=None):
    data = json.dumps(body).encode() if body is not None else None
    headers = dict(HEAD)
    if data is not None:
        headers['Content-Type'] = 'application/json'
    request = urllib.request.Request(API + path, data=data, method=method, headers=headers)
    with urllib.request.urlopen(request, timeout=120) as response:
        raw = response.read().decode()
    return json.loads(raw) if raw else {}


def sha256_of(path, chunk=4 * 1024 * 1024):
    digest = hashlib.sha256()
    with open(path, 'rb') as handle:
        while True:
            block = handle.read(chunk)
            if not block:
                break
            digest.update(block)
    return digest.hexdigest()


def delete_asset_if_exists(release, name):
    for asset in release.get('assets', []):
        if asset['name'] == name:
            api(f'/repos/{REPO}/releases/assets/{asset["id"]}', 'DELETE')
            print('deleted old asset', name)


def upload_asset(release_id, path, name, content_type='application/octet-stream'):
    size = os.path.getsize(path)
    conn = http.client.HTTPSConnection('uploads.github.com', timeout=1800)
    conn.putrequest('POST', f'/repos/{REPO}/releases/{release_id}/assets?name={name}', skip_host=False, skip_accept_encoding=True)
    conn.putheader('Authorization', 'Bearer ' + TOKEN)
    conn.putheader('User-Agent', 'codex-pocket-runtime-upload')
    conn.putheader('Accept', 'application/vnd.github+json')
    conn.putheader('Content-Type', content_type)
    conn.putheader('Content-Length', str(size))
    conn.endheaders()
    with open(path, 'rb') as handle:
        sent = 0
        while True:
            block = handle.read(4 * 1024 * 1024)
            if not block:
                break
            conn.send(block)
            sent += len(block)
            if sent % (64 * 1024 * 1024) < 4 * 1024 * 1024:
                print(f'  ... {sent // (1024 * 1024)} MiB / {size // (1024 * 1024)} MiB')
    response = conn.getresponse()
    payload = response.read().decode()
    conn.close()
    if response.status >= 300:
        raise SystemExit(f'upload failed {response.status}: {payload[:400]}')
    return json.loads(payload)


def main():
    release = None
    for item in api(f'/repos/{REPO}/releases?per_page=20'):
        if item['tag_name'] == TAG:
            release = item
            break
    if release is None:
        sys.exit('release not found: ' + TAG)
    print('release', release['tag_name'], 'id', release['id'])

    digest = sha256_of(TAR)
    size_mb = round(os.path.getsize(TAR) / (1024 * 1024), 1)
    print('tar sha256', digest, 'sizeMb', size_mb)

    delete_asset_if_exists(release, 'runtime-arm64-v8a.tar.xz')
    delete_asset_if_exists(release, 'runtime-arm64-v8a.json')

    print('uploading runtime tar ...')
    tar_asset = upload_asset(release['id'], TAR, 'runtime-arm64-v8a.tar.xz')
    print('tar asset id', tar_asset['id'], 'size', tar_asset['size'])

    manifest = {
        'version': 'codex-app-server-0.170.0-arm64',
        'url': f'https://api.github.com/repos/{REPO}/releases/assets/{tar_asset["id"]}',
        'sha256': digest,
        'sizeMb': size_mb,
        'notes': 'Codex Pocket runtime (PRoot rootfs + node + codex 0.170). Download with Accept: application/octet-stream.',
    }
    with open(MANIFEST, 'w', encoding='utf-8', newline='\n') as handle:
        json.dump(manifest, handle, ensure_ascii=False, indent=2)
        handle.write('\n')
    print('manifest:', json.dumps(manifest, ensure_ascii=False))

    print('uploading runtime manifest ...')
    manifest_asset = upload_asset(release['id'], MANIFEST, 'runtime-arm64-v8a.json', 'application/json')
    print('manifest asset id', manifest_asset['id'])


if __name__ == '__main__':
    main()
