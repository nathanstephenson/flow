#!/usr/bin/env bash
# Usage: sbx-flow-probe.sh <sandbox-name>
# Optional env: WS=<host path mounted rw>  RO=<host path mounted ro>  FLOW_PORT=<host port>
set -uo pipefail
N=${1:?usage: $0 <sandbox-name>}
SBX=${SBX:-sbx}
T=$(mktemp -d)
pass=0 fail=0 bg=()

ok() { echo "PASS $*"; pass=$((pass + 1)); }
bad() { echo "FAIL $*"; fail=$((fail + 1)); }
info() { echo "INFO $*"; }
to() { perl -e 'alarm shift; exec @ARGV or die "exec: $!"' "$@"; }
now() { node -e 'console.log(Date.now())'; }
x() { to 120 "$SBX" exec "$N" "$@"; }
xi() { to 300 "$SBX" exec -i "$N" "$@"; }
xr() { to 120 "$SBX" exec -u root -i "$N" "$@"; }
cleanup() {
  for p in ${bg[@]+"${bg[@]}"}; do kill -KILL "$p" 2>/dev/null; done
  to 30 "$SBX" exec -u root "$N" pkill -KILL -f '^sleep 3[0-9]{4}' >/dev/null 2>&1
  rm -rf "$T"
}
trap cleanup EXIT

echo "== start time"
"$SBX" stop "$N" >/dev/null 2>&1
s=$(now); to 300 "$SBX" exec -i "$N" true </dev/null >"$T/cold" 2>"$T/cold.err"; rc=$?; info "cold exec rc=$rc ms=$(($(now) - s))"
n=$(wc -c <"$T/cold" | tr -d ' ')
[ "$n" = 0 ] && ok "cold start stdout clean" || bad "cold start wrote $n bytes to stdout: $(head -c 80 "$T/cold")"
s=$(now); x true; info "warm exec rc=$? ms=$(($(now) - s))"

echo "== guest runtime"
x sh -lc 'id; echo HOME=$HOME; uname -m; cat /proc/self/cgroup
  for c in node claude git bash setsid setpriv env pgrep curl; do printf "%s: " $c; command -v $c || echo missing; done
  node --version; claude --version 2>/dev/null
  env | grep -iE "^(https?_proxy|no_proxy|ssl_|node_extra|claude_|anthropic_|github_|gh_|git_)" | sed "s/=.*/=<set>/"' |
  sed 's/^/  /'

echo "== stdio"
n=$(xi sh -c 'echo diag >&2' </dev/null 2>/dev/null | wc -c | tr -d ' ')
[ "$n" = 0 ] && ok "stdout clean" || bad "stdout has $n stray bytes"

xi sh -c 'exit 42' </dev/null; rc=$?
[ "$rc" = 42 ] && ok "exit code 42" || bad "exit code: got $rc want 42"
xi sh -c 'kill -TERM $$' </dev/null; info "guest killed by SIGTERM -> rc=$? (128+15=143 expected)"

printf abc | xi sh -c 'cat; echo eof-seen >&2' >"$T/eof" 2>/dev/null; rc=$?
[ "$rc" = 0 ] && [ "$(cat "$T/eof")" = abc ] && ok "stdin EOF forwarded" || bad "stdin EOF: rc=$rc out=$(head -c 20 "$T/eof")"

node -e 'const c=require("crypto"),o=[];for(let i=0;i<1000;i++){const b=c.randomBytes(c.randomInt(1,65536)),h=Buffer.alloc(4);h.writeUInt32BE(b.length);o.push(h,b)}process.stdout.write(Buffer.concat(o))' >"$T/in.bin"
node -e 'const d=require("fs").readFileSync(process.argv[1]);(async()=>{for(let i=0;i<d.length;){const n=1+Math.floor(Math.random()*7000);process.stdout.write(d.subarray(i,i+=n));if(Math.random()<.05)await new Promise(r=>setTimeout(r,5))}})()' "$T/in.bin" |
  xi cat >"$T/out.bin"; rc=$?
