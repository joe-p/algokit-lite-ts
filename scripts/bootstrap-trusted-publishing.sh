#!/usr/bin/env bash
# Sets up npm trusted publishing (OIDC) for every package, so the release
# workflow can publish them.
#
# npm can only configure a trusted publisher for a package that already exists,
# so a package that isn't on npm yet is first published as an empty 0.0.0
# placeholder. The release workflow then publishes the real versions.
#
# A new trusted publisher configuration expires unless it is used to publish
# within 2 days, so run this when the packages are ready to be released.
#
# Placeholders are deprecated, so installing one warns that it has no code.
#
# Requires an interactive `npm login` (publishing and configuring trusted
# publishers need 2FA). Safe to re-run: packages that are already on npm,
# already trust the release workflow, or whose placeholder is already
# deprecated, are skipped.
#
# Usage: scripts/bootstrap-trusted-publishing.sh [--dry-run]
set -euo pipefail

REPOSITORY="joe-p/algokit-lite-ts"
# npm matches the workflow that requests the OIDC token, which is the calling
# workflow, not the reusable release-package.yml
WORKFLOW="release.yml"
PACKAGES=(composer app-client localnet generator algokit-lite)
PLACEHOLDER_VERSION="0.0.0"
DEPRECATION_MESSAGE="Placeholder for setting up trusted publishing, contains no code. Install a later version."

dry_run=()
if [ "${1:-}" = "--dry-run" ]; then
  dry_run=(--dry-run)
elif [ -n "${1:-}" ]; then
  echo "Unknown option: $1" >&2
  exit 1
fi

# npm trust --allow-publish needs npm 11.15.0 or later
npm_cli=(npx --yes npm@^11.15.0)

root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

"${npm_cli[@]}" whoami >/dev/null || {
  echo "Not logged in to npm. Run \`npm login\` first." >&2
  exit 1
}

for package in "${PACKAGES[@]}"; do
  dir="packages/${package}"
  name="$(cd "$dir" && npm pkg get name | tr -d '"')"
  echo "==> ${name}"

  published=true
  if ! "${npm_cli[@]}" view "$name" name >/dev/null 2>&1; then
    published=false
    stub="$(mktemp -d)"
    cat >"${stub}/package.json" <<JSON
{
  "name": "${name}",
  "version": "${PLACEHOLDER_VERSION}",
  "description": "Placeholder for setting up trusted publishing. Contains no code.",
  "repository": {
    "type": "git",
    "url": "https://github.com/${REPOSITORY}",
    "directory": "${dir}"
  }
}
JSON
    cat >"${stub}/README.md" <<MD
# ${name}

This version is a placeholder, published only to set up trusted publishing. It
contains no code. Install a later version.
MD
    echo "Publishing ${name}@${PLACEHOLDER_VERSION} placeholder"
    (cd "$stub" && "${npm_cli[@]}" publish --access public "${dry_run[@]}")
    rm -rf "$stub"
  fi

  # A dry run doesn't publish the placeholder, so there is nothing to list
  trusted=""
  if [ "$published" = true ] || [ ${#dry_run[@]} -eq 0 ]; then
    trusted="$("${npm_cli[@]}" trust list "$name" --json)"
  fi
  if grep -q "\"${WORKFLOW}\"" <<<"$trusted"; then
    echo "${name} already trusts ${WORKFLOW}."
  else
    echo "Trusting ${REPOSITORY}/.github/workflows/${WORKFLOW} to publish ${name}"
    "${npm_cli[@]}" trust github "$name" \
      --file "$WORKFLOW" \
      --repository "$REPOSITORY" \
      --allow-publish \
      --yes \
      "${dry_run[@]}"
  fi

  # A placeholder published by this run may not be visible to npm view yet,
  # so it is known to need deprecating without checking
  placeholder="${name}@${PLACEHOLDER_VERSION}"
  if [ "$published" = true ]; then
    if [ -z "$("${npm_cli[@]}" view "$placeholder" version 2>/dev/null)" ]; then
      echo "${name} has no ${PLACEHOLDER_VERSION} placeholder."
      continue
    fi
    if [ -n "$("${npm_cli[@]}" view "$placeholder" deprecated 2>/dev/null)" ]; then
      echo "${placeholder} is already deprecated."
      continue
    fi
  fi

  echo "Deprecating ${placeholder}"
  if [ ${#dry_run[@]} -eq 0 ]; then
    "${npm_cli[@]}" deprecate "$placeholder" "$DEPRECATION_MESSAGE"
  fi
done
