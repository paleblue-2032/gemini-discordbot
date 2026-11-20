#!/usr/bin/env bash
# Command Code の PreToolUse hook。
# --yolo でも効く決定論的なバックストップ。
#
# 方針:
#   - 作業ディレクトリ（既定 /srv/work）の中は自由に読み書きできる
#   - サーバーの構成ファイル（/etc、ブート、root、proc、sys、他の /srv 配下など）は読ませない
#   - 稼働状況の確認（systemctl status / journalctl / sensors / df など）だけは許可する
#   - 権限昇格・システム変更コマンドは許可しない
#
# 入力: PreToolUse の JSON（stdin）
# 出力: permissionDecision の JSON、または何もしない場合は空 + exit 0
# インストール先: /home/cmdbot/.commandcode/hooks/guard.sh（root 所有 755）
set -uo pipefail

payload=$(cat)

if ! command -v jq >/dev/null 2>&1; then
  exit 0
fi

tool_display=$(printf '%s' "$payload" | jq -r '.tool_display_name // ""')
tool_name=$(printf '%s' "$payload" | jq -r '.tool_name // ""')

case "$tool_display" in
  SHELL) kind=shell ;;
  READ|WRITE|EDIT) kind=file ;;
  *)
    case "$tool_name" in
      shell_command|monitor_command) kind=shell ;;
      read_file|write_file|edit_file) kind=file ;;
      *) exit 0 ;;
    esac
    ;;
esac

deny() {
  reason="$1"
  jq -n --arg reason "$reason" '{
    continue: true,
    systemMessage: ("guard: " + $reason),
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: $reason
    }
  }'
  exit 0
}

# 作業してよい場所（ALLOWED_ROOTS と揃える）
ALLOWED_ROOTS=(
  "/srv/work"
)

# 例外として触ってよいユーザー配下（ツールのキャッシュ類）
ALLOWED_HOME_PATHS=(
  "/home/cmdbot/.cache"
  "/home/cmdbot/.npm"
  "/home/cmdbot/.npm-global"
  "/home/cmdbot/.nix-profile"
  "/home/cmdbot/.local/state/nix"
)

# 読ませないサーバー構成・システム領域
SERVER_CONFIG_PATHS=(
  "/etc"
  "/boot"
  "/root"
  "/sys"
  "/proc"
  "/var/lib"
  "/var/log"
  "/home/cmdbot"
  "/srv"
)

# 稼働状況の確認に使えるコマンド（読み取り専用）
# ここに無いものも、危険コマンドと保護パスに触れなければ許可する。
# 一覧は運用の参考として残す: sensors / df / free / uptime / ps / lsblk / journalctl など

# systemctl のうち読み取り専用のサブコマンド
SYSTEMCTL_READ_VERBS=(
  status
  is-active
  is-failed
  is-enabled
  list-units
  list-timers
  list-unit-files
  show
  cat
)

# コマンド位置に来たら拒否する実行ファイル
DANGEROUS_COMMANDS=(
  sudo
  doas
  shutdown
  reboot
  poweroff
  halt
  mkfs
  fdisk
  parted
  visudo
  passwd
  ufw
  iptables
  nft
  mount
  umount
  modprobe
  insmod
  dd
  chown
  chmod
)

# 中身を実行しうるラッパー
WRAPPERS=(
  env
  timeout
  nice
  ionice
  nohup
  setsid
  stdbuf
  xargs
  command
  exec
  busybox
  bash
  sh
  zsh
  dash
  eval
  python
  python3
  perl
)

