#!/bin/sh
# getFirebaseFiles.sh — Firebase Storage sync for KoboCloud
# Downloads books to $Lib so get.sh's built-in change-detection
# and NickelDBus rescan trigger actually fire.

DEVICE_ID="$1"
DEVICE_TOKEN="$2"

. "$(dirname "$0")/config.sh"

PROJECT="elibrary-c0074"
FIRESTORE_BASE="https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents"

if [ -z "$DEVICE_ID" ] || [ -z "$DEVICE_TOKEN" ]; then
  echo "getFirebaseFiles: missing DEVICE_ID or DEVICE_TOKEN" >&2
  exit 1
fi

echo "getFirebaseFiles: checking queue for device $DEVICE_ID"

QUERY_BODY="{\"structuredQuery\":{\"from\":[{\"collectionId\":\"kobo_queue\"}],\"where\":{\"compositeFilter\":{\"op\":\"AND\",\"filters\":[{\"fieldFilter\":{\"field\":{\"fieldPath\":\"deviceId\"},\"op\":\"EQUAL\",\"value\":{\"stringValue\":\"${DEVICE_ID}\"}}},{\"fieldFilter\":{\"field\":{\"fieldPath\":\"status\"},\"op\":\"EQUAL\",\"value\":{\"stringValue\":\"pending\"}}},{\"fieldFilter\":{\"field\":{\"fieldPath\":\"deviceToken\"},\"op\":\"EQUAL\",\"value\":{\"stringValue\":\"${DEVICE_TOKEN}\"}}}]}}}}"

QUERY_RESPONSE=$($CURL -k --silent -X POST \
  -H "Content-Type: application/json" \
  -d "$QUERY_BODY" \
  "${FIRESTORE_BASE}:runQuery")

echo "getFirebaseFiles: raw response: $(echo "$QUERY_RESPONSE" | cut -c1-500)"

DOC_NAMES=$(echo "$QUERY_RESPONSE" | sed -n 's/.*"name": *"\([^"]*kobo_queue[^"]*\)".*/\1/p')
echo "getFirebaseFiles: doc names found: '$DOC_NAMES'"

if [ -z "$DOC_NAMES" ]; then
  echo "getFirebaseFiles: no pending books in queue"
  exit 0
fi

echo "$DOC_NAMES" | while read -r DOC_NAME; do
  [ -z "$DOC_NAME" ] && continue

  DOC_ID=$(echo "$DOC_NAME" | sed 's|.*/||')
  echo "getFirebaseFiles: processing document $DOC_ID"

  DOC=$($CURL -k --silent "${FIRESTORE_BASE}/kobo_queue/${DOC_ID}")

  TITLE=$(echo "$DOC" | sed -n '/"title"/{n;s/.*"stringValue": *"//;s/".*//;p;q}')
  FILENAME=$(echo "$DOC" | sed -n '/"filename"/{n;s/.*"stringValue": *"//;s/".*//;p;q}')
  DOWNLOAD_URL=$(echo "$DOC" | sed -n '/"downloadUrl"/{n;s/.*"stringValue": *"//;s/".*//;p;q}')

  echo "getFirebaseFiles: title=$TITLE"
  echo "getFirebaseFiles: filename=$FILENAME"
  echo "getFirebaseFiles: downloadUrl=$DOWNLOAD_URL"

  if [ -z "$DOWNLOAD_URL" ]; then
    echo "getFirebaseFiles: no downloadUrl found, skipping" >&2
    continue
  fi

  if [ -z "$FILENAME" ]; then
    FILENAME="${TITLE}.epub"
  fi

  SAFE_FILENAME=$(echo "$FILENAME" | tr -dc 'A-Za-z0-9._- ')
  if [ -z "$SAFE_FILENAME" ]; then
    SAFE_FILENAME="${DOC_ID}.epub"
  fi

  # IMPORTANT: save into $Lib (not a custom folder) so get.sh's
  # before/after comparison detects the change and triggers a rescan
  DEST="${Lib}/${SAFE_FILENAME}"

  if [ -f "$DEST" ]; then
    echo "getFirebaseFiles: already have '${SAFE_FILENAME}'"
  else
    echo "getFirebaseFiles: downloading '${SAFE_FILENAME}'"

    HTTP_STATUS=$($CURL -k --silent --output "$DEST" \
      --write-out "%{http_code}" \
      "$DOWNLOAD_URL")

    echo "getFirebaseFiles: HTTP status=$HTTP_STATUS"

    if [ "$HTTP_STATUS" = "200" ]; then
      echo "getFirebaseFiles: downloaded '${SAFE_FILENAME}' OK"
    else
      echo "getFirebaseFiles: download failed (HTTP ${HTTP_STATUS})" >&2
      rm -f "$DEST"
      continue
    fi
  fi

  PATCH_BODY="{\"fields\":{\"status\":{\"stringValue\":\"delivered\"},\"deliveredAt\":{\"timestampValue\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}}}"

  PATCH_STATUS=$($CURL -k --silent -X PATCH \
    -H "Content-Type: application/json" \
    -d "$PATCH_BODY" \
    "${FIRESTORE_BASE}/kobo_queue/${DOC_ID}?updateMask.fieldPaths=status&updateMask.fieldPaths=deliveredAt" \
    --write-out "%{http_code}" \
    --output /dev/null)

  echo "getFirebaseFiles: marked delivered, patch status=$PATCH_STATUS"
done

echo "getFirebaseFiles: sync complete"
