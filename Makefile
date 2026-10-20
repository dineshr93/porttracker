# porttracker Makefile
#
#   make          clean build + run the container (default port 3000)
#   make run      clean build + run the container
#   make build    remove old image, then clean (no-cache) build
#   make clean    remove the old image and any stopped container
#   make stop     stop/remove the running container
#   make verify   health-check + API smoke test against the running container
#   make run PORT=9000   run on a different port
#   make run DATA_DIR=/custom   persist data somewhere else (default ~/.porttracker)

.PHONY: clean build run stop verify

IMAGE     := porttracker
CONTAINER := porttracker
PORT      ?= 3000
DATA_DIR  ?= $(HOME)/.porttracker
RESTART   ?= unless-stopped
# Host IP as seen from inside the container. Auto-detect the docker0 bridge
# address; fall back to the classic 172.17.0.1 if detection fails.
SCAN_HOST ?= $(shell ip -o -4 addr show docker0 2>/dev/null | awk '{print $$4}' | cut -d/ -f1)
ifeq ($(SCAN_HOST),)
SCAN_HOST := 172.17.0.1
endif
# Path inside the container where the host data dir is mounted.
CONTAINER_DATA := /data

# Container hardening applied to every run: restart on failure/reboot,
# no privilege escalation, no Linux capabilities, an init process that
# forwards SIGTERM to node, and a read-only rootfs (only the mounted data dir
# is writable, with /tmp on tmpfs for anything that needs scratch space).
HARDEN := --restart $(RESTART) \
	--security-opt no-new-privileges \
	--cap-drop ALL \
	--init \
	--read-only \
	--tmpfs /tmp:rw,noexec,nosuid,size=32m

# Default target: remove old image, clean-build, then run.
run: build
	@docker run -d --name $(CONTAINER) $(HARDEN) \
		-p $(PORT):$(PORT) -e PORT=$(PORT) \
		-e PORTTRACKERDIR=$(CONTAINER_DATA) \
		-e SCAN_HOST=$(SCAN_HOST) \
		-v $(DATA_DIR):$(CONTAINER_DATA) \
		$(IMAGE)
	@echo "porttracker running on http://localhost:$(PORT)"
	@docker ps --filter name=$(CONTAINER) --format "  container: {{.Names}} ({{.Image}}), port $(PORT)"
	@echo "  data persisted to $(DATA_DIR) (mounted at $(CONTAINER_DATA))"
	@echo "  restart policy: $(RESTART)"
	@$(MAKE) --no-print-directory verify

# Remove old image (and any container from it) so each build starts fresh.
build: clean
	@docker build --no-cache -t $(IMAGE) .
	@echo "built image $(IMAGE)"

clean:
	@docker rm -f $(CONTAINER) 2>/dev/null || true
	@docker rm -f $$(docker ps -aq --filter ancestor=$(IMAGE)) 2>/dev/null || true
	@docker rmi -f $(IMAGE) 2>/dev/null || true
	@echo "removed old image $(IMAGE)"

stop:
	@docker rm -f $(CONTAINER) 2>/dev/null || true
	@echo "stopped $(CONTAINER)"

# Post-deploy gate: wait for Docker's healthcheck to report healthy, then run
# an in-container API smoke test (health + list + a create/update/delete cycle
# on a throwaway port) so a broken deploy fails loudly here, not in the UI.
verify:
	@status=unknown; \
	for i in $$(seq 1 40); do \
		status=$$(docker inspect -f '{{.State.Health.Status}}' $(CONTAINER) 2>/dev/null || echo missing); \
		[ "$$status" = healthy ] && break; \
		sleep 1; \
	done; \
	echo "  health: $$status"; \
	[ "$$status" = healthy ] || { docker logs --tail 40 $(CONTAINER); exit 1; }
	@docker exec $(CONTAINER) node /app/smoke.js
	@echo "  verify: PASS"
