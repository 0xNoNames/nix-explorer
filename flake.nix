{
  description = "Web explorer for NixOS, home-manager and nix-darwin modules";

  # Build tooling only. The documented channels are pinned in channels.json
  # (flake inputs can't be generated from data): refresh it with `nix run .#update-channels`.
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs =
    { self, nixpkgs }:
    let
      lib = nixpkgs.lib;
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "x86_64-darwin"
        "aarch64-darwin"
      ];
      forAll = f: lib.genAttrs systems (system: f system nixpkgs.legacyPackages.${system});

      # Primary channels from NixOS/infra's channels.nix, pinned by the update-channels app.
      # The UI defaults to the first "stable" entry, else the first. Fetches are locked (rev + narHash), so eval stays pure.
      fetch = s: builtins.fetchTree { type = "github"; inherit (s) owner repo rev narHash; };
      channels = map (c: {
        inherit (c) name status;
        nixpkgs = fetch c.nixpkgs;
        hm = fetch c.home-manager;
        darwin = fetch c.nix-darwin;
      }) (lib.importJSON ./channels.json);

      channelOptions =
        system: pkgs: c:
        let
          # Non-flake entry points (stable across release branches), all on the channel's own nixpkgs.
          # Only the options doc is evaluated, not a full system, so an empty config is enough
          # (system = null + hostPlatform is what lib.nixosSystem does).
          nixos = import "${c.nixpkgs}/nixos/lib/eval-config.nix" {
            system = null;
            modules = [ { nixpkgs.hostPlatform = system; } ];
          };
          nixosJSON = nixos.config.system.build.manual.optionsJSON;
          hmJSON =
            (import "${c.hm}/docs" {
              # The NixOS eval's nixpkgs instance: instantiating another costs eval time and memory.
              inherit (nixos) pkgs;
              inherit (lib.importJSON "${c.hm}/release.json") release isReleaseBranch;
            }).options.json;
          darwinJSON =
            (import "${c.darwin}/release.nix" {
              nixpkgs = c.nixpkgs;
              inherit system;
              nix-darwin = { inherit (c.darwin) rev shortRev; };
            }).docs.optionsJSON;
        in
        pkgs.runCommand "options-${c.name}" { } ''
          mkdir -p $out
          cp ${nixosJSON}/share/doc/nixos/options.json $out/nixos.json
          cp ${hmJSON}/share/doc/home-manager/options.json $out/home-manager.json
          cp ${darwinJSON}/share/doc/darwin/options.json $out/darwin.json
        '';

      # The .nix files that declare options, copied from the channel's inputs so the
      # site can show them without network access (it's deployed in isolated environments).
      channelSources =
        pkgs: c: options:
        # Bundles each declaring file plus its relative imports up to IMPORT_DEPTH (lib.js), which
        # source.html follows to find options declared in imported files (nginx vhost-options.nix).
        pkgs.runCommand "sources-${c.name}" { nativeBuildInputs = [ pkgs.jq ]; } ''
          # "<repo>/<path>" names are relative paths from here.
          mkdir repos && cd repos
          ln -s ${c.nixpkgs} nixpkgs; ln -s ${c.hm} home-manager; ln -s ${c.darwin} nix-darwin

          # Same rules as normalizeDecl in lib.js: keep the two in sync.
          jq -r '.[] | .declarations[]?
            | (if type == "string" then "nixpkgs/" + sub("^/nix/store/[^/]+/"; "") else .name | gsub("^<|>$"; "") end)
            | sub(":[0-9]+$"; "") | if endswith(".nix") then . else . + "/default.nix" end
            | select((split("/") | any(. == "..") | not) and (split("/")[0] | IN("nixpkgs", "home-manager", "nix-darwin")))' \
            ${options}/*.json | sort -u > ../all
          cp ../all ../frontier

          # Imports: grep over-approximates nixImports (it also matches paths in comments and strings),
          # which only bundles a few unused files; the source page still follows tokenizer paths only.
          depth=$(sed -n 's/^export const IMPORT_DEPTH = \([0-9]*\);$/\1/p' ${./site/lib.js})
          [ -n "$depth" ]
          for _ in $(seq "$depth"); do
            # xargs exits 123 when some grep finds nothing (or a declared file is missing).
            { tr '\n' '\0' < ../frontier | xargs -0 grep -soHE '\.\.?(/[A-Za-z0-9_.+-]+)+/?' || [ $? = 123 ]; } | jq -Rr '
              capture("^(?<f>[^:]*):(?<t>.*)$") as {$f, $t}
              | ($t | sub("/$"; "") | split("/") | last) as $last
              | select(($last | contains(".")) and ($last | endswith(".nix") | not) and $last != ".." | not)
              | reduce ($t | split("/")[]) as $s ({p: ($f | split("/")[:-1]), ok: true};
                  if $s == ".." then (if (.p | length) > 1 then .p |= .[:-1] else .ok = false end)
                  elif $s == "" or $s == "." then . else .p += [$s] end)
              | select(.ok) | .p | join("/") | if endswith(".nix") then . else . + "/default.nix" end' \
              | sort -u | comm -13 ../all - | while IFS= read -r p; do if [ -f "$p" ]; then echo "$p"; fi; done > ../next
            mv ../next ../frontier
            [ -s ../frontier ] || break
            sort -u ../all ../frontier -o ../all
          done

          while IFS= read -r p; do
            if [ -f "$p" ]; then install -Dm644 "$p" "$out/$p"
            else echo "warning: declaring file not found: $p" >&2; fi
          done < ../all
        '';
    in
    {
      packages = forAll (
        system: pkgs: rec {
          site =
            pkgs.runCommand "nixos-explorer-site"
              {
                nativeBuildInputs = [ pkgs.jq pkgs.minify ];
              }
              ''
                mkdir -p web $out/data $out/src
                cp ${./site}/*.html ${./site}/*.js ${./site}/*.css web/
                # The Nix snowflake (NixOS artwork, CC-BY-4.0).
                cp ${pkgs.nixos-icons}/share/icons/hicolor/scalable/apps/nix-snowflake.svg web/favicon.svg
                # Minifies HTML (inline scripts and styles too), JS, CSS and SVG; data JSON is left as-is (gzip already removes its whitespace).
                minify -r -o $out/ web/
                ${lib.concatMapStrings (
                  c:
                  let
                    options = channelOptions system pkgs c;
                  in
                  ''
                    cp -r ${options} $out/data/${c.name}
                    cp -r ${channelSources pkgs c options} $out/src/${c.name}
                  ''
                ) channels}
                # Decoded sizes of the data files, for the loading percentage: a compressing host
                # (GitHub Pages) only sends the compressed Content-Length.
                cp ${./channels.json} channels.json
                ${lib.concatMapStrings (c: lib.concatMapStrings (s: ''
                  jq --arg c ${c.name} --arg s ${s} --argjson n "$(wc -c < $out/data/${c.name}/${s}.json)" \
                    'map(if .name == $c then .sizes[$s] = $n else . end)' channels.json > tmp.json
                  mv tmp.json channels.json
                '') [ "nixos" "home-manager" "darwin" ]) channels}
                cp channels.json $out/data/channels.json
              '';

          default = site;
        }
      );

      apps = forAll (
        system: pkgs: {
          # Uses the caller's `nix` (whatever implementation is installed) for eval and prefetch.
          update-channels = {
            type = "app";
            program = lib.getExe (pkgs.writeShellApplication {
              name = "update-channels";
              runtimeInputs = [ pkgs.curl pkgs.jq pkgs.git ];
              text = ''
                # Regenerates channels.json from NixOS/infra's channels.nix: every "primary" NixOS channel
                # (nixos-unstable, nixos-YY.MM, including unmaintained ones), each pinned to a nixpkgs,
                # home-manager and nix-darwin commit plus narHash. Run from the repo root: nix run .#update-channels
                set -euo pipefail
                shopt -s inherit_errexit # failures inside $(…) must abort too, not yield empty values

                out=''${1:-channels.json}
                tmp=$(mktemp -d)
                trap 'rm -rf "$tmp"' EXIT

                curl -fsSL https://raw.githubusercontent.com/NixOS/infra/main/channels.nix -o "$tmp/channels.nix"
                # { "<name>": "<status>" } for primary channels.
                # shellcheck disable=SC2016 # ''${n} is Nix interpolation, not shell
                nix eval --json --file "$tmp/channels.nix" channels \
                  --apply 'cs: builtins.mapAttrs (_: c: c.status) (builtins.removeAttrs cs (builtins.filter (n: (cs.''${n}.variant or null) != "primary") (builtins.attrNames cs)))' \
                  > "$tmp/primary.json"

                # rev <owner> <repo> <branch>: prints the branch's commit, or nothing if the branch doesn't exist.
                # A failing ls-remote (network, rate limit) aborts the run rather than dropping the channel.
                rev() {
                  local r
                  r=$(git ls-remote "https://github.com/$1/$2" "refs/heads/$3" | cut -f1)
                  [ -n "$r" ] || echo "  missing branch $1/$2 $3" >&2
                  echo "$r"
                }

                # pin <owner> <repo> <branch> <rev>: prints {owner, repo, branch, rev, narHash}.
                # Only prefetches (a full source download) when the rev isn't already in the old lock.
                pin() {
                  local hash=""
                  [ -f "$out" ] && hash=$(jq -r --arg rev "$4" 'first(.[] | .nixpkgs, ."home-manager", ."nix-darwin" | select(.rev == $rev) | .narHash) // empty' "$out")
                  [ -n "$hash" ] || hash=$(nix flake prefetch --json "github:$1/$2/$4" | jq -r .hash)
                  [[ $hash == sha256-* ]] || { echo "  no narHash for $1/$2 $4" >&2; return 1; }
                  jq -n --arg owner "$1" --arg repo "$2" --arg branch "$3" --arg rev "$4" --arg narHash "$hash" \
                    '{$owner, $repo, $branch, $rev, $narHash}'
                }

                # Unstable first, then releases newest first (the explorer's default is the first entry).
                # Channels are pinned in parallel; numbered entry files keep that order.
                pids=() i=0
                for name in $(jq -r 'keys | sort_by(if . == "nixos-unstable" then "~" else . end) | reverse | .[]' "$tmp/primary.json"); do
                  entry=$tmp/entry-$(printf %03d "$i").json i=$((i + 1))
                  (
                    status=$(jq -r --arg n "$name" '.[$n]' "$tmp/primary.json")
                    if [ "$name" = nixos-unstable ]; then hm=master; darwin=master
                    else version=''${name#nixos-}; hm=release-$version; darwin=nix-darwin-$version; fi
                    echo "$name ($status)" >&2
                    # Right after a NixOS release, home-manager/nix-darwin may not have branched yet: skip until they do.
                    npr=$(rev NixOS nixpkgs "$name")
                    hr=$(rev nix-community home-manager "$hm")
                    dr=$(rev nix-darwin nix-darwin "$darwin")
                    if [ -n "$npr" ] && [ -n "$hr" ] && [ -n "$dr" ]; then
                      np=$(pin NixOS nixpkgs "$name" "$npr")
                      h=$(pin nix-community home-manager "$hm" "$hr")
                      d=$(pin nix-darwin nix-darwin "$darwin" "$dr")
                      jq -n --arg name "$name" --arg status "$status" --argjson np "$np" --argjson hm "$h" --argjson d "$d" \
                        '{$name, $status, nixpkgs: $np, "home-manager": $hm, "nix-darwin": $d}' > "$entry"
                    else
                      echo "  skipped $name" >&2
                    fi
                  ) &
                  pids+=($!)
                done
                for p in "''${pids[@]}"; do wait "$p"; done

                jq -s . "$tmp"/entry-*.json > "$tmp/lock.json"
                mv "$tmp/lock.json" "$out"
                echo "wrote $out: $(jq -r 'map(.name) | join(", ")' "$out")" >&2
              '';
            });
            meta.description = "Re-pin channels.json from NixOS/infra channels.nix";
          };
        }
      );

      devShells = forAll (
        system: pkgs: {
          default = pkgs.mkShell {
            packages = [
              pkgs.nodejs
            ];
          };
        }
      );

      checks = forAll (
        system: pkgs: {
          lib = pkgs.runCommand "lib-test" { } ''
            ${pkgs.nodejs}/bin/node --test ${./.}/tests/lib.test.mjs && touch $out
          '';
        }
      );
    };
}
