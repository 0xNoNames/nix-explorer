# TODO: delete this file (and its branch in flake.nix channelPackages) once nixos-25.11 leaves channels.json:
# it only exists for channels before 26.05, and only 25.11 is left (unmaintained). Newer channels use their own
# pkgs/top-level/packages-info.nix.
#
# Package index of a nixpkgs tree, as JSON { packages = { "<attr path>" = { meta, pname, version }; }; }.
# A copy of nixpkgs' pkgs/top-level/packages-info.nix (26.05+, what search.nixos.org uses) for channels that
# don't have it: their nix-env -qa doesn't quote dotted attr names (rubyPackages."http_parser.rb"). Unlike
# upstream, it takes the tree as an argument and skips attributes that throw, as nix-env does (25.11 has
# pkgsx86_64Darwin, which throws on Linux).
{ nixpkgs }:
let
  pkgs = import nixpkgs { config = import "${nixpkgs}/pkgs/top-level/packages-config.nix"; };
  inherit (pkgs) lib;
  info =
    path: value:
    let
      r = builtins.tryEval (
        let
          result =
            if !(lib.isAttrs value) then
              [ ]
            else if lib.isDerivation value then
              [
                {
                  name = lib.showAttrPath path;
                  value = {
                    inherit (value) meta;
                    pname = value.pname or value.name;
                    version = value.version or "";
                  };
                }
              ]
            else if value.recurseForDerivations or false then
              lib.concatLists (lib.mapAttrsToList (name: info (path ++ [ name ])) value)
            else
              [ ];
        in
        lib.deepSeq result result
      );
    in
    if r.success then r.value else [ ];
in
builtins.toJSON { packages = lib.listToAttrs (info [ ] (lib.recurseIntoAttrs pkgs)); }
