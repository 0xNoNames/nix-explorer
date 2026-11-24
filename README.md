# nix-explorer

A static, offline-friendly explorer for **NixOS**, **home-manager** and **nix-darwin** module options.

Browse every option as a tree (`nixos/services/nginx/…`), fuzzy-search across ~33k options, read the rendered docs, and jump straight to the declaration in the bundled Nix source, across every NixOS channel, including unmaintained ones.

> **Note:** this website is vibecoded with a human reviewing and steering.

## Features

- **All three module systems**: NixOS, home-manager and nix-darwin, for each channel (unstable plus every primary release).
- **Self-contained**: no request leaves the site. JS is vendored, sources are bundled and there are no external links, so it runs in air-gapped or isolated environments.
- **Tree + fuzzy search** with readable, shareable URLs, e.g. `?nixos-26.05#nixos:services.nginx.virtualHosts.<name>.forceSSL`.
- **Rendered docs**: the nixpkgs Markdown dialect, with `{option}` cross-links and Nix syntax highlighting.
- **Jump to source**: opens the declaring file at the option's line range, following imports for submodule options.
- **No JS build step**: everything is built with a Nix flake. The only third-party JS is a pinned `marked`. HTML, JS, CSS and SVG are minified at build time with `minify` from nixpkgs.

## Usage

```sh
nix build .#site         # static site in ./result, deployable as-is
nix run .#update-channels  # re-pin channels into channels.json
node --test tests/lib.test.mjs  # unit tests (or: nix develop)
```

The flake only sees git-tracked files, so run `git add -N` on new files before building.

When self-hosting `./result`, enable compression (e.g. nginx `gzip on;` with `application/json` in `gzip_types`): the NixOS options file alone is ~11 MB raw and ~1.6 MB gzipped. GitHub Pages already compresses.

## How it works

Option data comes from the upstream documentation derivations (`optionsJSON`) of each channel's nixpkgs, home-manager and nix-darwin. It is not produced by parsing Nix. Channels are discovered from [NixOS/infra `channels.nix`](https://github.com/NixOS/infra/blob/main/channels.nix) and pinned in `channels.json`. A GitHub Action re-pins them daily and deploys the site to GitHub Pages.

See [`CLAUDE.md`](CLAUDE.md) for the architecture in detail.
