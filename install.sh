#!/usr/bin/env bash
# install.sh — install nova-relay from this checkout. Safe and idempotent:
#   * copies files only from this local checkout (never downloads or pipes remote code)
#   * installs each version side by side and switches a `current` symlink atomically, so
#     running workers keep using the version they started with
#   * never deletes anything and never overwrites an existing config or secrets file
#
# usage: ./install.sh [--systemd box|vps]
set -euo pipefail

ROLE=""
if [ "${1:-}" = "--systemd" ]; then ROLE="${2:-}"; fi
case "$ROLE" in ""|box|vps) ;; *) echo "usage: ./install.sh [--systemd box|vps]" >&2; exit 2 ;; esac

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PREFIX="${NOVA_RELAY_PREFIX:-$HOME/.local/share/nova-relay}"
BIN_DIR="${NOVA_RELAY_BIN_DIR:-$HOME/.local/bin}"
# Same rule as the CLI (lib/paths.mjs): $XDG_CONFIG_HOME if set, else ~/.config. A relative
# XDG_CONFIG_HOME is invalid (XDG Base Directory spec): refuse rather than create dirs under cwd.
case "${XDG_CONFIG_HOME:-}" in
  ""|/*) ;;
  *) echo "error: XDG_CONFIG_HOME=$XDG_CONFIG_HOME is not an absolute path; unset it or make it absolute" >&2; exit 2 ;;
esac
for v in NOVA_RELAY_CONFIG NOVA_RELAY_SECRETS; do
  val="${!v:-}"
  case "$val" in
    *[![:space:]]*) case "$val" in /*|"~"|"~/"*) ;; *) echo "error: $v=$val is not an absolute path (the CLI refuses it too)" >&2; exit 2 ;; esac ;;
  esac
done
CONF_BASE="${XDG_CONFIG_HOME:-$HOME/.config}"
CONF_DIR="$CONF_BASE/nova-relay"
# A non-default config base must reach unattended runs (systemd units, cron) too, or they would
# look in ~/.config/nova-relay and not find this config.
CUSTOM_XDG=""
if [ "${CONF_BASE%/}" != "$HOME/.config" ]; then CUSTOM_XDG="${CONF_BASE%/}"; fi
# shell-quoted for printed commands; systemd-quoted ("...", with \ \" %% and, in Exec lines, $$).
shq() { printf '%q' "$1"; }
sdq() { local s="${1//\\/\\\\}"; s="${s//\"/\\\"}"; s="${s//%/%%}"; [ "${2:-}" = exec ] && s="${s//\$/\$\$}"; printf '"%s"' "$s"; }

echo "==> checking prerequisites"
command -v node >/dev/null 2>&1 || { echo "error: node not found (need Node.js >= 22)" >&2; exit 1; }
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
[ "$NODE_MAJOR" -ge 22 ] || { echo "error: Node.js $(node -v) found, need >= 22" >&2; exit 1; }
command -v git >/dev/null 2>&1 || { echo "error: git not found (need >= 2.38)" >&2; exit 1; }
GIT_VER=$(git --version | awk '{print $3}')
if [ "$(printf '%s\n2.38\n' "$GIT_VER" | sort -V | head -1)" != "2.38" ]; then
  echo "error: git $GIT_VER found, need >= 2.38 (merge-tree --write-tree)" >&2; exit 1
fi
echo "  ok node $(node -v), git $GIT_VER"

VERSION=$(node -p 'require(process.argv[1]).version' "$SRC/package.json")
DEST="$PREFIX/versions/$VERSION"
echo "==> installing nova-relay $VERSION to $DEST"
mkdir -p "$DEST" "$BIN_DIR" "$CONF_DIR"
for d in bin lib extensions systemd config templates routines skills; do
  [ -d "$SRC/$d" ] && cp -R "$SRC/$d" "$DEST/"
done
cp "$SRC/package.json" "$SRC/LICENSE" "$SRC/NOTICE" "$DEST/"
chmod +x "$DEST/bin/nova-relay" "$DEST/bin/nova-relay.mjs" "$DEST/bin/nova-guard-hook.mjs"
# ssh/systemd run with a minimal PATH (nvm / custom Node installs are not on it): record node.
command -v node > "$DEST/bin/.node-path.tmp" && mv "$DEST/bin/.node-path.tmp" "$DEST/bin/.node-path"
echo "  ok node for timers/ssh: $(cat "$DEST/bin/.node-path")"

# Atomic switch: new symlink next to the old one, then rename over it.
ln -sfn "$DEST" "$PREFIX/current.tmp.$$"
mv -T "$PREFIX/current.tmp.$$" "$PREFIX/current"
ln -sfn "$PREFIX/current/bin/nova-relay" "$BIN_DIR/nova-relay"
echo "  ok $BIN_DIR/nova-relay -> $PREFIX/current/bin/nova-relay"

if [ ! -e "$CONF_DIR/config.json" ]; then
  install -m 600 "$SRC/config/nova-relay.example.json" "$CONF_DIR/config.json"
  echo "  ok created $CONF_DIR/config.json from the example — edit it (self, hosts, projects, and the"
  echo "     pi / deepseek-text \"model\" placeholders: there is no default model id)"
else
  echo "  ok kept existing $CONF_DIR/config.json"
fi
if [ ! -e "$CONF_DIR/secrets.env" ]; then
  install -m 600 /dev/null "$CONF_DIR/secrets.env"
  echo "  ok created empty $CONF_DIR/secrets.env (0600) — put KEY=VALUE secrets here, never in the repo"
fi

if [ -n "$ROLE" ]; then
  UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
  mkdir -p "$UNIT_DIR"
  if [ "$ROLE" = box ]; then UNITS="nova-relay-tick.service nova-relay-tick.timer"; TIMER=nova-relay-tick.timer
  else UNITS="nova-relay-watchdog.service nova-relay-watchdog.timer"; TIMER=nova-relay-watchdog.timer; fi
  # ExecStart must point at the bin dir actually used (NOVA_RELAY_BIN_DIR may differ from the
  # default ~/.local/bin). A unit the user edited since the last install is not overwritten: the
  # new version goes next to it as <unit>.nova-new.
  mkdir -p "$PREFIX/units"
  for u in $UNITS; do
    content="$(cat "$SRC/systemd/$u")"
    if [ "$BIN_DIR" != "$HOME/.local/bin" ]; then
      exe="$(sdq "$BIN_DIR/nova-relay" exec)"
      content="${content//%h\/.local\/bin\/nova-relay/"$exe"}"
    fi
    if [ -n "$CUSTOM_XDG" ]; then
      envline="Environment=$(sdq "XDG_CONFIG_HOME=$CUSTOM_XDG")"
      content="${content//$'\n'ExecStart=/$'\n'"$envline"$'\n'ExecStart=}"
    fi
    printf '%s\n' "$content" > "$UNIT_DIR/.$u.tmp.$$"
    if [ -e "$UNIT_DIR/$u" ] && ! cmp -s "$UNIT_DIR/$u" "$UNIT_DIR/.$u.tmp.$$" \
       && ! { [ -e "$PREFIX/units/$u" ] && cmp -s "$UNIT_DIR/$u" "$PREFIX/units/$u"; }; then
      mv "$UNIT_DIR/.$u.tmp.$$" "$UNIT_DIR/$u.nova-new"
      echo "  !! kept your edited $UNIT_DIR/$u; the new version is $UNIT_DIR/$u.nova-new (merge it by hand)"
    else
      cp "$UNIT_DIR/.$u.tmp.$$" "$PREFIX/units/$u"
      mv "$UNIT_DIR/.$u.tmp.$$" "$UNIT_DIR/$u"
      echo "  ok installed $UNIT_DIR/$u"
    fi
  done
  echo "     enable with: systemctl --user daemon-reload && systemctl --user enable --now $TIMER"
  echo "     (and: loginctl enable-linger \$USER so it runs without a login session)"
  if [ "$ROLE" = vps ]; then
    echo "     the watchdog logs to <home>/run/watchdog.log itself (rotated at 5 MB, one .1 kept);"
    cron="$(shq "$BIN_DIR/nova-relay") watchdog"
    if [ -n "$CUSTOM_XDG" ]; then cron="XDG_CONFIG_HOME=$(shq "$CUSTOM_XDG") $cron"; fi
    echo "     with cron instead: */5 * * * * ${cron//%/\\%}   (no >> redirect)"
  fi
fi

echo ""
echo "next:"
echo "  1. edit $(shq "$CONF_DIR/config.json")  (docs/config.md)"
echo "  2. nova-relay doctor"
if [ -n "$CUSTOM_XDG" ]; then
  echo "     (the CLI finds this config while XDG_CONFIG_HOME=$(shq "$CUSTOM_XDG") is set; installed units and"
  echo "      the cron line above set it; an interactive shell without it reads ~/.config/nova-relay instead)"
fi
for v in NOVA_RELAY_CONFIG NOVA_RELAY_SECRETS; do
  case "${!v:-}" in *[![:space:]]*) echo "     note: $v is set; it overrides $(shq "$CONF_DIR")/ for that file (install wrote there only)";; esac
done
echo "  3. see README.zh-CN.md / docs/setup-box.md / docs/setup-vps.md"
