"""Turn a short-lived user token (Graph API Explorer) into the Page token the Worker uses.

Reads ~/.secrets/meta-app.env (600): META_APP_ID, META_APP_SECRET, META_USER_TOKEN.
Writes ~/.secrets/meta-page-token (600). Prints only ids, names, scopes and expiry,
never a token. Steps follow developers.facebook.com/docs/facebook-login/guides/
access-tokens/get-long-lived: exchange for a long-lived user token, then
GET /{user-id}/accounts, whose Page tokens have no expiration date.

  python3 -I tools/page-token.py [page-id]
"""
import json, os, sys, urllib.error, urllib.parse, urllib.request

G = 'https://graph.facebook.com/v26.0'
SECRETS = os.path.expanduser('~/.secrets')


def env_file(path):
    out = {}
    for line in open(path):
        if '=' in line and not line.lstrip().startswith('#'):
            k, v = line.strip().split('=', 1)
            out[k] = v.strip().strip('"')
    return out


def get(path, **params):
    url = f'{G}/{path}?' + urllib.parse.urlencode(params)
    try:
        return json.load(urllib.request.urlopen(url, timeout=30))
    except urllib.error.HTTPError as e:
        err = json.loads(e.read().decode() or '{}').get('error', {})
        sys.exit(f"Graph error on /{path}: {err.get('message', e.code)} (code {err.get('code')})")


cfg = env_file(os.path.join(SECRETS, 'meta-app.env'))
app_id, secret, short = cfg['META_APP_ID'], cfg['META_APP_SECRET'], cfg['META_USER_TOKEN']
app_token = f'{app_id}|{secret}'

long_user = get('oauth/access_token', grant_type='fb_exchange_token', client_id=app_id,
                client_secret=secret, fb_exchange_token=short)['access_token']
me = get('me', fields='id,name', access_token=long_user)
dbg = get('debug_token', input_token=long_user, access_token=app_token)['data']
print('user:', me['name'], '| app:', dbg.get('application'), '| scopes:', ', '.join(dbg.get('scopes', [])))

pages = get(f"{me['id']}/accounts", fields='id,name,access_token,tasks', access_token=long_user).get('data', [])
for p in pages:
    print('page:', p['id'], p['name'], '| tasks:', ','.join(p.get('tasks', [])))
if not pages:
    sys.exit('No Pages returned: the token lacks pages_show_list, or the Page was not ticked when granting access.')
want = sys.argv[1] if len(sys.argv) > 1 else None
page = next((p for p in pages if p['id'] == want), None) if want else (pages[0] if len(pages) == 1 else None)
if not page:
    sys.exit('Several Pages: run again with the page id to use.')

ig = get(page['id'], fields='instagram_business_account{id,username}', access_token=page['access_token']).get('instagram_business_account')
pdbg = get('debug_token', input_token=page['access_token'], access_token=app_token)['data']
exp = pdbg.get('expires_at')
print('chosen page:', page['id'], page['name'])
print('instagram:', (ig or {}).get('id'), '@' + str((ig or {}).get('username')) if ig else 'NOT LINKED to this Page')
print('page token: valid', pdbg.get('is_valid'), '| expires:', 'never' if not exp else exp, '| scopes:', ', '.join(pdbg.get('scopes', [])))

dst = os.path.join(SECRETS, 'meta-page-token')
fd = os.open(dst, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
with os.fdopen(fd, 'w') as f:
    f.write(page['access_token'] + '\n')
print('saved to', dst, '(600)')
