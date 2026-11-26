"""Weekly health check of the Worker's Page token (run on yammbo-server by a user timer).

The token itself never expires (expires_at=0), but Meta's data access for the user who
granted it lapses after 90 days without re-authorization (developers.facebook.com/docs/
facebook-login/auth-vs-data); Page permissions are listed as exempt, Instagram ones are
not mentioned. Alert on Telegram 21 days ahead, or at once if the token stops working.
Reads ~/.secrets/meta-app.env (META_APP_ID, META_APP_SECRET), ~/.secrets/meta-page-token
and ~/.secrets/servicios.env (Telegram). Never prints a token.
"""
import datetime as dt, json, os, urllib.error, urllib.parse, urllib.request

S = os.path.expanduser('~/.secrets')
env = lambda f: dict(l.strip().split('=', 1) for l in open(os.path.join(S, f)) if '=' in l and not l.startswith('#'))
app, tg = env('meta-app.env'), env('servicios.env')
pt = open(os.path.join(S, 'meta-page-token')).read().strip()


def say(text):
    body = json.dumps({'chat_id': tg['TELEGRAM_CHAT_ID'].strip('"'), 'text': text}).encode()
    urllib.request.urlopen(urllib.request.Request(f"https://api.telegram.org/bot{tg['TELEGRAM_BOT_TOKEN'].strip('\"')}/sendMessage", data=body, headers={'content-type': 'application/json'}), timeout=30)


fix = 'Para renovarlo: Explorador de la API Graph → app Yammbo Bot → generar token de usuario → mandármelo (5 min).'
try:
    q = urllib.parse.urlencode({'input_token': pt, 'access_token': app['META_APP_ID'] + '|' + app['META_APP_SECRET']})
    d = json.load(urllib.request.urlopen('https://graph.facebook.com/v21.0/debug_token?' + q, timeout=30))['data']
except Exception as e:
    say(f'🟠 No pude comprobar el token de Meta del publicador: {type(e).__name__}. Reviso mañana.'); raise SystemExit(1)
left = (dt.datetime.fromtimestamp(d['data_access_expires_at'], dt.timezone.utc) - dt.datetime.now(dt.timezone.utc)).days if d.get('data_access_expires_at') else None
print('valid', d.get('is_valid'), '| expires_at', d.get('expires_at'), '| data access days left', left)
if not d.get('is_valid'):
    say('🔴 El token de Meta del publicador dejó de valer: no se puede publicar en IG/FB. ' + fix)
elif left is not None and left <= 21:
    say(f'🟡 El acceso de Meta a los datos del publicador vence en {left} días. ' + fix)
