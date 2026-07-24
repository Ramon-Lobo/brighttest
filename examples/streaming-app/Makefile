# Makefile — sideload the Open Cinema sample channel to a Roku in developer mode.
# APP-ONLY build: source/tests/** and .bs specs are excluded (they need Rooibos, won't compile on-device).
#
# Usage:
#   make deploy ROKU=192.168.1.50 PASSWORD=abcd     # zip + sideload
#   make launch ROKU=192.168.1.50                   # launch the dev channel
# Config: put ROKU/PASSWORD in a .env next to this Makefile (auto-loaded, gitignored).
# The device must be in developer mode with Network access = Permissive.

.DEFAULT_GOAL := deploy
-include .env

APPNAME := open-cinema
OUT     := out
ZIP     := $(OUT)/$(APPNAME).zip

ROKU     ?= $(or $(ROKU_HOST),$(ROKU_DEV_TARGET))
PASSWORD ?= $(or $(ROKU_PASSWORD),$(DEV_PASSWORD))
USERPASS := rokudev:$(PASSWORD)
DEV      := http://$(ROKU)
ECP      := http://$(ROKU):8060

# Channel contents (images + data ship alongside manifest/source/components).
SRC         := manifest source components images data
ZIP_EXCLUDE := -x 'source/tests/*' -x '*.spec.bs' -x '*.bs' -x '*/.*' -x '.*'

CURL     := curl --silent --show-error --connect-timeout 5
CURL_DEV := $(CURL) --digest -u '$(USERPASS)'

.PHONY: deploy replace install delete zip launch home check-host check-creds

check-host:
	@test -n "$(ROKU)"     || { echo "error: no device IP — pass ROKU=<ip> or set ROKU_HOST"; exit 1; }
check-creds: check-host
	@test -n "$(PASSWORD)" || { echo "error: no dev password — pass PASSWORD=<devpw> or set ROKU_PASSWORD"; exit 1; }

zip:
	@mkdir -p $(OUT)
	@rm -f $(ZIP)
	@zip -r -q $(ZIP) $(SRC) $(ZIP_EXCLUDE)
	@echo "packaged $(ZIP) ($$(unzip -l $(ZIP) | tail -1 | awk '{print $$2}') files)"

deploy replace: check-creds zip
	@echo "deploying $(APPNAME) → $(ROKU) ..."
	@$(CURL_DEV) -F 'mysubmit=Replace' -F 'archive=@$(ZIP)' '$(DEV)/plugin_install' \
	  | grep -oE 'Install Success|Identical to previous|Application Received|Failed[^<]*|error[^<]*' | head -1 \
	  || echo "(no status text returned — check the device screen)"
	@echo "launch it: make launch ROKU=$(ROKU)"

install: check-creds zip
	@$(CURL_DEV) -F 'mysubmit=Install' -F 'archive=@$(ZIP)' '$(DEV)/plugin_install' \
	  | grep -oE 'Install Success|Identical to previous|Application Received|Failed[^<]*|error[^<]*' | head -1

delete: check-creds
	@$(CURL_DEV) -F 'mysubmit=Delete' -F 'archive=' '$(DEV)/plugin_install' >/dev/null && echo "deleted."

launch: check-host
	@$(CURL) -d '' '$(ECP)/launch/dev' >/dev/null && echo "launched dev channel on $(ROKU)"

home: check-host
	@$(CURL) -d '' '$(ECP)/keypress/Home' >/dev/null && echo "Home pressed on $(ROKU)"
