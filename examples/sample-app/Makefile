# Makefile — sideload the brighttest sample app to a Roku in developer mode.
#
# Mirrors the standard Roku deploy flow: zip the channel (manifest + source + components) and POST it to
# the device's /plugin_install endpoint over HTTP Digest as `rokudev`. This is an APP-ONLY build —
# source/tests/** and the .bs specs are excluded (they need Rooibos and won't compile on-device).
#
# Usage:
#   make                                            # default: zip + deploy to the device
#   make deploy ROKU=192.168.1.50 PASSWORD=abcd     # same, overriding host/creds inline
#   make launch                                     # start the sideloaded channel over ECP
#   make delete                                     # remove the dev channel
#   make home                                       # press Home
#   make zip                                        # just build out/sample-app.zip
#
# Config: put ROKU/PASSWORD in a .env file next to this Makefile (auto-loaded, gitignored):
#   ROKU=192.168.1.50
#   PASSWORD=abcd
# Precedence: inline make var (ROKU= / PASSWORD=) > .env / shell env. The env var names
# ROKU_HOST/ROKU_DEV_TARGET and ROKU_PASSWORD/DEV_PASSWORD are also accepted.
# The device must be in developer mode with Network access = Permissive.

# Default target: deploy to the device.
.DEFAULT_GOAL := deploy

# Auto-load a local .env (KEY=value lines) if present. Missing file is fine (-include).
-include .env

APPNAME := sample-app
OUT     := out
ZIP     := $(OUT)/$(APPNAME).zip

# Device + credentials (accept the common env var names other Roku Makefiles use).
ROKU     ?= $(or $(ROKU_HOST),$(ROKU_DEV_TARGET))
PASSWORD ?= $(or $(ROKU_PASSWORD),$(DEV_PASSWORD))
USERPASS := rokudev:$(PASSWORD)
DEV      := http://$(ROKU)
ECP      := http://$(ROKU):8060

# Channel contents and what to leave out of the zip.
SRC         := manifest source components
ZIP_EXCLUDE := -x 'source/tests/*' -x '*.spec.bs' -x '*.bs' -x '*/.*' -x '.*'

CURL      := curl --silent --show-error --connect-timeout 5
CURL_DEV  := $(CURL) --digest -u '$(USERPASS)'

.PHONY: help deploy replace install delete zip launch home screenshot check-host check-creds

help:
	@echo "brighttest sample app — Roku deploy"
	@echo ""
	@echo "  make            zip + sideload to the device (default)"
	@echo "  make deploy     same (replace current channel)"
	@echo "  make install    sideload as a fresh install"
	@echo "  make delete     remove the dev channel"
	@echo "  make launch     launch the dev channel (ECP)"
	@echo "  make home       press Home (ECP)"
	@echo "  make zip        build $(ZIP) only"
	@echo ""
	@echo "  config: .env (ROKU=<ip>, PASSWORD=<devpw>) — see .env.example. Override inline with"
	@echo "          make deploy ROKU=<ip> PASSWORD=<devpw>. Current: ROKU=$(ROKU) PASSWORD=$(if $(PASSWORD),set,unset)"

check-host:
	@test -n "$(ROKU)"     || { echo "error: no device IP — add 'ROKU=<ip>' to .env or pass ROKU=<ip>"; exit 1; }
check-creds: check-host
	@test -n "$(PASSWORD)" || { echo "error: no dev password — add 'PASSWORD=<devpw>' to .env or pass PASSWORD=<devpw>"; exit 1; }

# Always rebuild the zip from the current source tree — never risk sideloading a stale artifact.
zip:
	@mkdir -p $(OUT)
	@rm -f $(ZIP)
	@zip -r -q $(ZIP) $(SRC) $(ZIP_EXCLUDE)
	@echo "packaged $(ZIP) ($$(unzip -l $(ZIP) | tail -1 | awk '{print $$2}') files)"

# Replace = install-or-replace the current dev channel (idempotent; the usual deploy).
deploy replace: check-creds zip
	@echo "deploying $(APPNAME) → $(ROKU) ..."
	@$(CURL_DEV) -F 'mysubmit=Replace' -F 'archive=@$(ZIP)' '$(DEV)/plugin_install' \
	  | grep -oE 'Install Success|Identical to previous|Application Received|Failed[^<]*|error[^<]*' | head -1 \
	  || echo "(no status text returned — check the device screen)"
	@echo "launch it: make launch ROKU=$(ROKU)"

install: check-creds zip
	@echo "installing $(APPNAME) → $(ROKU) ..."
	@$(CURL_DEV) -F 'mysubmit=Install' -F 'archive=@$(ZIP)' '$(DEV)/plugin_install' \
	  | grep -oE 'Install Success|Identical to previous|Application Received|Failed[^<]*|error[^<]*' | head -1 \
	  || echo "(no status text returned — check the device screen)"

delete: check-creds
	@echo "deleting dev channel on $(ROKU) ..."
	@$(CURL_DEV) -F 'mysubmit=Delete' -F 'archive=' '$(DEV)/plugin_install' >/dev/null
	@echo "deleted."

launch: check-host
	@$(CURL) -d '' '$(ECP)/launch/dev' >/dev/null && echo "launched dev channel on $(ROKU)"

home: check-host
	@$(CURL) -d '' '$(ECP)/keypress/Home' >/dev/null && echo "Home pressed on $(ROKU)"

# Grab a dev screenshot to out/screenshot.jpg (channel must be sideloaded + running).
screenshot: check-creds
	@mkdir -p $(OUT)
	@$(CURL_DEV) -F 'mysubmit=Screenshot' -F 'archive=' '$(DEV)/plugin_inspect' >/dev/null
	@$(CURL_DEV) '$(DEV)/pkgs/dev.jpg' -o $(OUT)/screenshot.jpg && echo "saved $(OUT)/screenshot.jpg"
