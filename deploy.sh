#!/usr/bin/env bash
#
# deploy.sh — pull latest from GitHub and rebuild only what changed.
#
# Safe to run from cron. It is a no-op when the remote has no new commits.
# All slow work (git pull, cargo build, npm build) happens while the live
# service keeps running the OLD version; the new version is only swapped in
# at the very end, and only if the build succeeded — so a broken commit or a
# failed compile never takes production down.
#
# Example crontab (every 5 minutes), logging to a file:
#   */5 * * * * /var/www/AndrewMcCall/deploy.sh >> /var/log/andrewmccall-deploy.log 2>&1
#
set -euo pipefail

# ---------------------------------------------------------------------------
# Configuration — adjust these for the prod box.
# ---------------------------------------------------------------------------
REPO_DIR="${REPO_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
BRANCH="${BRANCH:-main}"

# Where nginx serves the frontend from. The built `dist` is swapped in here
# atomically. Must be writable by the user running this script.
WEB_ROOT="${WEB_ROOT:-/static/www/www.andrewmccall.uk}"

# systemd unit for the Rust backend. Leave empty to skip the restart step
# (e.g. if you manage the backend some other way).
BACKEND_SERVICE="${BACKEND_SERVICE:-andrewmccall-backend}"

# Where the running backend binary lives (what BACKEND_SERVICE executes).
# The freshly compiled binary is installed here just before the restart.
BACKEND_BIN="${BACKEND_BIN:-/usr/local/bin/andrewmccall-backend}"

# Database connection string for running migrations with the sqlx CLI, e.g.
#   postgres://user:pass@host:5432/dbname
# Falls back to DATABASE_DSN (what the backend itself reads). Leave empty to
# skip the migration step. Requires `sqlx` (cargo install sqlx-cli) on PATH.
DATABASE_URL="${DATABASE_URL:-${DATABASE_DSN:-}}"

# ---------------------------------------------------------------------------
# Machinery — you shouldn't need to touch below here.
# ---------------------------------------------------------------------------
log() { printf '%s  %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"; }
die() { log "ERROR: $*"; exit 1; }

cd "$REPO_DIR" || die "repo dir not found: $REPO_DIR"

# Prevent overlapping runs (a long build must not collide with the next cron
# tick). flock on our own fd; a second invocation exits immediately.
exec 9>"$REPO_DIR/.deploy.lock"
if ! flock -n 9; then
    log "another deploy is already running; skipping this tick"
    exit 0
fi

# ---------------------------------------------------------------------------
# 1. Check the remote for new commits. No-op if we're already up to date.
# ---------------------------------------------------------------------------
git fetch --quiet origin "$BRANCH" || die "git fetch failed"

OLD_REV="$(git rev-parse HEAD)"
NEW_REV="$(git rev-parse "origin/$BRANCH")"

if [ "$OLD_REV" = "$NEW_REV" ]; then
    log "up to date at ${OLD_REV:0:8}; nothing to do"
    exit 0
fi

log "changes detected: ${OLD_REV:0:8} -> ${NEW_REV:0:8}"

# What changed, so we only rebuild the affected side.
CHANGED="$(git diff --name-only "$OLD_REV" "$NEW_REV")"
build_backend=false
build_frontend=false
grep -q '^backend/'  <<<"$CHANGED" && build_backend=true
grep -q '^frontend/' <<<"$CHANGED" && build_frontend=true

# Fast-forward the working tree to the new commit.
git merge --ff-only "origin/$BRANCH" || die "fast-forward failed (local commits or dirty tree?)"

# ---------------------------------------------------------------------------
# 2. Build EVERYTHING that changed first, before touching prod. If any build
#    fails we exit non-zero having swapped nothing, so the old version keeps
#    serving.
# ---------------------------------------------------------------------------

# --- Backend: compile the new binary, but don't install/restart yet. --------
if $build_backend; then
    log "backend changed; compiling release binary..."
    ( cd "$REPO_DIR/backend" && cargo build --release ) || die "cargo build failed"
    NEW_BACKEND_BIN="$REPO_DIR/backend/target/release/backend"
    [ -x "$NEW_BACKEND_BIN" ] || die "expected binary not found: $NEW_BACKEND_BIN"
else
    log "no backend changes"
fi

# --- Frontend: build into a temporary dist, don't swap yet. ------------------
if $build_frontend; then
    log "frontend changed; installing deps and building..."
    cd "$REPO_DIR/frontend"
    npm ci                          || die "npm ci failed"
    rm -rf dist
    npm run build                   || die "frontend build failed"
    [ -d "$REPO_DIR/frontend/dist" ] || die "frontend build produced no dist/"
    cd "$REPO_DIR"
else
    log "no frontend changes"
fi

# ---------------------------------------------------------------------------
# 3. Swap in the new version. This is the only part that touches prod, and
#    it's fast: a directory rename for the frontend and a service restart for
#    the backend — no long build stalls the service.
# ---------------------------------------------------------------------------

# --- Frontend: atomic-ish swap of the dist directory. -----------------------
if $build_frontend; then
    mkdir -p "$WEB_ROOT"
    STAGING="$WEB_ROOT/dist.new.$$"
    OLDDIR="$WEB_ROOT/dist.old.$$"
    rm -rf "$STAGING"
    cp -a "$REPO_DIR/frontend/dist" "$STAGING"   # stage on same filesystem as WEB_ROOT
    if [ -e "$WEB_ROOT/dist" ]; then
        mv -T "$WEB_ROOT/dist" "$OLDDIR"
    fi
    mv -T "$STAGING" "$WEB_ROOT/dist"            # near-instant rename
    rm -rf "$OLDDIR"
    log "frontend deployed to $WEB_ROOT/dist"
fi

# --- Backend: run DB migrations before the new binary starts serving. -------
if $build_backend; then
    if [ -n "$DATABASE_URL" ]; then
        command -v sqlx >/dev/null 2>&1 || die "sqlx CLI not found on PATH (cargo install sqlx-cli)"
        log "running database migrations..."
        sqlx migrate run \
            --source "$REPO_DIR/backend/migrations" \
            --database-url "$DATABASE_URL" \
            || die "sqlx migrate failed"
        log "migrations applied"
    else
        log "DATABASE_URL empty; skipping migrations"
    fi
fi

# --- Backend: install new binary, then restart the service. -----------------
if $build_backend; then
    if [ -n "$BACKEND_SERVICE" ]; then
        # Install the new binary next to the old (atomic replace), then a
        # quick service restart. The old process served throughout the build;
        # downtime here is just the restart, typically sub-second.
        install -m 0755 "$NEW_BACKEND_BIN" "$BACKEND_BIN.new"
        mv -f "$BACKEND_BIN.new" "$BACKEND_BIN"
        log "restarting $BACKEND_SERVICE..."
        sudo systemctl restart "$BACKEND_SERVICE" || die "failed to restart $BACKEND_SERVICE"
        log "backend restarted"
    else
        log "BACKEND_SERVICE empty; new binary built at $NEW_BACKEND_BIN but not deployed"
    fi
fi

log "deploy complete at ${NEW_REV:0:8}"
