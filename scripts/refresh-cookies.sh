#!/usr/bin/env bash
# Refresh cookies.txt do api-kalodata via FlareSolverr.  (v2 - 2026-06)
# ---------------------------------------------------------------------------
# v2: preserva a sessao AUTENTICADA e NUNCA faz downgrade pra anonima.
#   - Renova o cf_clearance (anti-Cloudflare) via FlareSolverr a cada execucao.
#   - Mantem o SESSION autenticado existente (merge), validando via clip-token.
#   - Se o FlareSolverr trouxer uma sessao ja autenticada, usa ela (caso ideal).
#   - Se NADA autenticar (login expirou de vez), NAO sobrescreve cookies.txt
#     (mantem o ultimo bom) e dispara alerta por e-mail (com cooldown).
#   Recuperacao quando alerta: re-logar manualmente em kalodata.com dentro da
#   sessao do FlareSolverr "kalodata-session".
# Executa a cada 20 min (cron) ou on-demand.
set -uo pipefail
cd /root/kalodata-dashboard
LOG=/var/log/kalodata-refresh.log
TS=$(date '+%Y-%m-%d %H:%M:%S')

# 1) cookies frescos do FlareSolverr (resolve Cloudflare, traz cf_clearance)
FS=$(curl -s --max-time 90 -X POST http://localhost:8191/v1 \
  -H 'Content-Type: application/json' \
  -d '{"cmd":"request.get","url":"https://www.kalodata.com/","session":"kalodata-session","maxTimeout":60000}')

STATUS=$(echo "$FS" | python3 -c "import sys,json;print(json.load(sys.stdin).get('status',''))" 2>/dev/null)
if [ "$STATUS" != "ok" ]; then
  echo "[$TS] FAIL flaresolverr status=$STATUS" >> "$LOG"
  exit 1
fi

# 2) decide o cookie a gravar (preserva auth, nunca downgrade). Python faz o trabalho.
RESULT=$(FS_JSON="$FS" python3 <<'PY'
import sys, os, json, subprocess

FS = json.loads(os.environ["FS_JSON"])
cookies = [c for c in (FS.get("solution") or {}).get("cookies") or []
           if "kalodata" in (c.get("domain") or "")]
fresh = {c["name"]: c["value"] for c in cookies}
fresh_str = "; ".join(f"{k}={v}" for k, v in fresh.items())

# cookie atual em disco
cur = ""
if os.path.exists("cookies.txt"):
    cur = open("cookies.txt").read().strip()
cur_map = {}
for p in cur.split(";"):
    p = p.strip()
    if "=" in p:
        k, v = p.split("=", 1)
        cur_map[k.strip()] = v.strip()

# merge = cookie atual, mas com os cookies anti-bot do Cloudflare frescos
merge_map = dict(cur_map)
for k in ("cf_clearance", "_cfuvid"):
    if k in fresh:
        merge_map[k] = fresh[k]
merge_str = "; ".join(f"{k}={v}" for k, v in merge_map.items())

UA = ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/116.0.0.0 Safari/537.36")

def is_auth(cookie):
    """clip-token so retorna success+token com sessao autenticada."""
    if not cookie.strip():
        return False
    try:
        out = subprocess.run(
            ["/usr/local/bin/curl_chrome116", "-s", "--max-time", "20", "-A", UA,
             "-b", cookie, "-H", "accept: application/json",
             "-H", "country: BR", "-H", "language: pt-BR",
             "https://www.kalodata.com/api/sso/clip-token"],
            capture_output=True, text=True, timeout=30).stdout
        d = json.loads(out)
        return bool(d.get("success") and (d.get("data") or {}).get("token"))
    except Exception:
        return False

if fresh_str and is_auth(fresh_str):
    open("cookies.txt", "w").write(fresh_str + "\n")
    print("fresh-auth")
elif merge_str and is_auth(merge_str):
    open("cookies.txt", "w").write(merge_str + "\n")
    print("merge-auth")
else:
    print("auth-lost")
PY
)

