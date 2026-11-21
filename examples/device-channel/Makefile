# Build and sideload the Device Channel (generic dev fixture). App-only: tests are excluded by bsconfig.json.
#   make build                      -> out/device-channel.zip (brighterscript from the repo's node_modules)
#   make deploy                     -> build + sideload (ROKU_HOST / ROKU_PASSWORD from the environment)
#   make launch [ARGS='crash=1']    -> launch the dev channel, optional launch args (query string)
#   make home
# Run device targets through the lease:  brighttest device with --purpose "..." -- make deploy
.DEFAULT_GOAL := build
BSC  := node ../../node_modules/.bin/bsc
ZIP  := out/device-channel.zip
CURL := curl --silent --show-error --connect-timeout 5

.PHONY: build deploy launch home check-host check-creds
build:
	@rm -rf out
	@$(BSC) --project bsconfig.json >/dev/null && echo "built $(ZIP)"

check-host:
	@test -n "$(ROKU_HOST)" || { echo "error: set ROKU_HOST"; exit 1; }
check-creds: check-host
	@test -n "$(ROKU_PASSWORD)" || { echo "error: set ROKU_PASSWORD"; exit 1; }

deploy: check-creds build
	@$(CURL) --digest -u "rokudev:$(ROKU_PASSWORD)" -F 'mysubmit=Replace' -F 'archive=@$(ZIP)' 'http://$(ROKU_HOST)/plugin_install' \
	  | grep -oE 'Install Success|Identical to previous|Application Received|Failed[^<]*' | head -1

launch: check-host
	@$(CURL) -d '' 'http://$(ROKU_HOST):8060/launch/dev?$(ARGS)' >/dev/null && echo "launched"

home: check-host
	@$(CURL) -d '' 'http://$(ROKU_HOST):8060/keypress/Home' >/dev/null && echo "home"
