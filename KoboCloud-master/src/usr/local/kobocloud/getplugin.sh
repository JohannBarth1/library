#!/bin/sh
# getplugin.sh — KoboCloud main dispatcher (Firebase fork)
#
# Original KoboCloud by fsantini (MIT licence)
# Firebase support added as a drop-in extension.
#
# Reads kobocloudrc line by line. Recognises these prefixes:
#   https://drive.google.com/...   → getGoogleDriveList.sh
#   https://www.dropbox.com/sh/... → getDropboxFiles.sh
#   DropboxApp:...                 → getDropboxAppFiles.sh
#   https://*.../public.php/...    → getOwncloudList.sh  (Nextcloud)
#   https://app.box.com/...        → getBoxList.sh
#   https://u.pcloud.link/...      → getPcloudList.sh
#   Firebase:DEVICE_ID:TOKEN       → getFirebaseFiles.sh  ← NEW
#
# All other lines starting with # are comments; UNINSTALL / REMOVE_DELETED
# are handled before this script is called by the parent run script.

# Load shared config
. "$(dirname "$0")/config.sh"

Plugin="$(dirname "$0")"

processUrl() {
  url="$1"

  case "$url" in

    # ── Firebase (custom) ────────────────────────────────────────────────────
    Firebase:*)
      # Format: Firebase:DEVICE_ID:DEVICE_TOKEN
      # Strip the Firebase: prefix
      rest="${url#Firebase:}"
      DEVICE_ID="${rest%%:*}"
      DEVICE_TOKEN="${rest#*:}"

      if [ -z "$DEVICE_ID" ] || [ -z "$DEVICE_TOKEN" ] || [ "$DEVICE_ID" = "$DEVICE_TOKEN" ]; then
        echo "Invalid Firebase entry — expected Firebase:DEVICE_ID:DEVICE_TOKEN" >&2
        return 1
      fi

      echo "Reading Firebase queue for device ${DEVICE_ID}"
      "$Plugin/getFirebaseFiles.sh" "$DEVICE_ID" "$DEVICE_TOKEN"
      ;;

    # ── Google Drive ─────────────────────────────────────────────────────────
    https://drive.google.com/*)
      echo "Reading Google Drive $url"
      fileList=$("$Plugin/getGoogleDriveList.sh" "$url") || return 1
      getFiles "$fileList" "$url"
      ;;

    # ── Dropbox (public share link) ──────────────────────────────────────────
    https://www.dropbox.com/sh/*)
      echo "Reading Dropbox $url"
      fileList=$("$Plugin/getDropboxFiles.sh" "$url") || return 1
      getFiles "$fileList" "$url"
      ;;

    # ── Dropbox (app OAuth token) ─────────────────────────────────────────────
    DropboxApp:*)
      echo "Reading Dropbox App $url"
      fileList=$("$Plugin/getDropboxAppFiles.sh" "$url") || return 1
      getFiles "$fileList" "$url"
      ;;

    # ── Nextcloud / Owncloud ─────────────────────────────────────────────────
    https://*/public.php/*)
      # Extract user token and server from share URL
      user=$(echo "$url" | sed 's|https://[^/]*/index.php/s/\([^/]*\).*|\1|')
      davServer=$(echo "$url" | sed 's|\(https://[^/]*\).*|\1|')
      echo "Reading Nextcloud $davServer"
      fileList=$("$Plugin/getOwncloudList.sh" "$user" "$davServer") || return 1
      getFiles "$fileList" "$davServer/public.php/webdav"
      ;;

    # ── Box ──────────────────────────────────────────────────────────────────
    https://app.box.com/*|https://*.box.com/*)
      echo "Reading Box $url"
      fileList=$("$Plugin/getBoxList.sh" "$url") || return 1
      getFiles "$fileList" "$url"
      ;;

    # ── pCloud ───────────────────────────────────────────────────────────────
    https://u.pcloud.link/*|https://filedn.com/*)
      echo "Reading pCloud $url"
      fileList=$("$Plugin/getPcloudList.sh" "$url") || return 1
      getFiles "$fileList" "$url"
      ;;

    # ── Unknown ──────────────────────────────────────────────────────────────
    *)
      echo "Unknown URL type, skipping: $url" >&2
      ;;
  esac
}

# getFiles downloads each filename from a base URL
# (used by Dropbox/Drive/Box/pCloud/Nextcloud — not Firebase, which handles its own downloads)
getFiles() {
  fileList="$1"
  baseUrl="$2"

  echo "$fileList" | while read -r fileUrl; do
    [ -z "$fileUrl" ] && continue
    filename=$(basename "$fileUrl")
    dest="${Library}/${filename}"

    if [ -f "$dest" ]; then
      echo "Already have $filename, skipping"
      continue
    fi

    echo "Getting $fileUrl"
    HTTP_STATUS=$($CURL --silent --output "$dest" \
      --write-out "%{http_code}" \
      "$fileUrl")

    if [ "$HTTP_STATUS" != "200" ]; then
      echo "Failed to download $filename (HTTP $HTTP_STATUS)" >&2
      rm -f "$dest"
    fi
  done
}

# ── Main: read kobocloudrc and process each line ───────────────────────────────
while IFS= read -r line || [ -n "$line" ]; do
  # Skip blank lines and comments
  case "$line" in
    ''|\#*) continue ;;
    REMOVE_DELETED|UNINSTALL) continue ;; # handled by parent
  esac

  processUrl "$line"

done < "$UserConfig"
