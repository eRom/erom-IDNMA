#!/usr/bin/env bash
# Installeur d'IdnmA : curl -fsSL https://erom.cloud/install_idnma.sh | bash
#
# Clone la dernière release dans ~/.idnma (ou $IDNMA_HOME), installe les dépendances figées,
# rend la commande `idnma` disponible par `bun link`, puis crée ~/.idnma.yml s'il manque.
# Relancé, il met à jour le même checkout vers la dernière release. Il n'installe aucun
# prérequis lui-même : il dit lequel manque et la commande pour l'installer.
#
# Variables :
#   IDNMA_VERSION  tag (ou commit) à installer ; défaut : la dernière release
#   IDNMA_HOME     dossier du checkout ; défaut : ~/.idnma
#   IDNMA_REPO     dépôt à cloner ; défaut : https://github.com/eRom/erom-IDNMA.git
#   IDNMA_RELINK   1 pour reprendre la commande `idnma` liée à un autre checkout

# Tout vit dans main, appelée à la dernière ligne : un téléchargement coupé n'exécute rien.
set -euo pipefail

readonly MIN_MACOS_MAJOR=26
readonly MIN_BUN="1.4.0"

if [ -t 1 ]; then
  BOLD=$'\033[1m' DIM=$'\033[2m' RED=$'\033[31m' GREEN=$'\033[32m' YELLOW=$'\033[33m' RESET=$'\033[0m'
else
  BOLD="" DIM="" RED="" GREEN="" YELLOW="" RESET=""
fi

step() { printf '%s==>%s %s\n' "$BOLD" "$RESET" "$*"; }
note() { printf '    %s%s%s\n' "$DIM" "$*" "$RESET"; }
warn() { printf '%swarning:%s %s\n' "$YELLOW" "$RESET" "$*" >&2; }
die() {
  printf '%serror:%s %s\n' "$RED" "$RESET" "$1" >&2
  shift
  for line in "$@"; do printf '       %s\n' "$line" >&2; done
  exit 1
}

