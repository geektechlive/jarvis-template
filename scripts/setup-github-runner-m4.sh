#!/usr/bin/env bash
# SCRIPT: setup-github-runner-m4.sh
# PURPOSE: One-time interactive setup for GitHub Actions self-hosted runner on M4 Mac mini.
#          Installs the official GitHub runner, registers it, and configures as a LaunchAgent.
# EXIT CODES: 0=success, 1=error

set -euo pipefail

RUNNER_VERSION="2.328.0"
M4_HOST="mini-m4"
M4_USER="<username>"
RUNNER_DIR="~/actions-runner"
HOSTNAME=$(hostname -s 2>/dev/null || uname -n | cut -d. -f1)

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
║    GitHub Actions Runner Setup (M4 Mac mini)            ║
║                                                           ║
║ This script installs the GitHub Actions self-hosted      ║
║ runner on M4 (<m4-mini-ip>) and configures it as a    ║
║ LaunchAgent for native macOS CI/CD builds.              ║
╚═══════════════════════════════════════════════════════════╝
EOF
}

check_on_dev_mac() {
    # Warn if not on dev mac, but allow continuing
    if [ "$HOSTNAME" == "mini" ] || [ "$HOSTNAME" == "m4mini" ]; then
        error "This script must run on your dev Mac (not on the Mini itself). Detected: $HOSTNAME"
    fi

    if [ "$HOSTNAME" != "office-mac" ] && [ "$HOSTNAME" != "Office-Mac" ]; then
        log "WARN: Not running on 'office-mac' (detected: $HOSTNAME)"
        log "WARN: This script should run on your dev Mac and SSH to M4 for setup."
        log "WARN: Proceeding anyway — verify SSH connectivity to $M4_HOST first."
        echo ""
        read -p "Continue? (y/n) " -r
        [[ $REPLY =~ ^[Yy]$ ]] || error "Setup cancelled"
    fi
}

test_ssh_connectivity() {
    log "Testing SSH connectivity to $M4_HOST..."
    if ! ssh -o ConnectTimeout=5 "$M4_HOST" "echo 'SSH OK'" >/dev/null 2>&1; then
        error "Cannot SSH to $M4_HOST. Verify SSH alias is configured and host is online."
    fi
    log "SSH connectivity verified."
}

prompt_for_token() {
    cat <<'EOF'

=== GitHub Runner Token ===

To register the runner, you need a registration token.
Follow these steps to get it:

  1. Visit: https://github.com/<your-org>/jarvis/settings/actions/runners/new
  2. Choose: macOS arm64
  3. Copy the token from the config command (line starting with --token)
     It looks like: A1B2C3D4E5F6G7H8I9J0K1L2M3N4O5P6Q7R8S9

Token expires in about 1 hour — if you take longer, revisit the page for a new one.

EOF

    read -p "Paste the registration token: " -rs TOKEN
    [ -n "$TOKEN" ] || error "Token is required"
    echo ""
}

check_prior_runner() {
    log "Checking for prior runner installation on $M4_HOST..."

    local prior_exists=0
    if ssh "$M4_HOST" "[ -f ~/actions-runner/svc.sh ]" 2>/dev/null; then
        prior_exists=1
    fi

    if [ $prior_exists -eq 1 ]; then
        log "WARN: Prior runner installation detected on $M4_HOST"
        log "WARN: Manual cleanup required:"
        log "      ssh $M4_HOST"
        log "      cd ~/actions-runner"
        log "      ./svc.sh stop   # if running"
        log "      ./svc.sh uninstall"
        log "      cd ~"
        log "      rm -rf ~/actions-runner"
        log "      Then re-run this script."
        error "Prior runner must be manually removed first"
    fi

    log "No prior runner detected."
}

install_on_m4() {
    local token="$1"

    log "Installing runner v$RUNNER_VERSION on $M4_HOST..."

    ssh "$M4_HOST" <<EOF
set -euo pipefail

log() {
    printf '[%s] %s\n' "\$(date '+%Y-%m-%d %H:%M:%S')" "\$*"
}

error() {
    printf 'ERROR: %s\n' "\$*" >&2
    exit 1
}

log "Creating runner directory..."
mkdir -p ~/actions-runner
cd ~/actions-runner

log "Downloading GitHub Actions runner v$RUNNER_VERSION..."
if ! curl -sL -o actions-runner-osx-arm64-${RUNNER_VERSION}.tar.gz \
    "https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/actions-runner-osx-arm64-${RUNNER_VERSION}.tar.gz"; then
    error "Failed to download runner. Verify version $RUNNER_VERSION exists at https://github.com/actions/runner/releases"
fi

log "Extracting runner..."
tar xzf ./actions-runner-osx-arm64-${RUNNER_VERSION}.tar.gz
rm -f actions-runner-osx-arm64-${RUNNER_VERSION}.tar.gz

log "Running config.sh (unattended mode)..."
./config.sh \
    --url https://github.com/<your-org>/jarvis \
    --token "$token" \
    --name m4-mini-builder \
    --labels self-hosted,macos,arm64,m4 \
    --work _work \
    --unattended \
    --replace

log "Installing LaunchAgent..."
./svc.sh install

log "Starting runner..."
./svc.sh start

log "Runner installation complete!"
EOF
}

verify_runner_on_m4() {
    log "Verifying runner on $M4_HOST..."

    local status
    if ! status=$(ssh "$M4_HOST" "launchctl list 2>/dev/null | grep -i actions.runner" 2>/dev/null); then
        error "Runner LaunchAgent not found. Check logs with: make runner-m4-logs"
    fi

    log "Runner LaunchAgent registered:"
    echo "$status"

    log "Waiting for runner to report as Idle on GitHub..."
    log "(Check: https://github.com/<your-org>/jarvis/settings/actions/runners)"
}

print_next_steps() {
    cat <<EOF

✓ GitHub Actions runner installed on M4!

Runner details:
  - Name: m4-mini-builder
  - Labels: self-hosted,macos,arm64,m4
  - LaunchAgent: com.github.actions.runner.m4-mini-builder
  - Location: ~/actions-runner on $M4_HOST

Next steps:
  1. Visit: https://github.com/<your-org>/jarvis/settings/actions/runners
     Verify the runner shows as Idle (may take 30-60 seconds to appear)

  2. Test with:
     git push origin ci/hello-m4-test
     (This will trigger .github/workflows/hello-m4.yml)

  3. Check logs with:
     make runner-m4-logs
     make runner-m4-status

EOF
}

main() {
    banner
    echo ""
    check_on_dev_mac
    test_ssh_connectivity
    prompt_for_token
    check_prior_runner
    install_on_m4 "$TOKEN"
    verify_runner_on_m4
    print_next_steps
}

main "$@"
