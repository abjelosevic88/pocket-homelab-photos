.PHONY: web build test run
web:
	cd web && npm ci --no-audit --no-fund && npm run build
build:
	CGO_ENABLED=0 go build -trimpath -ldflags "-s -w -X main.version=0.1.0" -o pocket-photos ./cmd/pocket-photos
test:
	go vet ./...
	go test -race ./...
run: web build
	./pocket-photos
