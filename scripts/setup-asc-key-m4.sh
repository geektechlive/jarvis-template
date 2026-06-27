#!/usr/bin/env bash
# SCRIPT: setup-asc-key-m4.sh
# PURPOSE: One-time interactive setup for App Store Connect (TestFlight) API key.
#          Installs the .p8 private key to M4 and configures GitHub repo secrets.
# EXIT CODES: 0=success, 1=error

set -euo pipefail

M4_HOST="<m4-mini-ip>"
M4_USER="<username>"
M4_KEYDIR="/Users/<username>/.appstoreconnect/private_keys"

log() {
    printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"
}

error() {
    printf 'ERROR: %s\n' "$*" >&2
    exit 1
}

banner() {
    cat <<'EOF'
╔═══════════════════════════════════════════════════════════╗
║         App Store Connect API Key Setup                  ║
║                                                           ║
║ This script configures TestFlight upload credentials     ║
║ for the iOS build pipeline on the M4 runner.             ║
╚═══════════════════════════════════════════════════════════╝
EOF
}

prompt_for_credentials() {
    log "Gathering App Store Connect credentials..."
    echo ""

    # Prompt for .p8 file path
    read -p "Path to AuthKey .p8 file (e.g., ~/Downloads/AuthKey_ABCD123456.p8): " P8_PATH
    [ -n "$P8_PATH" ] || error "File path is required"

    # Expand ~ to home directory
    P8_PATH="${P8_PATH/#\~/$HOME}"

    # Validate file exists
    if [ ! -f "$P8_PATH" ]; then
        error "File not found: $P8_PATH"
    fi

    # Extract key ID from filename (AuthKey_ABCD123456.p8 → ABCD123456)
    P8_FILENAME=$(basename "$P8_PATH")
    KEY_ID="${P8_FILENAME#AuthKey_}"
    KEY_ID="${KEY_ID%.p8}"

    # Validate Key ID format (10 alphanumeric chars)
    if ! [[ "$KEY_ID" =~ ^[A-Z0-9]{10}$ ]]; then
        error "Invalid Key ID format. Expected 10 alphanumeric characters, got: $KEY_ID"
    fi

    echo ""
    read -p "Issuer ID (UUID, e.g., 12345678-1234-1234-1234-123456789012): " ISSUER_ID
    [ -n "$ISSUER_ID" ] || error "Issuer ID is required"

    # Validate Issuer ID format (UUID)
    if ! [[ "$ISSUER_ID" =~ ^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$ ]]; then
        error "Invalid Issuer ID format. Expected UUID, got: $ISSUER_ID"
    fi

    echo ""
}

install_key_to_m4() {
    local p8_path="$1"
    local key_id="$2"

    log "Installing .p8 key to M4..."

    # Create the directory on M4
    if ! ssh "$M4_USER@$M4_HOST" mkdir -p "$M4_KEYDIR" 2>/dev/null; then
        error "Failed to create key directory on M4. Ensure SSH access is available: ssh $M4_USER@$M4_HOST"
    fi

    # SCP the .p8 file to M4
    local dest_file="$M4_KEYDIR/AuthKey_${key_id}.p8"
    if ! scp "$p8_path" "$M4_USER@$M4_HOST:$dest_file" >/dev/null 2>&1; then
        error "Failed to copy .p8 to M4: scp $p8_path $M4_USER@$M4_HOST:$dest_file"
    fi

    log "Key installed to M4: $dest_file"

    # Set proper permissions on M4
    if ! ssh "$M4_USER@$M4_HOST" chmod 600 "$dest_file" 2>/dev/null; then
        error "Failed to chmod key on M4"
    fi

    log "Key permissions set to 600"
}

grant_keychain_access() {
    log "Granting codesign non-interactive keychain access on M4..."
    echo ""
    echo "This step requires the login keychain password (will prompt once on M4)."
    echo "If you are not at M4 physically or cannot provide the password now,"
    echo "you can run this command later on M4:"
    echo ""
    echo "  security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k \"\" /Users/<username>/Library/Keychains/login.keychain-db"
    echo ""
    read -p "Grant keychain access now? (y/n) " -r
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        log "Deferring keychain access grant. You can run it manually later."
        return 0
    fi

    # Run the security command via SSH (will prompt for keychain password)
    if ! ssh -t "$M4_USER@$M4_HOST" \
        "security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k '' /Users/<username>/Library/Keychains/login.keychain-db" 2>/dev/null; then
        error "Failed to grant keychain access. Run manually on M4 (see above)"
    fi

    log "Keychain access granted"
}

print_next_steps() {
    local key_id="$1"
    local issuer_id="$2"

    cat <<EOF

✓ App Store Connect API key installed on M4!

Next steps:
  1. Add GitHub repo secrets:
     - Go to https://github.com/<your-org>/jarvis/settings/secrets/actions
     - Add secret ASC_KEY_ID = $key_id
     - Add secret ASC_ISSUER_ID = $issuer_id

  2. Verify keychain access on M4:
     After commit and push, trigger: gh workflow run ios-testflight.yml

  3. Monitor build:
     Watch the Actions tab for the ios-testflight workflow

EOF
}

main() {
    banner
    echo ""

    prompt_for_credentials
    install_key_to_m4 "$P8_PATH" "$KEY_ID"
    grant_keychain_access
    print_next_steps "$KEY_ID" "$ISSUER_ID"
}

main "$@"
