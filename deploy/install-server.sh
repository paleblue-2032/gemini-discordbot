#!/usr/bin/env bash
# gemini-discordbot を kanon-server にセットアップする。
# 旧 commandcode-discordbot は停止・自動起動無効にするが、unit と .env は残す。
# 実行: sudo TAKEOVER=1 GEMINI_API_KEY=... bash deploy/install-server.sh
set -euo pipefail

REPO_URL=${REPO_URL:-https://github.com/paleblue-2032/gemini-discordbot.git}
REPO_DIR=${REPO_DIR:-/srv/gemini-discordbot}
RUN_USER=${RUN_USER:-cmdbot}
RUN_GROUP=${RUN_GROUP:-cmdwork}
OLD_ENV=${OLD_ENV:-/srv/commandcode-discordbot/.env}
UNIT=gemini-discordbot.service
TAKEOVER=${TAKEOVER:-0}

if [ "$(id -u)" -ne 0 ]; then
  echo "root で実行してください: sudo TAKEOVER=1 bash $0" >&2
  exit 1
fi

if ! id "$RUN_USER" >/dev/null 2>&1; then
  echo "実行ユーザーが見つかりません: $RUN_USER" >&2
  exit 1
fi
if ! getent group "$RUN_GROUP" >/dev/null; then
  echo "実行グループが見つかりません: $RUN_GROUP" >&2
  exit 1
fi

echo "== 1. リポジトリ =="
if [ ! -d "$REPO_DIR/.git" ]; then
  install -d -o "$RUN_USER" -g "$RUN_GROUP" -m 2775 "$REPO_DIR"
  runuser -u "$RUN_USER" -- git clone "$REPO_URL" "$REPO_DIR"
else
  runuser -u "$RUN_USER" -- git -C "$REPO_DIR" pull --ff-only
fi
chown "$RUN_USER:$RUN_GROUP" "$REPO_DIR"
chmod 2775 "$REPO_DIR"

echo "== 2. ビルド =="
run_user_home="$(getent passwd "$RUN_USER" | cut -d: -f6)"
runuser -u "$RUN_USER" -- env HOME="$run_user_home" \
  PATH=/nix/var/nix/profiles/default/bin:/usr/local/bin:/usr/bin:/bin \
  nix build "$REPO_DIR#default" -o "$REPO_DIR/result" --print-build-logs

echo "== 3. .env =="
ENV_FILE="$REPO_DIR/.env"

set_env() {
  local key="$1"
  local value="$2"
  if grep -q "^${key}=" "$ENV_FILE"; then
    sed -i "s|^${key}=.*|${key}=${value}|" "$ENV_FILE"
  else
    printf '%s=%s\n' "$key" "$value" >>"$ENV_FILE"
  fi
}

if [ ! -f "$ENV_FILE" ]; then
  umask 077
  : >"$ENV_FILE"
  if [ -f "$OLD_ENV" ]; then
    grep -E '^(DISCORD_TOKEN|ALLOWED_USER_IDS|ALLOWED_CHANNEL_IDS|ALLOWED_ROOTS|DEFAULT_CWD|FORUM_CWD|MAX_CONCURRENCY|UPLOAD_TTL_HOURS|UPLOAD_SWEEP_INTERVAL_MINUTES|STORAGE_TARGET_PERCENT|STORAGE_DEGRADED_PERCENT|STORAGE_SWEEP_INTERVAL_MINUTES|WORKDIR_META|CWD_CONFLICT|TRIGGER_MODE|CMD_BIN|CMD_MODEL|CMD_EFFORT)=' \
      "$OLD_ENV" >>"$ENV_FILE" || true
  fi
  {
    echo "AI_BACKEND=gemini"
    echo "GEMINI_API_KEY=${GEMINI_API_KEY:-}"
    echo "GEMINI_MODEL=${GEMINI_MODEL:-gemini-3.1-flash-lite}"
    echo "GEMINI_BASE_URL=${GEMINI_BASE_URL:-https://generativelanguage.googleapis.com/v1beta}"
    echo "GEMINI_GOOGLE_SEARCH=false"
    echo "GEMINI_MAX_HISTORY_MESSAGES=40"
    echo "GEMINI_TIMEOUT_MS=180000"
    echo "GEMINI_MAX_OUTPUT_TOKENS=8192"
  } >>"$ENV_FILE"
  umask 022
else
  echo "既存の .env はそのまま使います"
fi

backend="${AI_BACKEND:-gemini}"
if [ -n "${GEMINI_API_KEY:-}" ]; then
  set_env GEMINI_API_KEY "$GEMINI_API_KEY"
fi
set_env AI_BACKEND "$backend"
set_env SESSIONS_FILE "./sessions.json"
set_env GEMINI_HISTORY_FILE "./gemini-history.json"
set_env SMART_FILE "/var/lib/gemini-discordbot/smart.json"
chown root:root "$ENV_FILE"
chmod 600 "$ENV_FILE"

if ! grep -qE '^DISCORD_TOKEN=.+' "$ENV_FILE"; then
  echo "DISCORD_TOKEN が未設定です。sudo nano $ENV_FILE で設定してください。" >&2
  exit 1
fi
if [ "$backend" = "gemini" ] && ! grep -qE '^GEMINI_API_KEY=.+' "$ENV_FILE"; then
  echo "GEMINI_API_KEY が未設定です。sudo nano $ENV_FILE で設定してください。" >&2
  exit 1
fi

echo "== 4. systemd unit =="
install -o root -g root -m 644 "$REPO_DIR/deploy/$UNIT" "/etc/systemd/system/$UNIT"
install -o root -g root -m 755 "$REPO_DIR/deploy/gemini-disk-health" /usr/local/sbin/gemini-disk-health
install -o root -g root -m 644 "$REPO_DIR/deploy/gemini-disk-health.service" /etc/systemd/system/gemini-disk-health.service
install -o root -g root -m 644 "$REPO_DIR/deploy/gemini-disk-health.timer" /etc/systemd/system/gemini-disk-health.timer
install -o root -g root -m 755 "$REPO_DIR/deploy/botctl" /usr/local/sbin/botctl
systemctl daemon-reload
systemctl enable --now gemini-disk-health.timer

if [ "$TAKEOVER" = "1" ]; then
  echo "== 5. 旧 commandcode サービスを停止 =="
  systemctl disable --now commandcode-discordbot.service || true
fi

echo "== 6. gemini-discordbot を起動 =="
systemctl enable "$UNIT"
systemctl restart "$UNIT"
if ! systemctl is-active --quiet "$UNIT"; then
  systemctl status "$UNIT" --no-pager -n 30 || true
  journalctl -u "$UNIT" -n 50 --no-pager || true
  exit 1
fi
systemctl status "$UNIT" --no-pager -n 5 || true

echo
echo "完了しました。"
echo "  sudo botctl status gemini"
echo "  sudo botctl logs gemini"
echo
echo "cmd バックエンドに戻す場合:"
echo "  sudo nano $ENV_FILE   # AI_BACKEND=cmd"
echo "  sudo botctl restart gemini"
echo
echo "旧 bot に戻す場合:"
echo "  sudo botctl disable gemini"
echo "  sudo botctl enable commandcode"
