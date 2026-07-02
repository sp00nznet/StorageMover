#!/usr/bin/env bash
#
# smover.sh — StorageMover terminal wrapper + post-migration verifier
#
# Two independent halves:
#   1) migrate  — drives the StorageMover REST API (login, add devices,
#                 discover, create migration, start). Honors --dry-run.
#   2) verify   — pure-SSH checks against source + target. Needs NOTHING from
#                 StorageMover, so you can run it after ANY migration to confirm:
#                   (a) the share/export exists on the target
#                   (b) the content actually landed on the target
#
# NOTHING is hardcoded. Supply hosts/paths via flags or env vars.
#
# ---------------------------------------------------------------------------
# QUICK EXAMPLES
#
#   # Just verify a share made it across (most common use):
#   ./smover.sh --src-host SRC --src-path /ifs/data/share1 \
#               --dst-host DST --dst-path /ifs/migrated/ifs/data/share1 \
#               verify
#
#   # Byte-for-byte manifest comparison (slower, authoritative):
#   ./smover.sh ... --deep verify-content
#
#   # Preview a StorageMover migration without starting it:
#   ./smover.sh --dry-run migrate
#
# Run  ./smover.sh --help  for the full option list.
# ---------------------------------------------------------------------------

set -euo pipefail

# ---- defaults (override via env or flags) ---------------------------------
API="${SMOVER_API:-http://localhost:3001/api}"
DRY_RUN=0
DEEP=0
CHECKSUM=0
INSECURE=0
JSON=0

# StorageMover login
SM_USER="${SM_USER:-admin}"
SM_PASS="${SM_PASS:-}"

# Source / target endpoints (NO defaults for hosts/paths on purpose)
SRC_HOST="${SRC_HOST:-}"; SRC_USER="${SRC_USER:-root}"; SRC_PATH="${SRC_PATH:-}"
DST_HOST="${DST_HOST:-}"; DST_USER="${DST_USER:-root}"; DST_PATH="${DST_PATH:-}"

# Device types for the API migrate path
SRC_TYPE="${SRC_TYPE:-isilon}"        # isilon | powerscale | powerstore
DST_TYPE="${DST_TYPE:-powerscale}"    # isilon | powerscale | powerstore
SRC_DEV_PASS="${SRC_DEV_PASS:-}"      # SSH pass StorageMover uses for source
DST_DEV_PASS="${DST_DEV_PASS:-}"      # SSH pass StorageMover uses for target
TARGET_BASE_PATH="${TARGET_BASE_PATH:-}"

TOKEN="${SMOVER_TOKEN:-}"

# ---- pretty output --------------------------------------------------------
# In --json mode all human log lines go to stderr so stdout stays pure JSON.
c_red=$'\033[31m'; c_grn=$'\033[32m'; c_yel=$'\033[33m'; c_dim=$'\033[2m'; c_off=$'\033[0m'
_p()   { if [[ "$JSON" == 1 ]]; then printf '%s\n' "$1" >&2; else printf '%s\n' "$1"; fi; }
_detail() { if [[ "$JSON" == 1 ]]; then cat >&2; else cat; fi; }   # multiline detail blocks
ok()   { _p "${c_grn}[ OK ]${c_off} $*"; }
fail() { _p "${c_red}[FAIL]${c_off} $*"; }
warn() { _p "${c_yel}[WARN]${c_off} $*"; }
info() { _p "${c_dim}----- $* ${c_off}"; }
json_str() { local s="$1"; s="${s//\\/\\\\}"; s="${s//\"/\\\"}"; printf '"%s"' "$s"; }
die()  {
  if [[ "$JSON" == 1 ]]; then printf '{"error":%s,"passed":false}\n' "$(json_str "$*")"; else fail "$*"; fi
  exit 1
}

VERIFY_FAILED=0

# ---- verify result capture (populated by the verify commands, for --json) --
J_DIR_EXISTS=null; J_NFS=unknown; J_EXPORTS=""
J_SRC_FILES=null; J_DST_FILES=null; J_FILES_MATCH=null
J_SRC_KB=null; J_DST_KB=null; J_DU_MATCH=null
J_DEEP_CHECKED=false; J_DEEP_MODE=""
J_MISSING=""; J_EXTRA=""; J_MISMATCH=""

