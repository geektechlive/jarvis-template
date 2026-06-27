.PHONY: lint test check hooks install setup deploy-ion deploy-ion-go deploy-ion-local deploy-ts-local deploy-agents-local deploy-scripts-local deploy-ion-rollback ion-logs ion-status install-watchdog watchdog-logs watchdog-status deploy-jarvis-notify deploy-discord-bot discord-bot-status discord-bot-logs deploy-nas-mount nas-mount-status deploy-vec deploy-vec-local vec-logs vec-status deploy-apple-foundation apple-foundation-status apple-foundation-logs deploy-desktop deploy-ios deploy-relay relay-logs relay-status m4-status deploy-jarvis install-launchagents deploy-ingest-mini deploy-imessage imessage-status install-runner-m4 runner-m4-status runner-m4-logs doctor recover deploy-jarvis-recover-doctor deploy-approval-script deploy-log-patrol log-patrol-status log-patrol-logs deploy-m4-scripts testflight-status sync-sdk deploy-observability

# M2 Mini (<mac-mini-ip>) — engine box: ion, Ollama, vec-server
MINI_HOST ?= mini
MINI_DIR  ?= ~/Jarvis

# M4 Mini (<m4-mini-ip>) — client box: Ion Desktop, relay
M4_HOST   ?= mini-m4

# --- dev ---

setup:
	git submodule update --init --recursive
	git -C ion remote add upstream https://github.com/dsswift/ion.git 2>/dev/null || true

install:
	uv sync --all-groups

lint:
	uv run ruff check harness/ tools-py/ scripts/ tests/
	uv run pyright harness/ tools-py/
	cd harness-ts && npm run lint
	cd harness-ts && npm run typecheck

# Install the local git hooks (pre-push runs `make check`). Run once per clone.
hooks:
	git config core.hooksPath .githooks
	@echo "git hooks installed: core.hooksPath -> .githooks (pre-push runs make check)"

test:
	uv run pytest tests/ -v
	cd harness-ts && npm test

check: lint test
	@bash scripts/validate-staff.sh

# --- ion LaunchAgent ---

#sync-claude-rules:
#	rsync -av --delete ~/.claude/rules/ $(MINI_HOST):~/.claude/rules/
#	rsync -av ~/.claude/CLAUDE.md $(MINI_HOST):~/.claude/CLAUDE.md

# deploy-jarvis: identity files, staff specs, scripts, TS extension -- the normal deploy for Jarvis changes
deploy-jarvis: deploy-jarvis-notify deploy-jarvis-recover-doctor deploy-discord-bot
	git push origin main
	@relay_key=$$(ssh $(MINI_HOST) 'grep ^RELAY_API_KEY ~/.jarvis-relay.env | cut -d= -f2') && \
	[ -n "$$relay_key" ] || { echo 'ERROR: RELAY_API_KEY not found on $(MINI_HOST)' >&2; exit 1; } && \
	imessage_token=$$(ssh $(MINI_HOST) 'grep ^IMESSAGE_WEBHOOK_TOKEN ~/.jarvis-relay.env | cut -d= -f2') && \
	[ -n "$$imessage_token" ] || { echo 'ERROR: IMESSAGE_WEBHOOK_TOKEN not found in ~/.jarvis-relay.env on $(MINI_HOST)' >&2; exit 1; } && \
	openrouter_key=$$(ssh $(MINI_HOST) 'grep ^OPENROUTER_API_KEY ~/.jarvis-relay.env | cut -d= -f2') && \
	[ -n "$$openrouter_key" ] || { echo 'ERROR: OPENROUTER_API_KEY not found in ~/.jarvis-relay.env on $(MINI_HOST)' >&2; exit 1; } && \
	ssh $(MINI_HOST) "cd $(MINI_DIR) && \
		git stash && git pull --ff-only && { git stash pop 2>/dev/null || true; } && \
		chmod +x scripts/ion-serve.sh scripts/mail-check.py scripts/files-check.py scripts/calendar-check.py scripts/calendar-write.py scripts/calendar-delete.py scripts/calendar-update.py scripts/find-file.sh scripts/browser-fetch && \
		cp -f scripts/mail-check.py ~/bin/mail-check && \
		cp -f scripts/files-check.py ~/bin/files-check && \
		cp -f scripts/calendar-check.py ~/bin/calendar-check && \
		cp -f scripts/calendar-write.py ~/bin/calendar-write && \
		cp -f scripts/calendar-delete.py ~/bin/calendar-delete && \
		cp -f scripts/calendar-update.py ~/bin/calendar-update && \
		cp -f scripts/find-file.sh ~/bin/find-file && \
		cp -f scripts/browser-fetch ~/bin/browser-fetch && \
		cp -f scripts/health-probe.py ~/bin/health-probe && \
		cp -f scripts/error-rate.py ~/bin/error-rate && \
		chmod +x ~/bin/browser-fetch ~/bin/health-probe ~/bin/error-rate && \
		export PATH=/opt/homebrew/bin:\$$PATH && \
		npm ci --prefix harness-ts && \
		PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci --prefix tools-js/browser --silent && \
		mkdir -p harness-ts/dist && \
		~/bin/esbuild harness-ts/src/extension.ts --bundle --platform=node --target=node20 --outfile=harness-ts/dist/extension.js --external:better-sqlite3 && \
		~/bin/esbuild harness-ts/src/child-extension.ts --bundle --platform=node --target=node20 --outfile=harness-ts/dist/child-extension/index.js --external:better-sqlite3 && \
		rm -rf harness-ts/dist/agents && mkdir -p harness-ts/dist/agents && \
		cp -R harness/agents/. harness-ts/dist/agents/ && \
		mkdir -p ~/.claude/agents && \
		cp -R harness/agents/. ~/.claude/agents/ && \
		cp -f harness/workers/*.md ~/.claude/agents/ && \
		sed 's|RELAY_API_KEY_PLACEHOLDER|$$relay_key|;s|IMESSAGE_WEBHOOK_TOKEN_PLACEHOLDER|$$imessage_token|;s|OPENROUTER_API_KEY_PLACEHOLDER|$$openrouter_key|' com.dsswift.ion.plist > ~/Library/LaunchAgents/com.dsswift.ion.plist && \
		{ launchctl bootout gui/$$(id -u) ~/Library/LaunchAgents/com.dsswift.ion.plist 2>/dev/null || true; } && \
		{ until ! launchctl list 2>/dev/null | grep -q com.dsswift.ion; do sleep 0.5; done; } && \
		{ pkill -9 -f 'ion serve' 2>/dev/null || true; sleep 0.5; lsof -ti :21017 2>/dev/null | xargs kill -9 2>/dev/null || true; sleep 1; } && \
		launchctl bootstrap gui/$$(id -u) ~/Library/LaunchAgents/com.dsswift.ion.plist && \
		launchctl kickstart -k gui/$$(id -u)/com.dsswift.ion"