cmp -s "$T/in.bin" "$T/out.bin" && [ "$rc" = 0 ] && ok "framed binary round trip ($(wc -c <"$T/in.bin" | tr -d ' ') bytes, split writes)" || bad "binary round trip rc=$rc"

xi sh -c 'head -c 33554432 /dev/urandom; exit 3' </dev/null >"$T/big"; rc=$?
sz=$(wc -c <"$T/big" | tr -d ' ')
[ "$rc" = 3 ] && [ "$sz" = 33554432 ] && ok "32 MiB drained before exit 3" || bad "drain: rc=$rc size=$sz"

echo "== termination"
x sh -c 'sleep 39991' </dev/null >/dev/null 2>&1 &
bg+=($!)
sleep 3

term_test() {
  local mode=$1 base=$2 wrap=$3 f="$T/fifo.$1.$2"
  mkfifo "$f"
  "$SBX" exec $wrap -i "$N" sh -c "sleep ${base}1 & setsid sleep ${base}2 & (sleep ${base}3 &); cat >/dev/null" <"$f" >/dev/null 2>"$T/err.$base" &
  local p=$!
  bg+=($p)
  exec 9>"$f"
  sleep 5
  local started
  started=$(x pgrep -f "^sleep ${base}" | wc -l | tr -d ' ')
  if [ "$started" != 3 ]; then bad "$mode: started $started/3 guest sleeps: $(tr '\n' ' ' <"$T/err.$base")"; exec 9>&-; return; fi
  case $mode in
    eof) exec 9>&- ;;
    term) kill -TERM "$p"; exec 9>&- ;;
    kill) kill -KILL "$p"; exec 9>&- ;;
  esac
  sleep 5
  local left
  left=$(x pgrep -af "^sleep ${base}")
  [ -z "$left" ] && ok "$mode: whole tree stopped" || bad "$mode: left running: $(echo "$left" | tr '\n' ';')"
}

term_test eof 3101 ""
term_test term 3102 ""
term_test kill 3103 ""


[ -n "$(x pgrep -f '^sleep 39991')" ] && ok "other command not affected" || bad "other command was stopped"

echo "== mounts"
if [ -n "${WS:-}" ] && { [ -d "$WS" ] && x test -d "$WS" || { bad "WS=$WS missing on host or guest"; false; }; }; then
  m="$WS/.flow-probe-$$"
  echo host >"$m"
  [ "$(x cat "$m")" = host ] && ok "same path read: $WS" || bad "same path read: $WS"
  x sh -c "echo guest >'$m'"
  [ "$(cat "$m")" = guest ] && ok "guest write visible on host" || bad "guest write not visible on host"
  rm -f "$m"
fi
if [ -n "${RO:-}" ] && { [ -d "$RO" ] && x test -d "$RO" || { bad "RO=$RO missing on host or guest"; false; }; }; then
  x touch "$RO/.flow-probe" 2>/dev/null && bad "ro mount writable by agent" || ok "ro mount refuses agent write"
  to 30 "$SBX" exec -u root "$N" touch "$RO/.flow-probe" 2>/dev/null && bad "ro mount writable by root" || ok "ro mount refuses root write"
  to 30 "$SBX" exec -u root "$N" sh -c "mount -o remount,rw '$RO' && touch '$RO/.flow-probe'" 2>/dev/null && bad "root can remount ro mount rw" || ok "root cannot remount rw"
  rm -f "$RO/.flow-probe"
fi

echo "== network (000 = blocked or unreachable)"
for u in https://platform.claude.com/v1/oauth/token https://claude.ai https://claude.com https://api.anthropic.com https://mcp-proxy.anthropic.com https://example.com http://169.254.169.254/ ${FLOW_PORT:+http://host.docker.internal:$FLOW_PORT/}; do
  info "$u -> $(x curl -sS -o /dev/null -w '%{http_code}' --max-time 10 "$u" 2>/dev/null)"
done

[ -n "${FLOW_PORT:-}" ] && info "host port body: $(x curl -sS --max-time 10 "http://host.docker.internal:$FLOW_PORT/" 2>&1 | head -c 200 | tr '\n' ' ')"

echo "== $pass pass, $fail fail"
[ "$fail" = 0 ]