# ---- ssh helper -----------------------------------------------------------
ssh_opts() {
  local -a o=(-o BatchMode=yes -o ConnectTimeout=10)
  [[ "$INSECURE" == 1 ]] && o+=(-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null)
  printf '%s\n' "${o[@]}"
}
rsh() { # rsh <user@host> <remote-command-string>
  local dest="$1"; shift
  mapfile -t _o < <(ssh_opts)
  ssh "${_o[@]}" "$dest" "$@"
}

need() { command -v "$1" >/dev/null 2>&1 || die "'$1' not found in PATH"; }

# ===========================================================================
# API (migrate) half
# ===========================================================================
api() { # api <METHOD> <path> [json-body]
  need curl
  local method="$1" path="$2" body="${3:-}"
  local -a args=(-s -X "$method" "$API$path" -H "Authorization: Bearer $TOKEN")
  if [[ -n "$body" ]]; then args+=(-H 'Content-Type: application/json' -d "$body"); fi
  curl "${args[@]}"
}

cmd_login() {
  need curl; need jq
  [[ -n "$SM_PASS" ]] || die "set SM_PASS (StorageMover login password) or --sm-pass"
  info "logging in to $API as $SM_USER"
  TOKEN=$(curl -s -X POST "$API/auth/login" -H 'Content-Type: application/json' \
    -d "$(jq -nc --arg u "$SM_USER" --arg p "$SM_PASS" '{username:$u,password:$p}')" | jq -r '.token // empty')
  [[ -n "$TOKEN" ]] || die "login failed (bad creds, or user not registered yet)"
  ok "token acquired"
  printf 'export SMOVER_TOKEN=%s\n' "$TOKEN"   # eval this to reuse the token
}

cmd_migrate() {
  need jq
  [[ -n "$TOKEN" ]] || { cmd_login >/dev/null; TOKEN=$(curl -s -X POST "$API/auth/login" \
      -H 'Content-Type: application/json' \
      -d "$(jq -nc --arg u "$SM_USER" --arg p "$SM_PASS" '{username:$u,password:$p}')" | jq -r '.token'); }
  for v in SRC_HOST DST_HOST; do [[ -n "${!v}" ]] || die "missing --${v,,//_/-} / \$$v"; done

  info "registering source device ($SRC_TYPE @ $SRC_HOST)"
  local src_id dst_id
  src_id=$(api POST /devices "$(jq -nc \
    --arg n src --arg t "$SRC_TYPE" --arg h "$SRC_HOST" --arg u "$SRC_USER" --arg p "$SRC_DEV_PASS" \
    '{name:$n,type:$t,hostname:$h,port:8080,username:$u,password:$p}')" | jq -r '.id')
  info "registering target device ($DST_TYPE @ $DST_HOST)"
  dst_id=$(api POST /devices "$(jq -nc \
    --arg n dst --arg t "$DST_TYPE" --arg h "$DST_HOST" --arg u "$DST_USER" --arg p "$DST_DEV_PASS" \
    '{name:$n,type:$t,hostname:$h,port:8080,username:$u,password:$p}')" | jq -r '.id')
  [[ -n "$src_id" && -n "$dst_id" ]] || die "device registration failed"
  ok "source=$src_id target=$dst_id"

  info "testing connectivity"
  api POST "/devices/$src_id/test" | jq -c .
  api POST "/devices/$dst_id/test" | jq -c .

  info "discovering exports on source"
  api POST "/devices/$src_id/discover" | jq -c '{discovered: .count}'
  local export_ids
  export_ids=$(api GET "/exports?deviceId=$src_id" | jq -c '[.[].id]')
  api GET "/exports?deviceId=$src_id" | jq -r '.[] | "  \(.export_type)\t\(.export_path)"'
  [[ "$export_ids" != "[]" ]] || die "no exports discovered on source"

  info "creating migration record"
  local mig_id
  mig_id=$(api POST /migrations "$(jq -nc \
    --arg n "cli-run" --arg s "$src_id" --arg t "$dst_id" \
    --argjson e "$export_ids" --arg b "$TARGET_BASE_PATH" \
    '{name:$n,sourceDeviceId:$s,targetDeviceId:$t,exportIds:$e,targetBasePath:$b}')" | jq -r '.id')
  [[ -n "$mig_id" ]] || die "migration create failed"
  ok "migration=$mig_id"

  info "planned items (source -> target):"
  api GET "/migrations/$mig_id" | jq -r '.items[] | "  \(.export_path)  ->  \(.target_path)"'

  if [[ "$DRY_RUN" == 1 ]]; then
    warn "--dry-run: migration created but NOT started. Inspect the plan above."
    warn "to run it: $0 start $mig_id"
    return 0
  fi

  info "starting migration"
  api POST "/migrations/$mig_id/start" | jq -c .
  cmd_status "$mig_id"
}

