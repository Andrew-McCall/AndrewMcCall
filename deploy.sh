#!/usr/bin/env bash
#
# deploy.sh — pull latest from GitHub and rebuild only what changed.
#
# Safe to run from cron. It is a no-op when the remote has no new commits.
# All slow work (git pull, cargo build, npm build) happens while the live
# service keeps running the OLD version; the new version is only swapped in
# at the very end, and only if every build succeeded — so a broken commit or a
# failed compile never takes production down.
#
#   deploy.sh              deploy if there are new commits (what cron runs)
#   deploy.sh --force      rebuild + redeploy even with no new commits
#   deploy.sh --dry-run    show what would be built/deployed, change nothing
#   deploy.sh status       print what's live vs. the latest remote, then exit
#   deploy.sh --verbose    also log idle "nothing to do" ticks
#   deploy.sh --help       show this help
#
# Example crontab (every 5 minutes), logging to a file:
#   */5 * * * * /static/www/www.andrewmccall.uk/deploy.sh >> /var/log/andrewmccall-deploy.log 2>&1
#
set -euo pipefail

# ---------------------------------------------------------------------------
# Configuration — adjust these for the prod box (all overridable via env).
# ---------------------------------------------------------------------------
REPO_DIR="${REPO_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
BRANCH="${BRANCH:-main}"

# Where nginx serves the frontend from. The built `dist` becomes this directory
# itself, swapped in atomically. Its parent must be writable by the user running
# this script (the swap stages a sibling dir and renames it into place), and it
# must be a dedicated directory — NOT the repo — since the whole thing is
# replaced on each deploy.
WEB_ROOT="${WEB_ROOT:-/static/www/www.andrewmccall.uk}"

# systemd unit for the Rust backend. Leave empty to skip the restart step
# (e.g. if you manage the backend some other way).
BACKEND_SERVICE="${BACKEND_SERVICE:-andrewmccall-backend}"

# Where the running backend binary lives (what BACKEND_SERVICE executes).
# The freshly compiled binary is installed here just before the restart.
BACKEND_BIN="${BACKEND_BIN:-/usr/local/bin/andrewmccall-backend}"

# Version-controlled systemd unit file. If present, the script installs/refreshes
# it into /etc/systemd/system before the first restart, so the box is fully
# bootstrapped from the repo. Leave the file absent to manage the unit yourself.
BACKEND_UNIT_SRC="${BACKEND_UNIT_SRC:-$REPO_DIR/deploy/$BACKEND_SERVICE.service}"

# Backend runtime env file (KEY=VALUE). Sourced here so the deploy step can see
# DATABASE_DSN for optional pre-restart migrations; the systemd unit references
# the same file so the running binary gets these vars too.
BACKEND_ENV_FILE="${BACKEND_ENV_FILE:-$REPO_DIR/backend/.env}"
[ -f "$BACKEND_ENV_FILE" ] && { set -a; . "$BACKEND_ENV_FILE"; set +a; }

# Database connection string for OPTIONAL pre-restart migrations via the sqlx
# CLI. Falls back to DATABASE_DSN from the env file above. If sqlx isn't
# installed this step is skipped harmlessly — the backend also runs its
# migrations on startup (config.db.migrate()), so they get applied either way.
DATABASE_URL="${DATABASE_URL:-${DATABASE_DSN:-}}"

# Optional: URL to GET after the backend restarts, to confirm it came back up.
# A non-2xx response (or no response) fails the deploy loudly. Leave empty to
# skip. e.g. http://127.0.0.1:3000/api
HEALTHCHECK_URL="${HEALTHCHECK_URL:-}"

# Optional: command that receives a one-line failure message on stdin, so you
# hear about broken deploys without tailing logs. Leave empty to disable. e.g.
#   NOTIFY_CMD='curl -s -d @- https://ntfy.sh/my-deploys'
#   NOTIFY_CMD='mail -s "deploy failed" me@example.com'
NOTIFY_CMD="${NOTIFY_CMD:-}"

# Records the commit that was last successfully deployed. This is what decides
# whether there's work to do — NOT the git working-tree HEAD — so the very
# first run (no state file yet) builds and deploys even if the repo is already
# checked out at the latest commit.
STATE_FILE="${STATE_FILE:-$REPO_DIR/.deploy.state}"

# ---------------------------------------------------------------------------
# Arguments
# ---------------------------------------------------------------------------
FORCE=false
DRY_RUN=false
VERBOSE=false
SHOW_STATUS=false

