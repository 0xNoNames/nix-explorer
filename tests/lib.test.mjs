import { test } from "node:test";
import assert from "node:assert/strict";
import { MODULAR_ROOT, buildTree, countOptions, findOptionLines, fuzzyName, fuzzyPositions, fuzzyScore, matchedName, ranker, wordPositions, wordsMatch, nixImports, nixTokens, normalizeDecl, optionName, optionPath, parseSearch, preprocessMd, sourceSuggestions } from "../site/lib.js";

test("normalizeDecl handles both declaration formats", () => {
  assert.equal(normalizeDecl("nixos/modules/a.nix"), "nixpkgs/nixos/modules/a.nix");
  assert.equal(normalizeDecl({ name: "<home-manager/modules/b.nix>", url: "u" }), "home-manager/modules/b.nix");
  assert.equal(normalizeDecl({ name: "<home-manager/modules/programs/aerc>" }), "home-manager/modules/programs/aerc/default.nix");
  assert.equal(normalizeDecl("/nix/store/abc-source/modules/generic/meta-maintainers.nix"), "nixpkgs/modules/generic/meta-maintainers.nix");
  assert.equal(normalizeDecl("nixos/modules/misc/documentation/modular-services.nix:21"), "nixpkgs/nixos/modules/misc/documentation/modular-services.nix");
});

test("buildTree nests options by path, including options that have children", () => {
  const root = buildTree({
    nixos: {
      "services.a": { loc: ["services", "a"], declarations: ["nixos/modules/a.nix"] },
      "services.a.enable": { loc: ["services", "a", "enable"], declarations: [] },
      "users.users.<name>.name": { loc: ["users", "users", "<name>", "name"] },
      "x.constructor": { loc: ["x", "constructor"] },
    },
    darwin: { "system.foo": { declarations: [{ name: "<nix-darwin/modules/x.nix>", url: null }] } },
  });
  const a = root.children.nixos.children.services.children.a;
  assert.equal(a.option.name, "services.a");
  assert.equal(a.option.decls[0], "nixpkgs/nixos/modules/a.nix");
  assert.equal(a.children.enable.option.name, "services.a.enable");
  assert.equal(root.children.nixos.children.users.children.users.children["<name>"].children.name.option.source, "nixos");
  assert.equal(root.children.nixos.children.x.children.constructor.option.name, "x.constructor");
  assert.equal(root.children.darwin.children.system.children.foo.option.name, "system.foo");
  assert.equal(countOptions(root), 5);
});

test("buildTree takes packages (meta.position decls, quoted attr names) like options", () => {
  const root = buildTree({ nixpkgs: {
    hello: { loc: ["hello"], version: "2.12", declarations: ["pkgs/by-name/he/hello/package.nix:42"], line: 42 },
    'python3Packages."a.b"': { loc: ["python3Packages", "a.b"], declarations: [] },
  } });
  const hello = root.children.nixpkgs.children.hello.option;
  assert.deepEqual([hello.source, hello.decls, hello.line], ["nixpkgs", ["nixpkgs/pkgs/by-name/he/hello/package.nix"], 42]);
  assert.equal(root.children.nixpkgs.children.python3Packages.children["a.b"].option.name, 'python3Packages."a.b"');
  assert.equal(optionName(["python3Packages", "a.b"]), 'python3Packages."a.b"'); // URL name = package key, so byKey routes it
});

test("buildTree groups modular services under one folder", () => {
  const imp = "<imports = [ pkgs.php.services.default ]>";
  const root = buildTree({ nixos: {
    [imp]: { loc: [imp] },
    [imp + ".php-fpm.package"]: { loc: [imp, "php-fpm", "package"] },
  } });
  const mod = root.children.nixos.children[MODULAR_ROOT].children["pkgs.php.services.default"];
  assert.equal(mod.option.name, imp);
  const pkg = mod.children["php-fpm"].children.package.option;
  assert.deepEqual(pkg.loc, [MODULAR_ROOT, "pkgs.php.services.default", "php-fpm", "package"]);
  assert.equal(pkg.modular, "pkgs.php.services.default");
  assert.equal(pkg.name, imp + ".php-fpm.package"); // original name kept for {option} links
});