cmd_start()  { need jq; api POST "/migrations/$1/start"  | jq -c .; cmd_status "$1"; }
cmd_status() {
  need jq
  local id="$1"
  info "polling migration $id (Ctrl-C to stop watching; the job keeps running server-side)"
  while :; do
    local snap; snap=$(api GET "/migrations/$id")
    echo "$snap" | jq -c '{status,progress,bytes_transferred,files_transferred}'
    local st; st=$(echo "$snap" | jq -r '.status')
    case "$st" in
      completed|completed_with_errors|failed|cancelled)
        echo "$snap" | jq -r '.items[] | "  \(.status)\t\(.export_path)\t\(.error_message // "")"'
        [[ "$st" == completed ]] && ok "migration $st" || warn "migration $st"
        break ;;
    esac
    sleep 5
  done
}

# ===========================================================================
# VERIFY half (pure SSH — no StorageMover needed)
# ===========================================================================
require_verify_vars() {
  for v in SRC_HOST SRC_PATH DST_HOST DST_PATH; do
    [[ -n "${!v}" ]] || die "verify needs --${v,,} (\$$v). Missing: $v"
  done
}

# ---- (a) share / export exists on the target ------------------------------
cmd_verify_share() {
  require_verify_vars
  info "(a) SHARE EXISTS ON TARGET  —  $DST_USER@$DST_HOST:$DST_PATH"

  # 1. Target directory is present and is a directory
  if rsh "$DST_USER@$DST_HOST" "test -d '$DST_PATH'" 2>/dev/null; then
    ok "target directory exists: $DST_PATH"; J_DIR_EXISTS=true
  else
    fail "target directory MISSING or not a dir: $DST_PATH"
    J_DIR_EXISTS=false; VERIFY_FAILED=1
  fi

  # 2. NFS export is actually published by the target (best-effort)
  if command -v showmount >/dev/null 2>&1; then
    local exp
    exp=$(showmount -e "$DST_HOST" 2>/dev/null | awk 'NR>1{print $1}')
    J_EXPORTS="$exp"
    if [[ -z "$exp" ]]; then
      warn "showmount returned no exports from $DST_HOST (mountd blocked? or SMB-only)"
      J_NFS=none
    elif grep -qxF "$DST_PATH" <<<"$exp"; then
      ok "NFS export published for exact path: $DST_PATH"; J_NFS=exact
    elif grep -q "$DST_PATH" <<<"$exp"; then
      ok "NFS export published under path (alias/parent): $DST_PATH"; J_NFS=parent
    else
      warn "no NFS export matching $DST_PATH. Published exports:"
      sed 's/^/       /' <<<"$exp" | _detail
      warn "  (dir exists but may not be re-exported yet — create the export on the target)"
      J_NFS=none
    fi
  else
    warn "showmount not installed locally; skipped NFS-export check (dir check still ran)"
    J_NFS=skipped
  fi
}

# ---- portable remote counters ---------------------------------------------
remote_count() { # -> file count under path (0 if path missing)
  rsh "$1@$2" "test -d '$3' && find '$3' -type f 2>/dev/null | wc -l || echo -1"
}
remote_du_kb() { # -> apparent size in KB (block-based; approximate)
  rsh "$1@$2" "test -d '$3' && du -sk '$3' 2>/dev/null | awk '{print \$1}' || echo -1"
}