under_any() {
  local target="$1"
  shift
  local prefix
  for prefix in "$@"; do
    case "$target" in
      "$prefix"|"$prefix"/*) return 0 ;;
    esac
  done
  return 1
}

in_list() {
  local needle="$1"
  shift
  local item
  for item in "$@"; do
    if [ "$item" = "$needle" ]; then
      return 0
    fi
  done
  return 1
}

# /srv のうち /srv/work 以外を参照していたら拒否
srv_outside_work() {
  local text="$1"
  local candidate
  while IFS= read -r candidate; do
    [ -z "$candidate" ] && continue
    if ! under_any "$candidate" "${ALLOWED_ROOTS[@]}"; then
      return 0
    fi
  done < <(printf '%s' "$text" | grep -oE '/srv/[A-Za-z0-9._/@-]*' || true)
  return 1
}

if [ "$kind" = "file" ]; then
  target=$(printf '%s' "$payload" | jq -r '.tool_input.file_path // .tool_input.absolute_path // ""')
  if [ -n "$target" ]; then
    if under_any "$target" "${ALLOWED_ROOTS[@]}" "${ALLOWED_HOME_PATHS[@]}"; then
      exit 0
    fi
    if under_any "$target" "${SERVER_CONFIG_PATHS[@]}"; then
      deny "サーバー構成ファイルは読み取れません: $target"
    fi
  fi
  exit 0
fi

command_text=$(printf '%s' "$payload" | jq -r '.tool_input.command // ""')
args_text=$(printf '%s' "$payload" | jq -r '(.tool_input.args // []) | join(" ")')
combined="$command_text $args_text"

if [ -z "${combined// /}" ]; then
  exit 0
fi

# 保護パス（チルダ・変数表記も含む）
for protected in "/home/cmdbot/.commandcode" "/home/cmdbot/.ssh" "/srv/commandcode-discordbot" "/srv/gemini-discordbot" "~/.commandcode" '$HOME/.commandcode' '${HOME}/.commandcode' "~/.ssh"; do
  case "$combined" in
    *"$protected"*)
      deny "保護されたパスへのアクセスは禁止です: $protected"
      ;;
  esac
done

for protected in "/etc" "/boot" "/root/" "/sys/" "/proc/" "/var/lib" "/var/log"; do
  case "$combined" in
    *"$protected"*)
      deny "サーバー構成・システム領域へのアクセスは禁止です: $protected"
      ;;
  esac
done

home_refs=$(printf '%s' "$combined" | grep -oE '/home/cmdbot[A-Za-z0-9._/@-]*' || true)
if [ -n "$home_refs" ]; then
  while IFS= read -r ref; do
    [ -z "$ref" ] && continue
    if ! under_any "$ref" "${ALLOWED_ROOTS[@]}" "${ALLOWED_HOME_PATHS[@]}"; then
      deny "ユーザー設定領域へのアクセスは禁止です: $ref"
    fi
  done <<< "$home_refs"
fi

if srv_outside_work "$combined"; then
  deny "/srv/work の外（サーバー管理領域）へのアクセスは禁止です。"
fi

case "$combined" in
  *"/proc/"*environ*) deny "プロセスの環境変数（秘密を含む）の読み取りは禁止です。" ;;
  *"ps eww"*|*"ps auxe"*|*"ps -e"*) deny "プロセスの環境変数の閲覧は禁止です。" ;;
esac

danger_word_pattern=""
for name in "${DANGEROUS_COMMANDS[@]}"; do
  if [ -z "$danger_word_pattern" ]; then
    danger_word_pattern="$name"
  else
    danger_word_pattern="$danger_word_pattern|$name"
  fi
done
danger_word_pattern="(^|[^[:alnum:]_-])($danger_word_pattern)([^[:alnum:]_-]|\$)"

segments=$(printf '%s\n' "$combined" | sed -e 's/&&/\n/g' -e 's/||/\n/g' -e 's/[;|&]/\n/g')

while IFS= read -r segment; do
  trimmed=${segment#"${segment%%[![:space:]]*}"}
  [ -z "$trimmed" ] && continue

  while [[ "$trimmed" =~ ^[[:space:]]*[A-Za-z_][A-Za-z0-9_]*=[^[:space:]]*[[:space:]]+(.*)$ ]]; do
    trimmed="${BASH_REMATCH[1]}"
  done

  base=$(printf '%s' "$trimmed" | awk '{print $1}')
  [ -z "$base" ] && continue
  base=${base##*/}

  if in_list "$base" "${DANGEROUS_COMMANDS[@]}"; then
    deny "このコマンドの実行は禁止です: $base"
  fi

  if [ "$base" = "systemctl" ]; then
    verb=$(printf '%s' "$trimmed" | awk '{print $2}')
    verb=${verb%%=*}
    if ! in_list "$verb" "${SYSTEMCTL_READ_VERBS[@]}"; then
      deny "systemctl は状態確認（status / is-active など）だけ許可されています: ${verb:-（サブコマンドなし）}"
    fi
    continue
  fi

  if in_list "$base" "${WRAPPERS[@]}"; then
    if printf '%s' "$segment" | grep -qE "$danger_word_pattern"; then
      deny "ラッパー経由の危険なコマンド実行は禁止です: $segment"
    fi
    if printf '%s' "$segment" | grep -qE '(^|[^[:alnum:]_-])systemctl([^[:alnum:]_-]|$)'; then
      wrapped_verb=$(printf '%s' "$segment" | awk '{print $2}')
      wrapped_verb=${wrapped_verb%%=*}
      if ! in_list "$wrapped_verb" "${SYSTEMCTL_READ_VERBS[@]}"; then
        deny "ラッパー経由の systemctl 実行は禁止です: $segment"
      fi
    fi
  fi
done <<< "$segments"

exit 0