test("preprocessMd converts nixpkgs roles and admonitions", () => {
  assert.equal(preprocessMd("See {option}`a.b` and {file}`/etc/x`.", "nixos"), "See [`a.b`](#nixos:a.b) and `/etc/x`.");
  assert.equal(preprocessMd("Hi\n\n::: {.warning}\nBe careful.\nReally.\n:::\n"),
    "Hi\n\n> **Warning**\n>\n> Be careful.\n> Really.\n");
});

test("wordsMatch matches each query word fuzzily inside a single word, any case", () => {
  const d = "Utility that combines the usability of The Silver Searcher with the raw speed of grep";
  assert.ok(wordsMatch(["silvr"], d)); // subsequence of "Silver"
  assert.ok(wordsMatch(["speed", "grep"], d));
  assert.ok(!wordsMatch(["usgrep"], d)); // letters spread over several words don't count
  assert.ok(!wordsMatch(["speed", "awk"], d)); // every word must match
  assert.ok(wordsMatch(["nix-shell"], "Run it with nix-shell -p")); // punctuation in the query matches itself
  assert.ok(!wordsMatch(["x"], ""));
});

test("ranker puts names with every word, then descriptions with every word, then fuzzy matches", () => {
  const rank = ranker("fastgrep", ["fast", "grep"]);
  const named = rank("fastgrep", "");
  const described = rank("ripgrep", "A fast line-oriented search tool, like GREP");
  const fuzzyName = rank("rpackages.fastlogisticregressionwrap", "");
  const fuzzyDesc = rank("foo", "Fanciest goodreps"); // f-a-s-t in "Fanciest", g-r-e-p in "goodreps"
  assert.ok(named > described && described > fuzzyName && fuzzyName > fuzzyDesc && fuzzyDesc > -1);
  assert.equal(rank("nothing", "here"), -1);
  assert.ok(ranker("a.b", ["a.b"])("x", "a.b") > ranker("a.b", ["a.b"])("x", "axb")); // words are literal, not regexps
});

test("match positions for highlighting follow the ranker's tiers", () => {
  assert.deepEqual(fuzzyPositions("ngen", "services.nginx.enable"), [9, 10, 15, 16]);
  assert.deepEqual(fuzzyPositions("xyz", "services.nginx.enable"), []);
  assert.deepEqual(wordPositions(["grep"], "Grep, then grep"), [0, 1, 2, 3, 11, 12, 13, 14]); // every occurrence, any case
  assert.deepEqual(wordPositions(["fst"], "a fast tool"), [2, 4, 5]); // fuzzy inside one word
  assert.deepEqual(wordPositions(["fst"], "f s t"), []); // not across words
  const rank = ranker("fastgrep", ["fast", "grep"]);
  assert.ok(matchedName(rank("fastgrep", "")) && !fuzzyName(rank("fastgrep", "")));
  assert.ok(!matchedName(rank("ripgrep", "fast grep")));
  assert.ok(fuzzyName(rank("rpackages.fastlogisticregressionwrap", "")));
  assert.ok(!matchedName(rank("foo", "Fanciest goodreps")));
});

test("fuzzyScore matches subsequences and ranks tighter matches higher", () => {
  assert.equal(fuzzyScore("xyz", "services.nginx.enable"), -1);
  assert.ok(fuzzyScore("ngxen", "services.nginx.enable") > 0);
  assert.ok(fuzzyScore("nginx.enable", "services.nginx.enable") >
    fuzzyScore("nginx.enable", "services.nginx.virtualhosts.<name>.enableacme"));
  assert.ok(fuzzyScore("boot", "boot.loader.grub.enable") > fuzzyScore("boot", "services.bootstrap.enable"));
});