# ---- (b) content exists on the target -------------------------------------
cmd_verify_content() {
  require_verify_vars
  info "(b) CONTENT EXISTS ON TARGET"

  local sc dc
  sc=$(remote_count "$SRC_USER" "$SRC_HOST" "$SRC_PATH"); sc=${sc//[^0-9-]/}
  dc=$(remote_count "$DST_USER" "$DST_HOST" "$DST_PATH"); dc=${dc//[^0-9-]/}
  J_SRC_FILES=${sc:-null}; J_DST_FILES=${dc:-null}
  [[ "$sc" == -1 ]] && { fail "source path unreadable: $SRC_PATH"; VERIFY_FAILED=1; return; }
  [[ "$dc" == -1 ]] && { fail "target path unreadable: $DST_PATH"; VERIFY_FAILED=1; return; }

  _p "$(printf '   source files: %s\n   target files: %s' "$sc" "$dc")"
  if [[ "$sc" == "$dc" ]]; then
    ok "file counts match ($sc)"; J_FILES_MATCH=true
  else
    fail "file count mismatch (src=$sc target=$dc)"
    J_FILES_MATCH=false; VERIFY_FAILED=1
  fi

  local sk dk
  sk=$(remote_du_kb "$SRC_USER" "$SRC_HOST" "$SRC_PATH"); sk=${sk//[^0-9-]/}
  dk=$(remote_du_kb "$DST_USER" "$DST_HOST" "$DST_PATH"); dk=${dk//[^0-9-]/}
  J_SRC_KB=${sk:-null}; J_DST_KB=${dk:-null}
  _p "$(printf '   source size : %s KB\n   target size : %s KB %s' "$sk" "$dk" "${c_dim}(du, block-based — approximate)${c_off}")"
  if [[ "$sk" == "$dk" ]]; then
    ok "du sizes match"; J_DU_MATCH=true
  else
    J_DU_MATCH=false
    warn "du sizes differ — often just block-allocation differences between arrays;"
    warn "  run '--deep verify-content' for an authoritative byte-level comparison"
  fi

  if [[ "$DEEP" == 1 || "$CHECKSUM" == 1 ]]; then deep_compare; fi
}

# ---- deep byte-level (and optional checksum) manifest diff -----------------
manifest() { # <user> <host> <path>  ->  "relpath<TAB>bytes[<TAB>cksum]"  sorted by relpath
  local user="$1" host="$2" path="$3" ck="$4"
  # POSIX-portable remote script (works on OneFS/FreeBSD and Linux).
  rsh "$user@$host" "sh -s '$path' '$ck'" <<'REMOTE'
p="$1"; ck="$2"
cd "$p" 2>/dev/null || { echo "__NOPATH__"; exit 3; }
find . -type f 2>/dev/null | LC_ALL=C sort | while IFS= read -r f; do
  sz=$(wc -c < "$f" 2>/dev/null | tr -d ' ')
  if [ "$ck" = "1" ]; then
    c=$(cksum "$f" 2>/dev/null | awk '{print $1}')
    printf '%s\t%s\t%s\n' "$f" "$sz" "$c"
  else
    printf '%s\t%s\n' "$f" "$sz"
  fi
done
REMOTE
}

deep_compare() {
  local mode="byte-size"; [[ "$CHECKSUM" == 1 ]] && mode="byte-size+cksum"
  J_DEEP_CHECKED=true; J_DEEP_MODE="$mode"
  info "deep compare ($mode) — per-file, may take a while on large trees"
  local tmp; tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' RETURN

  manifest "$SRC_USER" "$SRC_HOST" "$SRC_PATH" "$CHECKSUM" > "$tmp/src" 2>/dev/null || true
  manifest "$DST_USER" "$DST_HOST" "$DST_PATH" "$CHECKSUM" > "$tmp/dst" 2>/dev/null || true
  grep -q '__NOPATH__' "$tmp/src" && { fail "source path unreadable for manifest"; VERIFY_FAILED=1; return; }
  grep -q '__NOPATH__' "$tmp/dst" && { fail "target path unreadable for manifest"; VERIFY_FAILED=1; return; }

  cut -f1 "$tmp/src" | sort > "$tmp/src.paths"
  cut -f1 "$tmp/dst" | sort > "$tmp/dst.paths"

  local only_src only_dst
  only_src=$(comm -23 "$tmp/src.paths" "$tmp/dst.paths")
  only_dst=$(comm -13 "$tmp/src.paths" "$tmp/dst.paths")
  J_MISSING="$only_src"; J_EXTRA="$only_dst"

  if [[ -n "$only_src" ]]; then
    fail "$(wc -l <<<"$only_src") file(s) present on source but MISSING on target:"
    sed 's/^/       /' <<<"$only_src" | head -20 | _detail
    [[ $(wc -l <<<"$only_src") -gt 20 ]] && _p "       ... (truncated)"
    VERIFY_FAILED=1
  else
    ok "every source file is present on the target"
  fi
  [[ -n "$only_dst" ]] && { warn "$(wc -l <<<"$only_dst") extra file(s) on target not on source (ok if intended)"; }

  # size / checksum mismatches on files present in both
  local diffs
  diffs=$(join -t $'\t' <(sort "$tmp/src") <(sort "$tmp/dst") | awk -F'\t' '{
    if (NF>=5) { if ($2!=$4 || $3!=$5) print $1 }   # path,ssz,scks,dsz,dcks
    else       { if ($2!=$3)          print $1 }    # path,ssz,dsz
  }')
  J_MISMATCH="$diffs"
  if [[ -n "$diffs" ]]; then
    fail "$(wc -l <<<"$diffs") file(s) differ in size/checksum between source and target:"
    sed 's/^/       /' <<<"$diffs" | head -20 | _detail
    [[ $(wc -l <<<"$diffs") -gt 20 ]] && _p "       ... (truncated)"
    VERIFY_FAILED=1
  else
    ok "all common files match (${mode})"
  fi
}

cmd_verify() { cmd_verify_share; _p ""; cmd_verify_content; }

# ---- emit captured verify results as one JSON object ----------------------
emit_verify_json() { # <scope: share|content|verify>
  need jq
  local passed=true; [[ "$VERIFY_FAILED" == 0 ]] || passed=false
  jq -nc \
    --arg cmd "$1" \
    --arg sh "$SRC_HOST" --arg su "$SRC_USER" --arg sp "$SRC_PATH" \
    --arg dh "$DST_HOST" --arg du "$DST_USER" --arg dp "$DST_PATH" \
    --argjson dir "$J_DIR_EXISTS" --arg nfs "$J_NFS" --arg exports "$J_EXPORTS" \
    --argjson sf "${J_SRC_FILES:-null}" --argjson df "${J_DST_FILES:-null}" --argjson fm "$J_FILES_MATCH" \
    --argjson sk "${J_SRC_KB:-null}" --argjson dk "${J_DST_KB:-null}" --argjson dm "$J_DU_MATCH" \
    --argjson deep "$J_DEEP_CHECKED" --arg dmode "$J_DEEP_MODE" \
    --arg missing "$J_MISSING" --arg extra "$J_EXTRA" --arg mismatch "$J_MISMATCH" \
    --argjson passed "$passed" '
    def arr($s): ($s | split("\n") | map(select(length>0)));
    {
      command: $cmd,
      source: {host:$sh, user:$su, path:$sp},
      target: {host:$dh, user:$du, path:$dp},
      share: (if $cmd=="content" then null else
        {target_dir_exists:$dir, nfs_export:$nfs, published_exports:arr($exports)} end),
      content: (if $cmd=="share" then null else
        {source_files:$sf, target_files:$df, files_match:$fm,
         source_kb:$sk, target_kb:$dk, du_match:$dm,
         deep: (if $deep then
           {mode:$dmode, missing_on_target:arr($missing),
            extra_on_target:arr($extra), mismatched:arr($mismatch)}
         else null end)} end),
      passed: $passed
    }'
}

# ---- finish a verify run: emit (json or human) + set exit code ------------
finish_verify() { # <scope>
  [[ "$JSON" == 1 ]] && emit_verify_json "$1"
  if [[ "$VERIFY_FAILED" == 0 ]]; then
    [[ "$JSON" == 1 ]] || ok "VERIFY PASSED"; exit 0
  else
    [[ "$JSON" == 1 ]] || fail "VERIFY FAILED"; exit 1
  fi
}

# ---- rsync dry-run preview (genuine "what would move" preflight) ----------
# Runs ON the target, pulling from source with -n, exactly like a real
# StorageMover transfer minus the write. Needs SSH source->target reachability
# (key-based auth recommended). Read-only.
cmd_preflight() {
  require_verify_vars
  info "PREFLIGHT: rsync dry-run on target, pulling from source (no data written)"
  local sshx="ssh -o BatchMode=yes"
  [[ "$INSECURE" == 1 ]] && sshx="ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null"
  rsh "$DST_USER@$DST_HOST" \
    "rsync -avn --itemize-changes -e '$sshx' '$SRC_USER@$SRC_HOST:$SRC_PATH/' '$DST_PATH/'" \
    || warn "rsync dry-run returned non-zero (check ssh source->target / sshpass on target)"
  warn "lines above prefixed with '>' or 'c' are files rsync WOULD transfer. None = in sync."
}

# ===========================================================================
usage() {
cat <<EOF
smover.sh — StorageMover terminal wrapper + verifier

USAGE:
  $0 [options] <command>

COMMANDS:
  verify            (a) share exists on target  +  (b) content exists on target
  verify-share      only the share/export existence check
  verify-content    only the content check (counts + du; add --deep for bytes)
  preflight         rsync dry-run: preview what WOULD transfer (read-only)

  migrate           API: add devices, discover, create + start (honors --dry-run)
  start <migId>     API: start/resume an existing migration and poll
  status <migId>    API: poll a migration to completion
  login             API: get a token (eval its output to cache \$SMOVER_TOKEN)

VERIFY OPTIONS (flags OR env vars):
  --src-host H   \$SRC_HOST     --src-user U  \$SRC_USER  (default root)
  --src-path P   \$SRC_PATH     --dst-host H  \$DST_HOST
  --dst-user U   \$DST_USER     --dst-path P  \$DST_PATH  (default root)
  --deep         byte-for-byte per-file manifest comparison (authoritative)
  --checksum     add per-file cksum to the deep compare (slowest, paranoid)
  --insecure     disable SSH host-key checking (lab / first-contact only)
  --json         emit one JSON result object on stdout (logs go to stderr);
                 exit 0 = passed, 1 = failed. For CI/cron. Needs jq.

MIGRATE OPTIONS:
  --api URL      \$SMOVER_API   (default http://localhost:3001/api)
  --sm-user U    \$SM_USER      --sm-pass P   \$SM_PASS   (StorageMover login)
  --src-type T   isilon|powerscale|powerstore   \$SRC_TYPE
  --dst-type T   isilon|powerscale|powerstore   \$DST_TYPE
  --src-dev-pass P  \$SRC_DEV_PASS   SSH pass StorageMover uses on the source
  --dst-dev-pass P  \$DST_DEV_PASS   SSH pass StorageMover uses on the target
  --target-base P   \$TARGET_BASE_PATH  prepended to each source export path

GLOBAL:
  --dry-run      migrate: create the migration but DO NOT start it (print plan)
  -h, --help

EXAMPLES:
  # Confirm a share + its content made it across:
  $0 --src-host oldnas --src-path /ifs/data/acct \\
     --dst-host newnas --dst-path /ifs/migrated/ifs/data/acct verify

  # Authoritative byte-level content check:
  $0 --src-host oldnas --src-path /ifs/data/acct \\
     --dst-host newnas --dst-path /ifs/migrated/ifs/data/acct --deep verify-content

  # Preview a migration without moving anything:
  SM_PASS=... $0 --src-host oldnas --dst-host newnas --dry-run migrate

  # CI/cron: machine-readable result, nonzero exit on failure:
  $0 --src-host oldnas --src-path /ifs/data/acct \\
     --dst-host newnas --dst-path /ifs/migrated/ifs/data/acct \\
     --deep --json verify | jq .
EOF
}

# ---- arg parse ------------------------------------------------------------
CMD=""; ARG1=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --api)          API="$2"; shift 2;;
    --sm-user)      SM_USER="$2"; shift 2;;
    --sm-pass)      SM_PASS="$2"; shift 2;;
    --src-host)     SRC_HOST="$2"; shift 2;;
    --src-user)     SRC_USER="$2"; shift 2;;
    --src-path)     SRC_PATH="$2"; shift 2;;
    --src-type)     SRC_TYPE="$2"; shift 2;;
    --src-dev-pass) SRC_DEV_PASS="$2"; shift 2;;
    --dst-host)     DST_HOST="$2"; shift 2;;
    --dst-user)     DST_USER="$2"; shift 2;;
    --dst-path)     DST_PATH="$2"; shift 2;;
    --dst-type)     DST_TYPE="$2"; shift 2;;
    --dst-dev-pass) DST_DEV_PASS="$2"; shift 2;;
    --target-base)  TARGET_BASE_PATH="$2"; shift 2;;
    --deep)         DEEP=1; shift;;
    --checksum)     CHECKSUM=1; DEEP=1; shift;;
    --insecure)     INSECURE=1; shift;;
    --json)         JSON=1; shift;;
    --dry-run)      DRY_RUN=1; shift;;
    -h|--help)      usage; exit 0;;
    -*)             die "unknown option: $1 (try --help)";;
    *)              if [[ -z "$CMD" ]]; then CMD="$1"; else ARG1="$1"; fi; shift;;
  esac
done

case "$CMD" in
  verify)          cmd_verify;         finish_verify verify;;
  verify-share)    cmd_verify_share;   finish_verify share;;
  verify-content)  cmd_verify_content; finish_verify content;;
  preflight)       cmd_preflight;;
  migrate)         cmd_migrate;;
  start)           [[ -n "$ARG1" ]] || die "start needs a migration id"; cmd_start "$ARG1";;
  status)          [[ -n "$ARG1" ]] || die "status needs a migration id"; cmd_status "$ARG1";;
  login)           cmd_login;;
  ""|help)         usage;;
  *)               die "unknown command: $CMD (try --help)";;
esac