usage() { sed -n '2,19p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }

while [ $# -gt 0 ]; do
    case "$1" in
        -f|--force)   FORCE=true ;;
        -n|--dry-run) DRY_RUN=true ;;
        -v|--verbose) VERBOSE=true ;;
        status)       SHOW_STATUS=true ;;
        -h|--help)    usage; exit 0 ;;
        *)            echo "unknown argument: $1" >&2; usage; exit 2 ;;
    esac
    shift
done

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
log()  { printf '%s  %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"; }
vlog() { $VERBOSE && log "$@"; return 0; }          # only when --verbose
notify() {                                          # pipe failure msg to NOTIFY_CMD
    [ -n "$NOTIFY_CMD" ] || return 0
    printf '%s\n' "$1" | eval "$NOTIFY_CMD" || true
}
die() { log "ERROR: $*"; notify "deploy failed on $(hostname): $*"; exit 1; }

# Clean up any half-finished staging artifacts on exit (success or failure).
STAGING="" ; BIN_TMP=""
cleanup() { rm -rf "$STAGING" "$BIN_TMP" 2>/dev/null || true; }
trap cleanup EXIT

cd "$REPO_DIR" || die "repo dir not found: $REPO_DIR"

# ---------------------------------------------------------------------------
# `status` — read-only report, no lock, no side effects.
# ---------------------------------------------------------------------------
if $SHOW_STATUS; then
    git fetch --quiet origin "$BRANCH" || die "git fetch failed"
    remote="$(git rev-parse "origin/$BRANCH")"
    deployed="none"; [ -f "$STATE_FILE" ] && deployed="$(cat "$STATE_FILE")"
    echo "last deployed: ${deployed:0:12}"
    echo "latest remote: ${remote:0:12}"
    if [ "$deployed" = "$remote" ]; then
        echo "status:        up to date"
    elif [ "$deployed" != "none" ] && git cat-file -e "$deployed^{commit}" 2>/dev/null; then
        echo "status:        $(git rev-list --count "$deployed..$remote") commit(s) behind"
    else
        echo "status:        not deployed yet"
    fi
    exit 0
fi

# ---------------------------------------------------------------------------
# Serialize runs: a long build must not collide with the next cron tick.
# flock on our own fd; a second invocation exits immediately.
# ---------------------------------------------------------------------------
exec 9>"$REPO_DIR/.deploy.lock"
if ! flock -n 9; then
    vlog "another deploy is already running; skipping this tick"
    exit 0
fi

# ---------------------------------------------------------------------------
# 1. Decide whether there's work, and which side(s) to rebuild.
# ---------------------------------------------------------------------------
git fetch --quiet origin "$BRANCH" || die "git fetch failed"
NEW_REV="$(git rev-parse "origin/$BRANCH")"

LAST_DEPLOYED=""
[ -f "$STATE_FILE" ] && LAST_DEPLOYED="$(cat "$STATE_FILE")"

if [ "$LAST_DEPLOYED" = "$NEW_REV" ] && ! $FORCE; then
    vlog "already deployed ${NEW_REV:0:8}; nothing to do"   # silent unless --verbose
    exit 0
fi

build_backend=false
build_frontend=false
if $FORCE; then
    log "forced deploy of ${NEW_REV:0:8}; building backend and frontend"
    build_backend=true; build_frontend=true
elif [ -n "$LAST_DEPLOYED" ] && git cat-file -e "$LAST_DEPLOYED^{commit}" 2>/dev/null; then
    log "deploying ${LAST_DEPLOYED:0:8} -> ${NEW_REV:0:8}:"
    git --no-pager log --oneline "$LAST_DEPLOYED..$NEW_REV" | sed 's/^/    /'
    CHANGED="$(git diff --name-only "$LAST_DEPLOYED" "$NEW_REV")"
    grep -q '^backend/'  <<<"$CHANGED" && build_backend=true
    grep -q '^frontend/' <<<"$CHANGED" && build_frontend=true
else
    log "first deploy (no prior state); building backend and frontend"
    build_backend=true; build_frontend=true
fi

if $DRY_RUN; then
    log "[dry-run] would build:$($build_backend && echo ' backend')$($build_frontend && echo ' frontend')"
    log "[dry-run] nothing changed; exiting"
    exit 0
fi

# Fast-forward the working tree to the target commit.
git merge --ff-only "origin/$BRANCH" || die "fast-forward failed (local commits or dirty tree?)"

# ---------------------------------------------------------------------------
# Per-service logic, split into build (safe, off to the side) and swap (the
# only part that touches prod). The build of *both* services runs before the
# swap of *either*, so a failure anywhere leaves the live version untouched.
# ---------------------------------------------------------------------------
NEW_BACKEND_BIN="$REPO_DIR/backend/target/release/backend"

build_backend() {
    log "compiling backend release binary..."
    ( cd "$REPO_DIR/backend" && cargo build --release ) || die "cargo build failed"
    [ -x "$NEW_BACKEND_BIN" ] || die "expected binary not found: $NEW_BACKEND_BIN"
}

build_frontend() {
    log "installing frontend deps and building..."
    ( cd "$REPO_DIR/frontend" && npm ci && rm -rf dist && npm run build ) \
        || die "frontend build failed"
    [ -d "$REPO_DIR/frontend/dist" ] || die "frontend build produced no dist/"
}

swap_frontend() {
    mkdir -p "$(dirname "$WEB_ROOT")"
    STAGING="$WEB_ROOT.new.$$"                      # tracked by cleanup trap
    local olddir="$WEB_ROOT.old.$$"
    rm -rf "$STAGING"
    cp -a "$REPO_DIR/frontend/dist" "$STAGING"      # stage beside WEB_ROOT (same filesystem)
    [ -e "$WEB_ROOT" ] && mv -T "$WEB_ROOT" "$olddir"
    mv -T "$STAGING" "$WEB_ROOT"                    # near-instant rename
    STAGING=""                                      # swapped in; nothing to clean
    rm -rf "$olddir"
    log "frontend deployed to $WEB_ROOT"
}

# Install or refresh the systemd unit from the repo, so a fresh box is fully
# bootstrapped and unit edits ship through git like everything else.
ensure_backend_unit() {
    [ -n "$BACKEND_SERVICE" ] && [ -f "$BACKEND_UNIT_SRC" ] || return 0
    local dest="/etc/systemd/system/$BACKEND_SERVICE.service"
    if ! sudo cmp -s "$BACKEND_UNIT_SRC" "$dest" 2>/dev/null; then
        log "installing/updating systemd unit $BACKEND_SERVICE..."
        sudo install -m 0644 "$BACKEND_UNIT_SRC" "$dest" || die "failed to install unit"
        sudo systemctl daemon-reload || die "systemctl daemon-reload failed"
        sudo systemctl enable "$BACKEND_SERVICE" >/dev/null 2>&1 || true
    fi
}

swap_backend() {
    # Optional pre-restart migrations. Skipped harmlessly if there's no DSN or
    # no sqlx CLI — the backend also migrates on startup, so they still apply.
    if [ -n "$DATABASE_URL" ] && command -v sqlx >/dev/null 2>&1; then
        log "running database migrations..."
        sqlx migrate run --source "$REPO_DIR/backend/migrations" \
            --database-url "$DATABASE_URL" || die "sqlx migrate failed"
        log "migrations applied"
    else
        log "skipping sqlx migrate (backend applies migrations on startup)"
    fi

    if [ -z "$BACKEND_SERVICE" ]; then
        log "BACKEND_SERVICE empty; new binary built but not deployed"
        return 0
    fi

    # Atomically replace the running binary, then a quick restart. The old
    # process served throughout the build; downtime is just the restart.
    BIN_TMP="$BACKEND_BIN.new"                      # tracked by cleanup trap
    install -m 0755 "$NEW_BACKEND_BIN" "$BIN_TMP"
    mv -f "$BIN_TMP" "$BACKEND_BIN"
    BIN_TMP=""
    ensure_backend_unit                            # create the unit if missing
    log "restarting $BACKEND_SERVICE..."
    sudo systemctl restart "$BACKEND_SERVICE" || die "failed to restart $BACKEND_SERVICE"

    # Confirm it actually came back up.
    if [ -n "$HEALTHCHECK_URL" ]; then
        for attempt in 1 2 3 4 5; do
            if curl -fsS --max-time 5 "$HEALTHCHECK_URL" >/dev/null 2>&1; then
                log "backend healthy ($HEALTHCHECK_URL)"
                return 0
            fi
            sleep 1
        done
        die "backend health check failed at $HEALTHCHECK_URL after restart"
    fi
    log "backend restarted"
}

# 2. Build everything that changed (nothing touches prod yet).
$build_backend  && build_backend
$build_frontend && build_frontend

# 3. Swap in the new version(s).
$build_frontend && swap_frontend
$build_backend  && swap_backend

# Record success LAST, so an earlier failure (which exits via `die`) never
# advances the marker — a broken deploy is retried next tick, not skipped.
echo "$NEW_REV" > "$STATE_FILE"
log "deploy complete at ${NEW_REV:0:8} in ${SECONDS}s"