# Vrai si la version $1 (x.y.z) est au moins $2.
version_at_least() {
  local IFS=.
  # shellcheck disable=SC2206 # découpage voulu sur les points
  local have=($1) want=($2)
  local i
  for i in 0 1 2; do
    local h=${have[i]:-0} w=${want[i]:-0}
    h=${h%%[!0-9]*} w=${w%%[!0-9]*}
    if ((10#${h:-0} > 10#${w:-0})); then return 0; fi
    if ((10#${h:-0} < 10#${w:-0})); then return 1; fi
  done
  return 0
}

check_platform() {
  [ "$(uname -s)" = "Darwin" ] || die "IdnmA supports macOS only for now." \
    "Linux support is on the roadmap: https://github.com/eRom/erom-IDNMA"
  local macos
  macos=$(sw_vers -productVersion)
  version_at_least "$macos" "$MIN_MACOS_MAJOR.0" || die "IdnmA needs macOS $MIN_MACOS_MAJOR or later (found $macos)."
}

check_requirements() {
  command -v git >/dev/null 2>&1 || die "git is required." "Install it with: xcode-select --install"
  command -v tmux >/dev/null 2>&1 || die "tmux is required: each agent runs in a tmux pane." "Install it with: brew install tmux"
  command -v bun >/dev/null 2>&1 || die "Bun $MIN_BUN or later is required." "Install it with: curl -fsSL https://bun.sh/install | bash" \
    "then open a new terminal and run this installer again."
  local bun_version
  bun_version=$(bun --version)
  version_at_least "$bun_version" "$MIN_BUN" || die "Bun $MIN_BUN or later is required (found $bun_version)." "Upgrade it with: bun upgrade"
}

# Dernier tag de release du dépôt, sans passer par l'API GitHub (pas de limite de débit).
latest_tag() {
  git ls-remote --tags --refs --sort=-v:refname "$1" 'v*' 2>/dev/null | head -n 1 | sed 's#.*refs/tags/##'
}

# Refuse de reprendre une commande `idnma` liée à un autre checkout : les hooks déjà posés
# pointent vers ce checkout-là, et les déplacer en silence casserait les agents installés.
check_existing_link() {
  local home=$1 current target home_real
  current=$(command -v idnma 2>/dev/null) || return 0
  target=$(readlink -f "$current" 2>/dev/null) || return 0
  # Chemins résolus des deux côtés : /tmp et /private/tmp désignent le même dossier sous macOS.
  home_real=$(cd "$home" 2>/dev/null && pwd -P) || home_real=$home
  case "$target" in
    "$home"/* | "$home_real"/*) return 0 ;;
  esac
  [ "${IDNMA_RELINK:-0}" = "1" ] && {
    warn "relinking idnma from $target"
    note "re-run 'idnma install --agent <agent>' for each agent installed from the old checkout."
    return 0
  }
  die "idnma is already linked to another checkout: $target" \
    "Hooks installed from it point there. To switch to $home anyway, run:" \
    "  curl -fsSL https://erom.cloud/install_idnma.sh | IDNMA_RELINK=1 bash"
}

fetch_checkout() {
  local repo=$1 home=$2 ref=$3
  if [ -d "$home/.git" ]; then
    local origin
    origin=$(git -C "$home" remote get-url origin 2>/dev/null || true)
    [ "$origin" = "$repo" ] || die "$home already exists and is not an IdnmA checkout of $repo (origin: ${origin:-none})." \
      "Move it away, or pick another folder with IDNMA_HOME."
    [ -z "$(git -C "$home" status --porcelain --untracked-files=no)" ] || die "$home has local changes; refusing to update it." \
      "Commit or discard them, then run this installer again."
    step "Updating $home"
    git -C "$home" fetch --quiet --tags --force origin
  elif [ -e "$home" ]; then
    die "$home already exists and is not a git checkout." "Move it away, or pick another folder with IDNMA_HOME."
  else
    step "Cloning $repo into $home"
    git clone --quiet "$repo" "$home"
  fi
  git -C "$home" rev-parse --verify --quiet "$ref^{commit}" >/dev/null || die "$ref is not a release or commit of $repo." \
    "See https://github.com/eRom/erom-IDNMA/releases, or unset IDNMA_VERSION for the latest one."
  git -C "$home" -c advice.detachedHead=false checkout --quiet "$ref"
}

main() {
  local repo=${IDNMA_REPO:-https://github.com/eRom/erom-IDNMA.git}
  local home=${IDNMA_HOME:-$HOME/.idnma}
  check_platform
  check_requirements

  # Dossier où `bun link` pose la commande. `bun pm bin -g` échoue sur un Bun neuf, sans
  # package.json global : on retombe alors sur les variables de Bun, puis sur son défaut.
  local bun_bin
  bun_bin=$(bun pm bin -g 2>/dev/null) || bun_bin=${BUN_INSTALL_BIN:-${BUN_INSTALL:-$HOME/.bun}/bin}

  local ref=${IDNMA_VERSION:-}
  if [ -z "$ref" ]; then
    ref=$(latest_tag "$repo")
    [ -n "$ref" ] || die "Could not find a release of $repo." "Check your network, or set IDNMA_VERSION."
  fi

  check_existing_link "$home"
  fetch_checkout "$repo" "$home" "$ref"

  step "Installing dependencies"
  (cd "$home" && bun install --frozen-lockfile --production --silent)

  step "Linking the idnma command"
  (cd "$home" && bun link --silent)

  step "Creating ~/.idnma.yml if missing"
  (cd "$home" && bun scripts/install-config.ts)

  local version
  version=$("$bun_bin/idnma" --version 2>/dev/null) || die "idnma was installed but does not run: $bun_bin/idnma --version failed."

  printf '\n%s%s installed%s in %s (%s)\n' "$GREEN" "$version" "$RESET" "$home" "$ref"
  case ":$PATH:" in
    *":$bun_bin:"*) ;;
    *) warn "$bun_bin is not on your PATH; add it to your shell profile:"
       note "export PATH=\"$bun_bin:\$PATH\"" ;;
  esac
  printf '\nNext steps:\n'
  printf '  1. Describe your agents in ~/.idnma.yml\n'
  printf '  2. Connect each harness:  idnma install --agent <claude|codex|grok|agy|opencode|dst>\n'
  printf '  3. Inside a tmux pane:    idnma run <agent>\n'
  printf '\nDocs: https://github.com/eRom/erom-IDNMA\n'
}

main "$@"
