#!/bin/sh
# getFirebaseFiles.sh — Firebase Storage sync for KoboCloud
# Called with: getFirebaseFiles.sh DEVICE_ID DEVICE_TOKEN
#
# Protocol:
#   1. GET Firestore queue: kobo_queue where deviceId==DEVICE_ID & status==pending
#   2. For each queued book, download EPUB from Firebase Storage using storagePath
#   3. PATCH each queue doc to status=delivered
#
# kobocloudrc entry format:  Firebase:DEVICE_ID:DEVICE_TOKEN

DEVICE_ID="$1"
DEVICE_TOKEN="$2"

# Load shared config (sets $CURL, $KC_HOME, $Library)
. "$(dirname "$0")/config.sh"

PROJECT="elibrary-c0074"
FIRESTORE_BASE="https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents"
STORAGE_BASE="https://firebasestorage.googleapis.com/v0/b/${PROJECT}.firebasestorage.app/o"

if [ -z "$DEVICE_ID" ] || [ -z "$DEVICE_TOKEN" ]; then
  echo "getFirebaseFiles: missing DEVICE_ID or DEVICE_TOKEN" >&2
  exit 1
fi

echo "getFirebaseFiles: checking queue for device $DEVICE_ID"

# ── STEP 1: Query Firestore for pending queue entries ─────────────────────────
# We use the Firestore REST runQuery endpoint with a structured query.
# Authentication: device token passed as a custom header checked by Firestore Rules.
# Rules allow read if request.auth == null AND resource.data.deviceToken == token.

QUERY_BODY="{
  \"structuredQuery\": {
    \"from\": [{\"collectionId\": \"kobo_queue\"}],
    \"where\": {
      \"compositeFilter\": {
        \"op\": \"AND\",
        \"filters\": [
          {
            \"fieldFilter\": {
              \"field\": {\"fieldPath\": \"deviceId\"},
              \"op\": \"EQUAL\",
              \"value\": {\"stringValue\": \"${DEVICE_ID}\"}
            }
          },
          {
            \"fieldFilter\": {
              \"field\": {\"fieldPath\": \"status\"},
              \"op\": \"EQUAL\",
              \"value\": {\"stringValue\": \"pending\"}
            }
          },
          {
            \"fieldFilter\": {
              \"field\": {\"fieldPath\": \"deviceToken\"},
              \"op\": \"EQUAL\",
              \"value\": {\"stringValue\": \"${DEVICE_TOKEN}\"}
            }
          }
        ]
      }
    },
    \"orderBy\": [{\"field\": {\"fieldPath\": \"queuedAt\"}, \"direction\": \"ASCENDING\"}]
  }
}"

QUERY_RESPONSE=$($CURL -k --silent -X POST \
  -H "Content-Type: application/json" \
  -d "$QUERY_BODY" \
  "${FIRESTORE_BASE}:runQuery")

# Check if we got any results — Firestore returns [{document: ...}, ...]
# A result with no documents looks like: [{}]
echo "$QUERY_RESPONSE" | grep -q '"name"' || {
  echo "getFirebaseFiles: no pending books in queue"
  exit 0
}

# ── STEP 2: Parse each document and download ──────────────────────────────────
# Firestore REST returns fields as {"fieldName": {"stringValue": "..."}}
# We extract: document name (for PATCH), title, storagePath, downloadToken
#
# Shell JSON parsing using grep/sed — no jq needed on Kobo.

echo "$QUERY_RESPONSE" | \
  grep -o '"name": *"[^"]*"' | \
  sed 's/"name": *"//;s/"//' | \
while read -r DOC_NAME; do

  # Extract the doc ID from the full path
  # path format: projects/P/databases/(default)/documents/kobo_queue/DOC_ID
  DOC_ID=$(echo "$DOC_NAME" | sed 's|.*/||')

  # Fetch the full document to get all fields reliably
  DOC=$($CURL -k --silent "${FIRESTORE_BASE}/kobo_queue/${DOC_ID}")

  # Extract fields
  TITLE=$(echo "$DOC" | grep -A1 '"title"' | grep 'stringValue' | sed 's/.*"stringValue": *"//;s/".*//')
  STORAGE_PATH=$(echo "$DOC" | grep -A1 '"storagePath"' | grep 'stringValue' | sed 's/.*"stringValue": *"//;s/".*//')
  FILENAME=$(echo "$DOC" | grep -A1 '"filename"' | grep 'stringValue' | sed 's/.*"stringValue": *"//;s/".*//')

  # Use title as fallback filename
  if [ -z "$FILENAME" ]; then
    FILENAME="${TITLE}.epub"
  fi

  # Sanitise filename — remove characters problematic on FAT32
  SAFE_FILENAME=$(echo "$FILENAME" | sed 's/[^A-Za-z0-9._\- ]//g')
  if [ -z "$SAFE_FILENAME" ]; then
    SAFE_FILENAME="${DOC_ID}.epub"
  fi

  DEST="${Library}/${SAFE_FILENAME}"

  # Skip if already downloaded
  if [ -f "$DEST" ]; then
    echo "getFirebaseFiles: already have '${SAFE_FILENAME}', marking delivered"
  else
    echo "getFirebaseFiles: downloading '${SAFE_FILENAME}'"

    # URL-encode the storage path (/ → %2F, spaces → %20)
    ENCODED_PATH=$(echo "$STORAGE_PATH" | sed 's|/|%2F|g;s| |%20|g')

    # Firebase Storage download URL with alt=media
    DOWNLOAD_URL="${STORAGE_BASE}/${ENCODED_PATH}?alt=media"

    HTTP_STATUS=$($CURL -k --silent --output "$DEST" \
      --write-out "%{http_code}" \
      "$DOWNLOAD_URL")

    if [ "$HTTP_STATUS" = "200" ]; then
      echo "getFirebaseFiles: downloaded '${SAFE_FILENAME}' OK"
    else
      echo "getFirebaseFiles: download failed (HTTP ${HTTP_STATUS}) for '${SAFE_FILENAME}'" >&2
      rm -f "$DEST"
      # Don't mark as delivered — leave for retry next sync
      continue
    fi
  fi

  # ── STEP 3: Mark as delivered in Firestore ─────────────────────────────────
  PATCH_BODY="{
    \"fields\": {
      \"status\": {\"stringValue\": \"delivered\"},
      \"deliveredAt\": {\"timestampValue\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}
    }
  }"

  $CURL -k --silent -X PATCH \
    -H "Content-Type: application/json" \
    -d "$PATCH_BODY" \
    "${FIRESTORE_BASE}/kobo_queue/${DOC_ID}?updateMask.fieldPaths=status&updateMask.fieldPaths=deliveredAt" \
    > /dev/null

  echo "getFirebaseFiles: marked '${SAFE_FILENAME}' as delivered"

done

echo "getFirebaseFiles: sync complete"