test("nixTokens classifies Nix syntax and covers the whole input", () => {
  const src = String.raw`{ pkgs, ... }: # hi
let x = 1; in {
  services.nginx.enable = true;
  path = ./foo/bar.nix;
  s = "a \" b"; t = ''
    it'''s ''${"${x}"}
  '';
  y = if x == 1 then null else pkgs.hello;
}`;
  const toks = nixTokens(src);
  assert.equal(toks.map((t) => t[1]).join(""), src);
  const of = (cls) => toks.filter((t) => t[0] === cls).map((t) => t[1]);
  assert.deepEqual(of("comment"), ["# hi"]);
  assert.deepEqual(of("keyword"), ["let", "in", "if", "then", "else"]);
  assert.deepEqual(of("constant"), ["true", "null"]);
  assert.deepEqual(of("attr"), ["x", "services", "nginx", "enable", "path", "s", "t", "y"]);
  assert.deepEqual(of("path"), ["./foo/bar.nix"]);
  assert.deepEqual(of("number"), ["1", "1"]);
  assert.deepEqual(of("string"), [String.raw`"a \" b"`, "''\n    it'''s ''${x}\n  ''"]);
});

test("nixTokens handles interpolation with nested strings", () => {
  // From nixos/modules/services/web-servers/nginx/default.nix: ''…${f ''…''}…'' must not swallow what follows.
  const src = "x = ''\n  a ${optionalString c ''\n    b ${y}\n  ''}\n'';\nz = \"${g \"q\"}\";\nw = 1;";
  const toks = nixTokens(src);
  assert.equal(toks.map((t) => t[1]).join(""), src);
  const of = (cls) => toks.filter((t) => t[0] === cls).map((t) => t[1]);
  assert.deepEqual(of("attr"), ["x", "z", "w"]);
  assert.deepEqual(of("number"), ["1"]);
  assert.deepEqual(of("interp"), ["${", "${", "}", "}", "${", "}"]);
  assert.ok(of("string").every((s) => !s.includes("w =")));
});

test("findOptionLines finds the mk*Option declaration range, not config uses", () => {
  const src = [
    "{ config, lib, ... }:",                       // 1
    "let cfg = config.services.foo; in {",        // 2
    "  options.services.foo = {",                 // 3
    "    enable = lib.mkEnableOption \"foo\";",   // 4
    "    package = mkPackageOption pkgs \"foo\" { };", // 5
    "    hosts = mkOption {",                     // 6
    "      description = \"a } ; b\";",            // 7  brackets/; in strings don't end it
    "      type = attrsOf (submodule { options = {", // 8
    "        root = mkOption { };",               // 9
    "      }; });",                               // 10
    "    };",                                     // 11
    "  };",                                       // 12
    "  config.services.bar.enable = cfg.enable;", // 13
    "  config.services.foo.other = 1;",          // 14
    "}",
  ].join("\n");
  assert.deepEqual(findOptionLines(src, ["services", "foo", "enable"]), [4, 4]);
  assert.deepEqual(findOptionLines(src, ["services", "foo", "package"]), [5, 5]);
  assert.deepEqual(findOptionLines(src, ["services", "foo", "hosts"]), [6, 11]);
  assert.deepEqual(findOptionLines(src, ["services", "foo", "hosts", "<name>", "root"]), [9, 9]);
  assert.equal(findOptionLines(src, ["services", "foo", "other"]), null); // only a config use: no guess
  assert.equal(findOptionLines(src, ["services", "foo", "missing"]), null);
});

