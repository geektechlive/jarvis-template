#!/usr/bin/env bash
# Mount the Synology NAS jarvis share via SMB.
# Uses a user-owned mount point (~/mnt/jarvis) so the LaunchAgent does not
# require root to create the directory.
set -euo pipefail

MOUNT_POINT="$HOME/mnt/jarvis"
NAS_HOST="<nas-ip>"
NAS_SHARE="jarvis"
NAS_USER="<username>"

# Already mounted — nothing to do
mount | grep -q "$MOUNT_POINT" && exit 0

mkdir -p "$MOUNT_POINT"

# Fetch password from Keychain (stored as internet-password for the NAS host)
NAS_PASS=$(security find-internet-password -s "$NAS_HOST" -a "$NAS_USER" -w 2>/dev/null) || {
  echo "mount-nas: no Keychain entry for $NAS_USER@$NAS_HOST" >&2
  exit 1
}

mount_smbfs "//${NAS_USER}:${NAS_PASS}@${NAS_HOST}/${NAS_SHARE}" "$MOUNT_POINT"
echo "mount-nas: mounted //${NAS_HOST}/${NAS_SHARE} at $MOUNT_POINT"