# deploy-ion: rebuilds the ion Go binary -- only needed when ion/engine/ source changes
deploy-ion:
	git push origin main
	@relay_key=$$(ssh $(MINI_HOST) 'grep ^RELAY_API_KEY ~/.jarvis-relay.env | cut -d= -f2') && \
	[ -n "$$relay_key" ] || { echo 'ERROR: RELAY_API_KEY not found on $(MINI_HOST)' >&2; exit 1; } && \
	imessage_token=$$(ssh $(MINI_HOST) 'grep ^IMESSAGE_WEBHOOK_TOKEN ~/.jarvis-relay.env | cut -d= -f2') && \
	[ -n "$$imessage_token" ] || { echo 'ERROR: IMESSAGE_WEBHOOK_TOKEN not found in ~/.jarvis-relay.env on $(MINI_HOST)' >&2; exit 1; } && \
	openrouter_key=$$(ssh $(MINI_HOST) 'grep ^OPENROUTER_API_KEY ~/.jarvis-relay.env | cut -d= -f2') && \
	[ -n "$$openrouter_key" ] || { echo 'ERROR: OPENROUTER_API_KEY not found in ~/.jarvis-relay.env on $(MINI_HOST)' >&2; exit 1; } && \
	ssh $(MINI_HOST) "cd $(MINI_DIR) && \
		git stash && \
		git pull && \
		git submodule update --init --recursive && \
		{ git stash pop 2>/dev/null || true ; } && \
		chmod +x scripts/ion-serve.sh scripts/mail-check.py scripts/files-check.py scripts/calendar-check.py scripts/calendar-write.py scripts/calendar-delete.py scripts/calendar-update.py scripts/find-file.sh scripts/browser-fetch && \
		cp -f scripts/mail-check.py ~/bin/mail-check && \
		cp -f scripts/files-check.py ~/bin/files-check && \
		cp -f scripts/calendar-check.py ~/bin/calendar-check && \
		cp -f scripts/calendar-write.py ~/bin/calendar-write && \
		cp -f scripts/calendar-delete.py ~/bin/calendar-delete && \
		cp -f scripts/calendar-update.py ~/bin/calendar-update && \
		cp -f scripts/find-file.sh ~/bin/find-file && \
		cp -f scripts/browser-fetch ~/bin/browser-fetch && \
		chmod +x ~/bin/mail-check ~/bin/files-check ~/bin/calendar-check ~/bin/calendar-write ~/bin/calendar-delete ~/bin/calendar-update ~/bin/find-file ~/bin/browser-fetch && \
		export PATH=/opt/homebrew/bin:\$$PATH && \
		cd $(MINI_DIR)/ion && make engine && \
		cd $(MINI_DIR) && \
		npm ci --prefix harness-ts && \
		PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci --prefix tools-js/browser --silent && \
		mkdir -p harness-ts/dist && \
		~/bin/esbuild harness-ts/src/extension.ts --bundle --platform=node --target=node20 --outfile=harness-ts/dist/extension.js --external:better-sqlite3 && \
		~/bin/esbuild harness-ts/src/child-extension.ts --bundle --platform=node --target=node20 --outfile=harness-ts/dist/child-extension/index.js --external:better-sqlite3 && \
		rm -rf harness-ts/dist/agents && mkdir -p harness-ts/dist/agents && \
		cp -R harness/agents/. harness-ts/dist/agents/ && \
		mkdir -p ~/.claude/agents && \
		cp -R harness/agents/. ~/.claude/agents/ && \
		cp -f harness/workers/*.md ~/.claude/agents/ && \
		sed 's|RELAY_API_KEY_PLACEHOLDER|$$relay_key|;s|IMESSAGE_WEBHOOK_TOKEN_PLACEHOLDER|$$imessage_token|;s|OPENROUTER_API_KEY_PLACEHOLDER|$$openrouter_key|' com.dsswift.ion.plist > ~/Library/LaunchAgents/com.dsswift.ion.plist && \
		{ launchctl bootout gui/$$(id -u) ~/Library/LaunchAgents/com.dsswift.ion.plist 2>/dev/null || true ; } && \
		{ until ! launchctl list 2>/dev/null | grep -q com.dsswift.ion; do sleep 0.5; done ; } && \
		{ pkill -f 'ion serve' 2>/dev/null || true ; sleep 1 ; } && \
		launchctl bootstrap gui/$$(id -u) ~/Library/LaunchAgents/com.dsswift.ion.plist && \
		launchctl kickstart -k gui/$$(id -u)/com.dsswift.ion"

