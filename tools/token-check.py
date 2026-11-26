"""Weekly health check of the Worker's Page token (run on yammbo-server by a user timer).

The token itself never expires (expires_at=0), but Meta's data access for the user who
granted it lapses after 90 days without re-authorization (developers.facebook.com/docs/
facebook-login/auth-vs-data); Page permissions are listed as exempt, Instagram ones are
not mentioned. Alert in the CRM (crm.yammbo.com, push) 21 days ahead, or at once if the token stops working.
Reads ~/.secrets/meta-app.env (META_APP_ID, META_APP_SECRET), ~/.secrets/meta-page-token
and the CRM hub key (via ~/proyectos/yammbo-crm/clients/hub.py). Never prints a token.
"""
import datetime as dt, json, os, sys, urllib.error, urllib.parse, urllib.request
sys.path.insert(0, os.path.expanduser('~/proyectos/yammbo-crm/clients'))
import hub  # noqa: E402

S = os.path.expanduser('~/.secrets')
env = lambda f: dict(l.strip().split('=', 1) for l in open(os.path.join(S, f)) if '=' in l and not l.startswith('#'))
app = env('meta-app.env')
pt = open(os.path.join(S, 'meta-page-token')).read().strip()


def say(level, title, body):
    hub.alert(title, level, 'meta-token', body, key='meta-token', push=True)


fix = 'Para renovarlo: Explorador de la API Graph → app Yammbo Bot → generar token de usuario → mandármelo (5 min).'
try:
    q = urllib.parse.urlencode({'input_token': pt, 'access_token': app['META_APP_ID'] + '|' + app['META_APP_SECRET']})
    d = json.load(urllib.request.urlopen('https://graph.facebook.com/v26.0/debug_token?' + q, timeout=30))['data']
except Exception as e:
    say('warn', 'No pude comprobar el token de Meta', f'{type(e).__name__}. Vuelvo a mirar la semana que viene.'); raise SystemExit(1)
left = (dt.datetime.fromtimestamp(d['data_access_expires_at'], dt.timezone.utc) - dt.datetime.now(dt.timezone.utc)).days if d.get('data_access_expires_at') else None
print('valid', d.get('is_valid'), '| expires_at', d.get('expires_at'), '| data access days left', left)
if not d.get('is_valid'):
    say('crit', 'El token de Meta dejó de valer', 'No se puede publicar en Instagram ni Facebook. ' + fix)
elif left is not None and left <= 21:
    say('warn', f'El acceso de Meta vence en {left} días', fix)
else:
    hub.resolve('meta-token')