CHARS=$(wc -c < cookies.txt 2>/dev/null | tr -d ' ')

# Todo jar que passou pelo is_auth vira ponto de restauracao. O keepalive do
# server.js volta pra este arquivo se alguem gravar lixo por cima do cookies.txt.
save_last_good () {
  cp -f cookies.txt cookies.txt.last-good 2>/dev/null || true
}

case "$RESULT" in
  fresh-auth)
    echo "[$TS] OK fresh-auth: sessao do FlareSolverr ja autenticada (${CHARS} chars)" >> "$LOG"
    save_last_good
    rm -f /tmp/kalo-auth-lost.flag
    ;;
  merge-auth)
    echo "[$TS] OK merge-auth: SESSION autenticado preservado + cf_clearance renovado (${CHARS} chars)" >> "$LOG"
    save_last_good
    rm -f /tmp/kalo-auth-lost.flag
    ;;
  auth-lost)
    echo "[$TS] ALERT auth-lost: sessao anonima e sem auth pra preservar. cookies.txt NAO sobrescrito. Re-logar em kalodata.com (FlareSolverr)." >> "$LOG"
    # alerta por e-mail com cooldown de 6h (flag file)
    #
    # 2026-08-14: o alerta NUNCA chegou desde junho. Dois defeitos somados:
    #   1. sem User-Agent, o Cloudflare da api.resend.com devolvia 403 "error
    #      code: 1010" pro Python-urllib (o SDK Node do server.js passava, por
    #      isso o outro alerta funcionava e este nao);
    #   2. o `&& touch "$FLAG"` so criava a flag quando o envio dava certo, entao
    #      o cooldown nunca comecava e ele retentava a cada 20 min pra sempre.
    # Agora a flag e criada de todo jeito e o erro vira uma linha legivel no log,
    # nao um traceback.
    FLAG=/tmp/kalo-auth-lost.flag
    if [ ! -f "$FLAG" ] || [ "$(find "$FLAG" -mmin +360 2>/dev/null)" ]; then
      python3 <<'PY' >> "$LOG" 2>&1
import json, sys
cfg = json.load(open("config.json"))
key = cfg.get("resend_api_key"); frm = cfg.get("email_from"); to = cfg.get("email_to")
if not (key and frm and to):
    print("[alert] resend nao configurado (resend_api_key/email_from/email_to)")
    sys.exit(0)
import urllib.request, urllib.error
body = json.dumps({
    "from": frm, "to": to if isinstance(to, list) else [to],
    "subject": "[Kalodata] Sessao perdeu autenticacao - re-login manual necessario",
    "html": "<p>O refresh-cookies.sh nao conseguiu manter a sessao autenticada do Kalodata "
            "(clip-token retornou 'Authentication required').</p>"
            "<p><b>Acao:</b> re-logar em https://www.kalodata.com dentro da sessao "
            "<code>kalodata-session</code> do FlareSolverr na VPS, ou logar no Chrome que "
            "roda a extensao Cookie Sync. Ate la os dados ficam limitados a ~10 itens "
            "(visao anonima).</p>"
}).encode()
req = urllib.request.Request("https://api.resend.com/emails", data=body, headers={
    "Authorization": f"Bearer {key}",
    "Content-Type": "application/json",
    # Sem isto o Cloudflare do Resend barra o urllib com 403/1010.
    "User-Agent": "kalodata-refresh/1.0",
})
try:
    urllib.request.urlopen(req, timeout=20)
    print("[alert] email enviado")
except urllib.error.HTTPError as e:
    print(f"[alert] resend recusou: HTTP {e.code} {e.read()[:200]!r}")
except Exception as e:
    print(f"[alert] falha ao enviar: {e}")
PY
      touch "$FLAG"
    fi
    ;;
  *)
    echo "[$TS] FAIL resultado inesperado: '$RESULT'" >> "$LOG"
    exit 1
    ;;
esac