deploy-ion-go:
	ssh $(MINI_HOST) "cd $(MINI_DIR)/ion && export PATH=/opt/homebrew/bin:\$$PATH && make engine"

# Build and restart ion locally (no SSH). Run from ~/Jarvis on the Mini,
# or from the GitHub Actions self-hosted runner working directory after merging.
deploy-ion-local:
	export PATH=/opt/homebrew/bin:$$PATH && \
	(cd ion && make engine) && \
	npm ci --prefix harness-ts && \
	PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci --prefix tools-js/browser --silent && \
	mkdir -p harness-ts/dist && \
	~/bin/esbuild harness-ts/src/extension.ts --bundle --platform=node --target=node20 --outfile=harness-ts/dist/extension.js --external:better-sqlite3 && \
	~/bin/esbuild harness-ts/src/child-extension.ts --bundle --platform=node --target=node20 --outfile=harness-ts/dist/child-extension/index.js --external:better-sqlite3 && \
	rm -rf harness-ts/dist/agents && mkdir -p harness-ts/dist/agents && \
	cp -R harness/agents/. harness-ts/dist/agents/ && \
	mkdir -p ~/.claude/agents && \
	cp -R harness/agents/. ~/.claude/agents/ && \
	cp -f harness/workers/*.md ~/.claude/agents/ && \
	RELAY_KEY=$$(grep ^RELAY_API_KEY ~/.jarvis-relay.env 2>/dev/null | cut -d= -f2) && \
	[ -n "$$RELAY_KEY" ] || { echo 'ERROR: RELAY_API_KEY not found in ~/.jarvis-relay.env' >&2; exit 1; } && \
	IMESSAGE_TOKEN=$$(grep ^IMESSAGE_WEBHOOK_TOKEN ~/.jarvis-relay.env 2>/dev/null | cut -d= -f2) && \
	[ -n "$$IMESSAGE_TOKEN" ] || { echo 'ERROR: IMESSAGE_WEBHOOK_TOKEN not found in ~/.jarvis-relay.env' >&2; exit 1; } && \
	OPENROUTER_KEY=$$(grep ^OPENROUTER_API_KEY ~/.jarvis-relay.env 2>/dev/null | cut -d= -f2) && \
	[ -n "$$OPENROUTER_KEY" ] || { echo 'ERROR: OPENROUTER_API_KEY not found in ~/.jarvis-relay.env' >&2; exit 1; } && \
	sed "s|RELAY_API_KEY_PLACEHOLDER|$$RELAY_KEY|;s|IMESSAGE_WEBHOOK_TOKEN_PLACEHOLDER|$$IMESSAGE_TOKEN|;s|OPENROUTER_API_KEY_PLACEHOLDER|$$OPENROUTER_KEY|" com.dsswift.ion.plist > ~/Library/LaunchAgents/com.dsswift.ion.plist && \
	{ launchctl bootout gui/$$(id -u) ~/Library/LaunchAgents/com.dsswift.ion.plist 2>/dev/null || true ; } && \
	{ until ! launchctl list 2>/dev/null | grep -q com.dsswift.ion; do sleep 0.5; done ; } && \
	{ pkill -f 'ion serve' 2>/dev/null || true ; sleep 1 ; } && \
	launchctl bootstrap gui/$$(id -u) ~/Library/LaunchAgents/com.dsswift.ion.plist && \
	launchctl kickstart -k gui/$$(id -u)/com.dsswift.ion

# Rebuild TS extension only + copy agents + restart ion. No Go rebuild.
# Use when harness-ts/ or harness/config/ changed but ion/engine/ did not.
deploy-ts-local:
	export PATH=/opt/homebrew/bin:$$PATH && \
	npm ci --prefix harness-ts && \
	mkdir -p harness-ts/dist && \
	~/bin/esbuild harness-ts/src/extension.ts --bundle --platform=node --target=node20 --outfile=harness-ts/dist/extension.js --external:better-sqlite3 && \
	~/bin/esbuild harness-ts/src/child-extension.ts --bundle --platform=node --target=node20 --outfile=harness-ts/dist/child-extension/index.js --external:better-sqlite3 && \
	rm -rf harness-ts/dist/agents && mkdir -p harness-ts/dist/agents && \
	cp -R harness/agents/. harness-ts/dist/agents/ && \
	mkdir -p ~/.claude/agents && \
	cp -R harness/agents/. ~/.claude/agents/ && \
	cp -f harness/workers/*.md ~/.claude/agents/ && \
	RELAY_KEY=$$(grep ^RELAY_API_KEY ~/.jarvis-relay.env 2>/dev/null | cut -d= -f2) && \
	[ -n "$$RELAY_KEY" ] || { echo 'ERROR: RELAY_API_KEY not found in ~/.jarvis-relay.env' >&2; exit 1; } && \
	IMESSAGE_TOKEN=$$(grep ^IMESSAGE_WEBHOOK_TOKEN ~/.jarvis-relay.env 2>/dev/null | cut -d= -f2) && \
	[ -n "$$IMESSAGE_TOKEN" ] || { echo 'ERROR: IMESSAGE_WEBHOOK_TOKEN not found in ~/.jarvis-relay.env' >&2; exit 1; } && \
	OPENROUTER_KEY=$$(grep ^OPENROUTER_API_KEY ~/.jarvis-relay.env 2>/dev/null | cut -d= -f2) && \
	[ -n "$$OPENROUTER_KEY" ] || { echo 'ERROR: OPENROUTER_API_KEY not found in ~/.jarvis-relay.env' >&2; exit 1; } && \
	sed "s|RELAY_API_KEY_PLACEHOLDER|$$RELAY_KEY|;s|IMESSAGE_WEBHOOK_TOKEN_PLACEHOLDER|$$IMESSAGE_TOKEN|;s|OPENROUTER_API_KEY_PLACEHOLDER|$$OPENROUTER_KEY|" com.dsswift.ion.plist > ~/Library/LaunchAgents/com.dsswift.ion.plist && \
	{ launchctl bootout gui/$$(id -u) ~/Library/LaunchAgents/com.dsswift.ion.plist 2>/dev/null || true ; } && \
	{ until ! launchctl list 2>/dev/null | grep -q com.dsswift.ion; do sleep 0.5; done ; } && \
	{ pkill -f 'ion serve' 2>/dev/null || true ; sleep 1 ; } && \
	launchctl bootstrap gui/$$(id -u) ~/Library/LaunchAgents/com.dsswift.ion.plist && \
	launchctl kickstart -k gui/$$(id -u)/com.dsswift.ion

# Copy agent specs and worker specs to ~/.claude/agents/. No rebuild or restart.
# Identity files hot-reload on mtime change; agent specs are read by Claude Code on-demand.
deploy-agents-local:
	mkdir -p ~/.claude/agents && \
	cp -R harness/agents/. ~/.claude/agents/ && \
	cp -f harness/workers/*.md ~/.claude/agents/

# Copy tool scripts to ~/bin. No restart.
deploy-scripts-local:
	cp -f scripts/mail-check.py ~/bin/mail-check && \
	cp -f scripts/files-check.py ~/bin/files-check && \
	cp -f scripts/calendar-check.py ~/bin/calendar-check && \
	cp -f scripts/calendar-write.py ~/bin/calendar-write && \
	cp -f scripts/calendar-delete.py ~/bin/calendar-delete && \
	cp -f scripts/calendar-update.py ~/bin/calendar-update && \
	cp -f scripts/find-file.sh ~/bin/find-file && \
	cp -f scripts/browser-fetch ~/bin/browser-fetch && \
	install -m 755 scripts/jarvis-doctor.sh ~/bin/jarvis-doctor && \
	install -m 755 scripts/jarvis-recover.sh ~/bin/jarvis-recover && \
	PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci --prefix tools-js/browser --silent && \
	chmod +x ~/bin/mail-check ~/bin/files-check ~/bin/calendar-check ~/bin/calendar-write ~/bin/calendar-delete ~/bin/calendar-update ~/bin/find-file ~/bin/browser-fetch && \
	chmod +x scripts/log-patrol.py

# Revert the most recent auto-approved merge and re-deploy the previous version.
deploy-ion-rollback:
	git revert HEAD --no-edit
	git push origin main
	$(MAKE) deploy-ion-local

ion-logs:
	ssh $(MINI_HOST) "tail -f $(MINI_DIR)/logs/ion.error.log"

ion-status:
	ssh $(MINI_HOST) "launchctl list | grep dsswift.ion; ~/.ion/bin/ion status 2>/dev/null || echo '(daemon not running)'"

# --- deploy watchdog (auto-deploy on commit) ---

install-watchdog:
	git push origin main
	ssh $(MINI_HOST) "cd $(MINI_DIR) && git pull --quiet && \
		chmod +x scripts/deploy-watchdog.sh && \
		cp com.example.jarvis.deploy-watchdog.plist ~/Library/LaunchAgents/ && \
		{ launchctl bootout gui/$$(id -u) ~/Library/LaunchAgents/com.example.jarvis.deploy-watchdog.plist 2>/dev/null || true; } && \
		launchctl bootstrap gui/$$(id -u) ~/Library/LaunchAgents/com.example.jarvis.deploy-watchdog.plist && \
		git rev-parse HEAD > ~/.jarvis-deployed-sha && \
		echo 'watchdog installed, SHA seeded:' && cat ~/.jarvis-deployed-sha"

watchdog-logs:
	ssh $(MINI_HOST) "tail -50 $(MINI_DIR)/logs/deploy-watchdog.log"

watchdog-status:
	ssh $(MINI_HOST) "launchctl list | grep deploy-watchdog; echo '---'; cat ~/.jarvis-deployed-sha 2>/dev/null && echo '(deployed SHA)' || echo '(no deployed SHA yet)'"

# Deploy Discord notifier script to ~/bin/jarvis-notify
deploy-jarvis-notify:
	ssh $(MINI_HOST) "cd $(MINI_DIR) && git stash && git pull --quiet && { git stash pop 2>/dev/null || true; } && \
		install -m 755 scripts/jarvis-notify.sh ~/bin/jarvis-notify && \
		~/bin/jarvis-notify --help 2>&1 | head -3"

# --- Discord bot (long-running process) ---

deploy-discord-bot:
	git push origin main
	ssh $(MINI_HOST) "cd $(MINI_DIR) && \
		git stash && \
		git pull && \
		{ git stash pop 2>/dev/null || true ; } && \
		chmod +x scripts/setup-discord-bot.sh && \
		export PATH=/opt/homebrew/bin:\$$PATH && \
		npm ci --prefix harness-ts && \
		npm rebuild better-sqlite3 --prefix harness-ts && \
		npm run build:discord-bot --prefix harness-ts && \
		cp com.example.jarvis.discord-bot.plist ~/Library/LaunchAgents/ && \
		{ launchctl bootout gui/$$(id -u) ~/Library/LaunchAgents/com.example.jarvis.discord-bot.plist 2>/dev/null || true; } && \
		{ until ! launchctl list 2>/dev/null | grep -q discord-bot; do sleep 0.5; done; } && \
		launchctl bootstrap gui/$$(id -u) ~/Library/LaunchAgents/com.example.jarvis.discord-bot.plist && \
		launchctl print gui/$$(id -u)/com.example.jarvis.discord-bot | grep -E 'state|pid' || echo '(launch status unknown)'"

deploy-nas-mount:
	git push origin main
	ssh $(MINI_HOST) "cd $(MINI_DIR) && \
		git stash && \
		git pull && \
		{ git stash pop 2>/dev/null || true; } && \
		chmod +x scripts/mount-nas.sh && \
		cp com.example.jarvis.nas-mount.plist ~/Library/LaunchAgents/ && \
		{ launchctl bootout gui/$$(id -u) ~/Library/LaunchAgents/com.example.jarvis.nas-mount.plist 2>/dev/null || true; } && \
		launchctl bootstrap gui/$$(id -u) ~/Library/LaunchAgents/com.example.jarvis.nas-mount.plist && \
		launchctl kickstart gui/$$(id -u)/com.example.jarvis.nas-mount && \
		echo 'NAS mount LaunchAgent loaded and started'"

nas-mount-status:
	ssh $(MINI_HOST) "launchctl list | grep nas-mount; echo '---'; tail -20 $(MINI_DIR)/logs/nas-mount.log 2>/dev/null || echo '(no log yet)'"

discord-bot-status:
	ssh $(MINI_HOST) "launchctl list | grep discord-bot; echo '---'; launchctl print gui/$$(id -u)/com.example.jarvis.discord-bot 2>&1 | head -30 || echo '(not loaded)'"

discord-bot-logs:
	ssh $(MINI_HOST) "tail -50 $(MINI_DIR)/logs/discord-bot.error.log; echo '---stdout---'; tail -50 $(MINI_DIR)/logs/discord-bot.out.log"

deploy-approval-script:
	scp scripts/jarvis-create-approval.js $(MINI_HOST):~/bin/jarvis-create-approval
	ssh $(MINI_HOST) "chmod +x ~/bin/jarvis-create-approval"
	@echo "Deployed jarvis-create-approval to $(MINI_HOST):~/bin/"

# --- vec tool server (port 9876) ---

deploy-vec:
	git push origin main
	ssh $(MINI_HOST) "cd $(MINI_DIR) && \
		git stash && \
		git pull && \
		{ git stash pop 2>/dev/null || true ; } && \
		/opt/homebrew/bin/uv sync --extra graph && \
		cp com.example.tools-py-vector.plist ~/Library/LaunchAgents/com.example.tools-py-vector.plist && \
		{ launchctl bootout gui/$$(id -u) ~/Library/LaunchAgents/com.example.tools-py-vector.plist 2>/dev/null || true ; } && \
		{ until ! launchctl list 2>/dev/null | grep -q tools-py-vector; do sleep 0.5; done ; } && \
		launchctl bootstrap gui/$$(id -u) ~/Library/LaunchAgents/com.example.tools-py-vector.plist"

# Restart vec-server LaunchAgent locally. No git pull (watchdog already did it).
# Use when tools-py/ or harness/memory/ or harness/consolidation.py changed.
deploy-vec-local:
	{ launchctl bootout gui/$$(id -u) ~/Library/LaunchAgents/com.example.tools-py-vector.plist 2>/dev/null || true ; } && \
	{ until ! launchctl list 2>/dev/null | grep -q tools-py-vector; do sleep 0.5; done ; } && \
	launchctl bootstrap gui/$$(id -u) ~/Library/LaunchAgents/com.example.tools-py-vector.plist

vec-logs:
	ssh $(MINI_HOST) "tail -f $(MINI_DIR)/logs/vector.error.log"

vec-status:
	ssh $(MINI_HOST) "launchctl list | grep tools-py-vector; curl -s http://127.0.0.1:9876/health 2>/dev/null || echo '(server not responding)'"

# --- apple-foundation (on-device Apple Foundation Models, issue #775) ---
# Builds the Swift `afm` binary ON the Mini (FoundationModels only links on
# macOS 26), then installs/restarts the Python HTTP front. No secrets needed.
deploy-apple-foundation:
	git push origin main
	ssh $(MINI_HOST) "cd $(MINI_DIR) && \
		git stash && \
		git pull && \
		{ git stash pop 2>/dev/null || true ; } && \
		( cd tools-py/apple-foundation && /usr/bin/swift build -c release ) && \
		cp com.example.tools-py-apple-foundation.plist ~/Library/LaunchAgents/com.example.tools-py-apple-foundation.plist && \
		{ launchctl bootout gui/$$(id -u) ~/Library/LaunchAgents/com.example.tools-py-apple-foundation.plist 2>/dev/null || true ; } && \
		{ until ! launchctl list 2>/dev/null | grep -q tools-py-apple-foundation; do sleep 0.5; done ; } && \
		launchctl bootstrap gui/$$(id -u) ~/Library/LaunchAgents/com.example.tools-py-apple-foundation.plist"

apple-foundation-status:
	ssh $(MINI_HOST) "launchctl list | grep tools-py-apple-foundation; curl -s http://127.0.0.1:9878/health 2>/dev/null || echo '(server not responding)'"

apple-foundation-logs:
	ssh $(MINI_HOST) "tail -n 60 $(MINI_DIR)/logs/apple-foundation.error.log $(MINI_DIR)/logs/apple-foundation.afm.log"

# --- M4 Mini (client box) ---

deploy-desktop:
	@echo "Deploying $(shell stat -f '%Sm' /Applications/Jarvis.app/Contents/MacOS/Jarvis 2>/dev/null || echo '(unknown build date)') build to $(M4_HOST)"
	@echo "NOTE: Run 'cd ion/desktop && bash commands/install-bg.command' first to rebuild if needed."
	ssh $(M4_HOST) "rm -rf /Applications/Jarvis.app"
	scp -r /Applications/Jarvis.app $(M4_HOST):/Applications/Jarvis.app
	@echo "Deployed. On M4: quit and relaunch Jarvis — accept the Local Network Access prompt if it appears."

# iOS TestFlight deploy is handled by the GitHub Actions self-hosted runner on M4.
# Push ion/ios changes to main and the ios-testflight.yml workflow fires automatically.
# Check status: gh run list --repo <your-org>/jarvis --workflow ios-testflight.yml
deploy-ios:
	@echo "iOS deploys run via GitHub Actions (ios-testflight.yml) on the M4 self-hosted runner."
	@echo "Push your ion/ios changes to main — the workflow triggers automatically."
	@echo "Check: gh run list --repo <your-org>/jarvis --workflow ios-testflight.yml"

# Deploy scripts that run on M4 (ASC private key lives there, not M2).
deploy-m4-scripts:
	git push origin main
	scp scripts/testflight-status.py $(M4_HOST):~/bin/testflight-status
	ssh $(M4_HOST) "chmod +x ~/bin/testflight-status && pip3 install --quiet pyjwt cryptography"
	@echo "testflight-status deployed to $(M4_HOST):~/bin/"

testflight-status:
	ssh $(M4_HOST) "~/bin/testflight-status"

deploy-relay:
	(cd ion/relay && GOOS=darwin GOARCH=arm64 go build -o /tmp/ion-relay .) && \
	scp /tmp/ion-relay $(MINI_HOST):~/bin/ion-relay && \
	ssh $(MINI_HOST) "codesign --force --sign - ~/bin/ion-relay" && \
	RELAY_KEY=$$(ssh $(MINI_HOST) 'grep ^RELAY_API_KEY ~/.jarvis-relay.env 2>/dev/null | cut -d= -f2') && \
	[ -n "$$RELAY_KEY" ] || { echo "ERROR: RELAY_API_KEY not found in ~/.jarvis-relay.env on $(MINI_HOST)" >&2; exit 1; } && \
	sed "s/RELAY_API_KEY_PLACEHOLDER/$$RELAY_KEY/" com.example.ion-relay.plist > /tmp/ion-relay-live.plist && \
	scp /tmp/ion-relay-live.plist $(MINI_HOST):~/Library/LaunchAgents/com.example.ion-relay.plist && \
	scp com.example.cloudflared.plist $(MINI_HOST):~/Library/LaunchAgents/com.example.cloudflared.plist && \
	ssh $(MINI_HOST) "mkdir -p ~/bin && \
		{ launchctl bootout gui/$$(id -u) ~/Library/LaunchAgents/com.example.ion-relay.plist 2>/dev/null || true; } && \
		{ until ! launchctl list 2>/dev/null | grep -q com.example.ion-relay; do sleep 0.5; done; } && \
		launchctl bootstrap gui/$$(id -u) ~/Library/LaunchAgents/com.example.ion-relay.plist && \
		echo 'relay: deployed and started'"

relay-logs:
	ssh $(MINI_HOST) "tail -50 ~/Library/Logs/ion-relay.log ~/Library/Logs/ion-relay.error.log 2>/dev/null || echo '(no relay logs yet)'"

relay-status:
	ssh $(MINI_HOST) "launchctl list | grep -E 'ion-relay|cloudflared' || echo '(relay daemons not registered)'; echo '---'; curl -s http://localhost:8443/healthz 2>/dev/null || echo '(relay not responding on :8443)'"

m4-status:
	@echo "=== M2 (engine/daemons) ===" && ssh $(MINI_HOST) "launchctl list | grep -E 'dsswift.ion|<username>' || echo '(no ion daemons registered)'"
	@echo "=== M4 (desktop) ===" && ssh $(M4_HOST) "pgrep -la Jarvis || echo 'Ion Desktop not running'"

# --- M4 GitHub Actions self-hosted runner ---

install-runner-m4:
	git push origin main
	bash scripts/setup-github-runner-m4.sh

runner-m4-status:
	ssh $(M4_HOST) "launchctl list | grep actions.runner; echo '---'; ls -la ~/actions-runner/_diag/ 2>/dev/null | tail -5"

runner-m4-logs:
	ssh $(M4_HOST) "find ~/actions-runner/_diag -name 'Runner_*.log' -mtime -1 -exec tail -50 {} \;"

# --- dev-machine LaunchAgents (run locally, not on Mini) ---

install-launchagents:
	bash scripts/install-launchagents.sh

# --- Mini-side claude-code-ingest LaunchAgent ---

deploy-ingest-mini:
	git push origin main
	ssh $(MINI_HOST) "git -C ~/Jarvis pull && \
		cp ~/Jarvis/scripts/com.example.claude-code-ingest-mini.plist ~/Library/LaunchAgents/ && \
		{ launchctl bootout gui/$$(id -u) ~/Library/LaunchAgents/com.example.claude-code-ingest-mini.plist 2>/dev/null || true; } && \
		launchctl bootstrap gui/$$(id -u) ~/Library/LaunchAgents/com.example.claude-code-ingest-mini.plist && \
		launchctl list | grep claude-code-ingest-mini"

# --- iMessage monitoring (Mini) ---
# MANUAL STEP before running deploy-imessage:
#   System Settings > Privacy & Security > Full Disk Access > add /usr/bin/sqlite3
#   This grants chat.db access to the watcher script (persists across reboots).
#
# Also set IMESSAGE_WEBHOOK_TOKEN env var in the Jarvis launchd plist or add it
# to the imessage plist EnvironmentVariables dict.
deploy-imessage:
	git push origin main
	ssh $(MINI_HOST) "git -C ~/Jarvis pull && \
		mkdir -p ~/Jarvis/logs && \
		cp ~/Jarvis/scripts/com.example.jarvis.imessage.plist ~/Library/LaunchAgents/ && \
		{ launchctl bootout gui/$$(id -u) ~/Library/LaunchAgents/com.example.jarvis.imessage.plist 2>/dev/null || true; } && \
		launchctl bootstrap gui/$$(id -u) ~/Library/LaunchAgents/com.example.jarvis.imessage.plist && \
		echo 'imessage watcher loaded:' && launchctl list | grep jarvis.imessage || echo '(not found)'"

imessage-status:
	ssh $(MINI_HOST) "echo '=== launchd ===' && launchctl list | grep jarvis.imessage || echo '(not loaded)'; \
		echo '=== cursor ===' && cat ~/.jarvis/imessage_cursor_rowid 2>/dev/null || echo '0 (no cursor yet)'; \
		echo '=== recent log ===' && tail -20 ~/Jarvis/logs/imessage.log 2>/dev/null || echo '(no log yet)'; \
		echo '=== errors ===' && tail -10 ~/Jarvis/logs/imessage.error.log 2>/dev/null || echo '(no errors)'"

# --- Log patrol (error detection + GitHub issues + Discord) ---

deploy-log-patrol:
	git push origin main
	scp scripts/com.example.jarvis.log-patrol.plist $(MINI_HOST):~/Library/LaunchAgents/com.example.jarvis.log-patrol.plist
	scp scripts/log-patrol.py $(MINI_HOST):$(MINI_DIR)/scripts/log-patrol.py
	ssh $(MINI_HOST) "mkdir -p ~/Jarvis/logs && \
		chmod +x $(MINI_DIR)/scripts/log-patrol.py && \
		{ launchctl unload ~/Library/LaunchAgents/com.example.jarvis.log-patrol.plist 2>/dev/null || true; } && \
		launchctl load ~/Library/LaunchAgents/com.example.jarvis.log-patrol.plist && \
		echo 'log-patrol loaded:' && launchctl list | grep jarvis.log-patrol || echo '(not found)'"

log-patrol-status:
	ssh $(MINI_HOST) "echo '=== launchd ===' && launchctl list | grep jarvis.log-patrol || echo '(not loaded)'; \
		echo '=== state ===' && cat ~/.jarvis-log-patrol-state.json 2>/dev/null | python3 -m json.tool 2>/dev/null || echo '(no state yet)'; \
		echo '=== recent out ===' && tail -20 ~/Jarvis/logs/log-patrol.out.log 2>/dev/null || echo '(no log yet)'; \
		echo '=== errors ===' && tail -10 ~/Jarvis/logs/log-patrol.error.log 2>/dev/null || echo '(no errors)'"

log-patrol-logs:
	ssh $(MINI_HOST) "tail -50 $(MINI_DIR)/logs/log-patrol.out.log; echo '---stderr---'; tail -20 $(MINI_DIR)/logs/log-patrol.error.log"

# --- Recovery and diagnostics ---

# Read-only audit of all Jarvis services on M2. Safe to run anytime.
doctor:
	ssh $(MINI_HOST) "~/bin/jarvis-doctor"

# Full idempotent service reset. Kills orphans, re-bootstraps in dependency order.
recover:
	ssh $(MINI_HOST) "~/bin/jarvis-recover"

# Copy jarvis-doctor and jarvis-recover to ~/bin on M2 and chmod +x.
deploy-jarvis-recover-doctor:
	ssh $(MINI_HOST) "cd $(MINI_DIR) && git stash && git pull --quiet && { git stash pop 2>/dev/null || true; } && \
		install -m 755 scripts/jarvis-doctor.sh ~/bin/jarvis-doctor && \
		install -m 755 scripts/jarvis-recover.sh ~/bin/jarvis-recover && \
		echo 'jarvis-doctor and jarvis-recover installed'"

# Re-sync harness-ts/vendor/ion-sdk/ from the canonical SDK in the ion submodule.
# After running, review the runtime-log.ts import in runtime-agents.ts (vendored SDK
# has no separate runtime-log.ts; change to: import { log } from './runtime').
sync-sdk:
	cp -f ion/engine/extensions/sdk/ion-sdk/*.ts harness-ts/vendor/ion-sdk/
	@echo "Vendor SDK synced from canonical. Review runtime-log.ts import in runtime-agents.ts."

# --- observability stack (Grafana + Loki + Alloy + health-probe) ---
#
# PREREQUISITES — run once by hand on the Mini before this target:
#   brew install grafana loki grafana-alloy
#   grafana-cli plugins install frser-sqlite-datasource
#   grafana-cli plugins install yesoreyeram-infinity-datasource
#
# Loki listens on :3100, Grafana on :3000, Alloy on :12345 (internal).
# Confirm :3000 is free first: ssh mini 'lsof -i :3000'
# After install, set the Grafana admin password and disable anonymous access.
#
# Rollback: ssh mini 'launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.example.loki.plist;
#   launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.example.alloy.plist;
#   launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.example.grafana.plist;
#   launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.example.jarvis.health-probe.plist'
deploy-observability:
	git push origin main
	ssh $(MINI_HOST) "cd $(MINI_DIR) && \
		git stash && git pull --ff-only && { git stash pop 2>/dev/null || true; } && \
		mkdir -p $(MINI_DIR)/infra && \
		mkdir -p $(MINI_DIR)/infra/observability && \
		cp -f scripts/health-probe.py ~/bin/health-probe && \
		cp -f scripts/error-rate.py ~/bin/error-rate && \
		chmod +x ~/bin/health-probe ~/bin/error-rate && \
		/opt/homebrew/bin/python3 -m venv $(MINI_DIR)/.venvs/probe && \
		$(MINI_DIR)/.venvs/probe/bin/pip install --quiet --upgrade pip && \
		$(MINI_DIR)/.venvs/probe/bin/pip install --quiet 'psutil>=6,<7'"
	scp -r infra/observability $(MINI_HOST):$(MINI_DIR)/infra/
	scp com.example.loki.plist $(MINI_HOST):~/Library/LaunchAgents/com.example.loki.plist
	scp com.example.alloy.plist $(MINI_HOST):~/Library/LaunchAgents/com.example.alloy.plist
	scp com.example.grafana.plist $(MINI_HOST):~/Library/LaunchAgents/com.example.grafana.plist
	scp com.example.jarvis.health-probe.plist $(MINI_HOST):~/Library/LaunchAgents/com.example.jarvis.health-probe.plist
	ssh $(MINI_HOST) " \
		{ launchctl bootout gui/$$(id -u) ~/Library/LaunchAgents/com.example.loki.plist 2>/dev/null || true; } && \
		{ launchctl bootout gui/$$(id -u) ~/Library/LaunchAgents/com.example.alloy.plist 2>/dev/null || true; } && \
		{ launchctl bootout gui/$$(id -u) ~/Library/LaunchAgents/com.example.grafana.plist 2>/dev/null || true; } && \
		{ launchctl bootout gui/$$(id -u) ~/Library/LaunchAgents/com.example.jarvis.health-probe.plist 2>/dev/null || true; } && \
		launchctl bootstrap gui/$$(id -u) ~/Library/LaunchAgents/com.example.loki.plist && \
		launchctl bootstrap gui/$$(id -u) ~/Library/LaunchAgents/com.example.alloy.plist && \
		launchctl bootstrap gui/$$(id -u) ~/Library/LaunchAgents/com.example.grafana.plist && \
		launchctl bootstrap gui/$$(id -u) ~/Library/LaunchAgents/com.example.jarvis.health-probe.plist && \
		launchctl kickstart -k gui/$$(id -u)/com.example.loki && \
		launchctl kickstart -k gui/$$(id -u)/com.example.alloy && \
		launchctl kickstart -k gui/$$(id -u)/com.example.grafana && \
		launchctl kickstart -k gui/$$(id -u)/com.example.jarvis.health-probe && \
		echo 'observability stack loaded' && \
		launchctl list | grep -E '<username>\.(loki|alloy|grafana|jarvis\.health-probe)' || echo '(check launchctl list manually)'"
