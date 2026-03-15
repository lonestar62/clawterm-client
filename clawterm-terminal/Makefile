# ClawTerm Makefile
# ──────────────────────────────────────────────────────────
#  make build    — install deps and run via Node
#  make windows  — bundle + pkg → dist/clawterm.exe
#  make linux    — bundle + pkg → dist/clawterm-linux
#  make bundle   — esbuild bundle only (dist/bundle.cjs)
#  make install  — npm link (adds clawterm to PATH)
#  make clean    — remove dist/

.PHONY: build windows linux bundle install clean

build:
	npm install
	node src/cli.js

bundle:
	npm install
	npm run bundle

windows: bundle
	node_modules/.bin/pkg dist/bundle.cjs --targets node18-win-x64 --output dist/clawterm.exe
	@echo "Windows binary: dist/clawterm.exe"

linux: bundle
	node_modules/.bin/pkg dist/bundle.cjs --targets node18-linux-x64 --output dist/clawterm-linux
	@echo "Linux binary: dist/clawterm-linux"

all: bundle
	node_modules/.bin/pkg dist/bundle.cjs \
		--targets node18-win-x64,node18-linux-x64,node18-macos-x64 \
		--output dist/clawterm
	@echo "Binaries in dist/"

install:
	npm install
	npm link
	@echo "clawterm installed globally via npm link"

clean:
	rm -rf dist/