test("findOptionLines picks the declaration whose nesting matches, or none on a tie", () => {
  const src = [
    "{ lib, ... }: {",                                  // 1
    "  options.programs.foo = {",                       // 2
    "    enable = lib.mkEnableOption \"foo\";",          // 3
    "    xwayland.enable = lib.mkEnableOption \"xw\";",  // 4
    "    bar = {",                                       // 5
    "      enable = lib.mkOption { };",                  // 6
    "    };",                                            // 7
    "    a = mkOption { type = submodule { options.name = mkOption { }; }; };", // 8
    "    b = mkOption { type = submodule { options.name = mkOption { }; }; };", // 9
    "  };",
    "}",
  ].join("\n");
  assert.deepEqual(findOptionLines(src, ["programs", "foo", "enable"]), [3, 3]);
  assert.deepEqual(findOptionLines(src, ["programs", "foo", "xwayland", "enable"]), [4, 4]);
  assert.deepEqual(findOptionLines(src, ["programs", "foo", "bar", "enable"]), [6, 6]);
  assert.equal(findOptionLines(src, ["programs", "foo", "a", "<name>", "name"]), null); // a.<name>.name vs b's: a tie
});

test("nixImports resolves relative module paths in code only", () => {
  const src = [
    "{ lib, ... }:",
    "# import ./commented.nix",
    "{",
    "  imports = [ ./a.nix ../shared ./dir/ ];",
    "  type = submodule (import ./vhost-options.nix { inherit lib; });",
    "  script = ./run.sh;",
    "  s = \"./in-string.nix\";",
    "  up = ../../../../../outside.nix;",
    "  up2 = ../../../../../x/../outside.nix;",
    "}",
  ].join("\n");
  assert.deepEqual(nixImports(src, "nixpkgs/nixos/modules/web/nginx/default.nix").sort(), [
    "nixpkgs/nixos/modules/web/nginx/a.nix",
    "nixpkgs/nixos/modules/web/nginx/dir/default.nix",
    "nixpkgs/nixos/modules/web/nginx/vhost-options.nix",
    "nixpkgs/nixos/modules/web/shared/default.nix",
  ]);
});

test("optionName/optionPath round-trip dotted, quoted and placeholder segments", () => {
  const cases = [
    [["services", "nginx", "enable"], "services.nginx.enable"],
    [["services", "nginx", "virtualHosts", "<name>", "forceSSL"], "services.nginx.virtualHosts.<name>.forceSSL"],
    [["boot", "kernel", "sysctl", "net.core.rmem_max"], 'boot.kernel.sysctl."net.core.rmem_max"'],
    [["<imports = [ pkgs.php.services.default ]>", "php-fpm"], "<imports = [ pkgs.php.services.default ]>.php-fpm"],
    [["<modular services>", "pkgs.php.services.default", "php-fpm"], '<modular services>."pkgs.php.services.default".php-fpm'],
  ];
  for (const [segs, name] of cases) {
    assert.equal(optionName(segs), name);
    assert.deepEqual(optionPath(name), segs);
  }
  assert.deepEqual(optionPath(""), []);
});

test("parseSearch pulls @source filters out of the query", () => {
  const S = ["nixos", "home-manager", "darwin"];
  assert.deepEqual(parseSearch("Nginx enable", S), { q: "nginxenable", words: ["nginx", "enable"], sources: null });
  assert.deepEqual(parseSearch("@nixos nginx", S), { q: "nginx", words: ["nginx"], sources: ["nixos"] });
  assert.deepEqual(parseSearch("git @home @d", S), { q: "git", words: ["git"], sources: ["home-manager", "darwin"] });
  assert.deepEqual(parseSearch("git @", S), { q: "git", words: ["git"], sources: null });
  assert.deepEqual(parseSearch("git @nope", S), { q: "git", words: ["git"], sources: [] });
});

test("sourceSuggestions lists sources for the @prefix being typed", () => {
  const S = ["nixos", "home-manager", "darwin"];
  assert.deepEqual(sourceSuggestions("git @h", S), ["home-manager"]);
  assert.deepEqual(sourceSuggestions("@Ni", S), ["nixos"]);
  assert.deepEqual(sourceSuggestions("@", S), S);
  assert.deepEqual(sourceSuggestions("@nixos", S), []);
  assert.deepEqual(sourceSuggestions("@x", S), []);
  assert.deepEqual(sourceSuggestions("@n git", S), []);
  assert.deepEqual(sourceSuggestions("a@n", S), []);
});
