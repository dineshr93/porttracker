# porttracker Makefile
#
#   make          clean build + run the container (default port 3000)
#   make run      clean build + run the container
#   make build    remove old image, then clean (no-cache) build
#   make clean    remove the old image and any stopped container
#   make stop     stop/remove the running container
#   make run PORT=9000   run on a different port
#   make run DATA_DIR=/custom   persist data somewhere else (default ~/.porttracker)

.PHONY: clean build run stop

IMAGE     := porttracker
CONTAINER := porttracker
PORT      ?= 3000
DATA_DIR  ?= $(HOME)/.porttracker
# Host IP as seen from inside the container. Auto-detect the docker0 bridge
# address; fall back to the classic 172.17.0.1 if detection fails.
SCAN_HOST ?= $(shell ip -o -4 addr show docker0 2>/dev/null | awk '{print $$4}' | cut -d/ -f1)
ifeq ($(SCAN_HOST),)
SCAN_HOST := 172.17.0.1
endif
# Path inside the container where the host data dir is mounted.
CONTAINER_DATA := /data

# Default target: remove old image, clean-build, then run.
run: build
	@docker run -d --name $(CONTAINER) \
		-p $(PORT):$(PORT) -e PORT=$(PORT) \
		-e PORTTRACKERDIR=$(CONTAINER_DATA) \
		-e SCAN_HOST=$(SCAN_HOST) \
		-v $(DATA_DIR):$(CONTAINER_DATA) \
		$(IMAGE)
	@echo "porttracker running on http://localhost:$(PORT)"
	@docker ps --filter name=$(CONTAINER) --format "  container: {{.Names}} ({{.Image}}), port $(PORT)"
	@echo "  data persisted to $(DATA_DIR) (mounted at $(CONTAINER_DATA))"

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
