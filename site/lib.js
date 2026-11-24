// Pure logic (no DOM): option tree, declaration links, markdown preprocessing, fuzzy scoring.

// Declaring file as "<repo>/<path>" (repo: nixpkgs | home-manager | nix-darwin), matching the
// layout of the bundled src/<channel>/ tree. NixOS gives repo-relative strings ("nixos/modules/x.nix");
// home-manager and nix-darwin give { name: "<home-manager/modules/x.nix>", url }.
// Some declarations name a module directory (home-manager/modules/programs/aerc); Nix loads its default.nix.
// channelSources in flake.nix reimplements this in jq for the build: keep the two in sync.
export function normalizeDecl(d) {
  // shortcut: absolute store paths (seen in home-manager 26.05) are assumed to be nixpkgs sources;
  // revisit if another repo starts showing up that way (the build warns on missing files).
  // nixos 25.11 also has a few "file.nix:21" (with a line number): stripped.
  const p = (typeof d === "string" ? "nixpkgs/" + d.replace(/^\/nix\/store\/[^/]+\//, "") : d.name.replace(/^<|>$/g, ""))
    .replace(/:\d+$/, "");
  return p.endsWith(".nix") ? p : p + "/default.nix";
}

// Null-prototype children: option path segments like "constructor" must not hit Object.prototype.
const newNode = (name) => ({ name, children: Object.create(null), option: null });

// NixOS documents modular services as fake top-level options "<imports = [ pkgs.X.services.Y ]>"
// (nixos/modules/misc/documentation/modular-services.nix); they're used via system.services.<name>.
const MODULAR = /^<imports = \[ (pkgs\.\S+) \]>$/;
export const MODULAR_ROOT = "<modular services>";

// sources: { nixos: optionsJSON, "home-manager": ..., darwin: ... }
// Tree follows option paths: root -> source -> loc segments. A node may be an option and have children.
export function buildTree(sources) {
  const root = newNode("");
  for (const [source, opts] of Object.entries(sources)) {
    const top = (root.children[source] = newNode(source));
    for (const [name, opt] of Object.entries(opts)) {
      let loc = opt.loc ?? name.split(".");
      // Group modular services under one folder keyed by the module to import; `modular` keeps that key.
      const modular = loc[0].match(MODULAR)?.[1];
      if (modular) loc = [MODULAR_ROOT, modular, ...loc.slice(1)];
      let node = top;
      for (const seg of loc) node = node.children[seg] ??= newNode(seg);
      node.option = { ...opt, loc, name, source, modular, decls: (opt.declarations ?? []).map(normalizeDecl) };
    }
  }
  return root;
}

export function countOptions(node) {
  let n = node.option ? 1 : 0;
  for (const c of Object.values(node.children)) n += countOptions(c);
  return n;
}

// nixpkgs markdown dialect -> CommonMark. {option}`x` becomes an in-page link to
// "#<source>:x", other roles become code, ::: {.note} blocks become blockquotes.
export function preprocessMd(text, source) {
  return text
    .replace(/\{option\}`([^`]+)`/g, (_, o) => `[\`${o}\`](#${source}:${encodeURIComponent(o)})`)
    .replace(/\{\w+\}`/g, "`")
    .replace(/^[ \t]*:::[ \t]*\{\.(\w+)\}[ \t]*\n([\s\S]*?)^[ \t]*:::[ \t]*$/gm, (_, kind, body) =>
      `> **${kind[0].toUpperCase() + kind.slice(1)}**\n>\n` + body.trimEnd().replace(/^/gm, "> "));
}

// fzf-style subsequence match; -1 if no match. Rewards consecutive runs, matches at
// segment starts, exact substrings and short names. Inputs must be lowercased.
export function fuzzyScore(q, s) {
  let score = 0, run = 0, j = 0;
  for (let i = 0; i < s.length && j < q.length; i++) {
    if (s[i] !== q[j]) { run = 0; continue; }
    j++; run++;
    score += run * 2 + (i === 0 || s[i - 1] === "." ? 6 : 0);
  }
  if (j < q.length) return -1;
  return score + (s.includes(q) ? 30 : 0) - s.length * 0.1;
}

// Splits a search box value into the fuzzy query and the sources picked with `@<prefix>` words
// (`@nixos`, `@home`, `@d`; several = any of them). sources is null when none is given.
export function parseSearch(value, sources) {
  let picks = null; // a bare "@" (still typing) filters nothing; an unknown @word matches nothing
  const q = value.toLowerCase().replace(/@(\S*)/g, (_, p) => {
    if (p) (picks ??= []).push(...sources.filter((s) => s.startsWith(p)));
    return "";
  }).replace(/\s+/g, "");
  return { q, sources: picks };
}

// Sources an "@prefix" being typed at the end of the text could be ([] once it's complete).
export function sourceSuggestions(text, sources) {
  const p = text.toLowerCase().match(/(?:^|\s)@(\S*)$/)?.[1];
  const hits = p == null ? [] : sources.filter((s) => s.startsWith(p));
  return hits.length === 1 && hits[0] === p ? [] : hits;
}

// Minimal Nix tokenizer for highlighting: returns [[class | null, text], …] covering all of src.
// Strings are scanned with a context stack so ${…} interpolations (which may hold nested strings) are code.
const NIX_CODE = new RegExp([
  /(#[^\n]*|\/\*[\s\S]*?\*\/)/,                  // 1 comment
  /((?:~|\.\.?)?(?:\/[\w.+-]+)+\/?|<[\w./+-]+>)/, // 2 path
  /([A-Za-z_][\w'-]*)/,                          // 3 identifier
  /(\d+(?:\.\d+)?)/,                             // 4 number
  /(''|")/,                                      // 5 string start
  /([\s\S])/,                                    // 6 anything else
].map((r) => r.source).join("|"), "y");
// Identifier followed by `= ` (or `.x.y =`) is an attribute name.
const NIX_ATTR = /(?:\s*\.\s*(?:[A-Za-z_][\w'-]*|"[^"\n]*"))*\s*=(?!=)/y;
const NIX_KEYWORDS = new Set(["let", "in", "with", "rec", "inherit", "if", "then", "else", "assert", "or"]);
const NIX_CONSTANTS = new Set(["true", "false", "null"]);

export function nixTokens(src) {
  const out = [];
  const push = (cls, text) => {
    const last = out.at(-1);
    if (last && last[0] === cls) last[1] += text;
    else if (text) out.push([cls, text]);
  };
  // Each context is a string ('"' or "''") or code (null) with its open-brace depth.
  const stack = [{ str: null, depth: 0 }];
  let i = 0;
  while (i < src.length) {
    const ctx = stack.at(-1);
    if (ctx.str) {
      let j = i, closed = false;
      while (j < src.length && !closed && !src.startsWith("${", j)) {
        if (src.startsWith("$${", j)) j += 3; // escaped interpolation
        else if (ctx.str === '"') {
          if (src[j] === "\\") j += 2;
          else if (src[j++] === '"') closed = true;
        } else if (src.startsWith("'''", j) || src.startsWith("''$", j)) j += 3;
        else if (src.startsWith("''\\", j)) j += 4;
        else if (src.startsWith("''", j)) { j += 2; closed = true; }
        else j++;
      }
      push("string", src.slice(i, j));
      if (closed) stack.pop();
      else if (j < src.length) { push("interp", "${"); stack.push({ str: null, depth: 0 }); j += 2; }
      i = j;
      continue;
    }
    NIX_CODE.lastIndex = i;
    const [text, comment, path, id, number, quote] = NIX_CODE.exec(src);
    i += text.length;
    if (quote) { push("string", quote); stack.push({ str: quote, depth: 0 }); continue; }
    if (text === "{") ctx.depth++;
    if (text === "}" && ctx.depth === 0 && stack.length > 1) { push("interp", "}"); stack.pop(); continue; }
    if (text === "}") ctx.depth--;
    NIX_ATTR.lastIndex = i;
    push(comment ? "comment" : path ? "path" : number ? "number"
      : !id ? null
      : NIX_KEYWORDS.has(id) ? "keyword" : NIX_CONSTANTS.has(id) ? "constant"
      : NIX_ATTR.test(src) ? "attr" : null, text);
  }
  return out;
}

export const esc = (s) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
// Every token is escaped, so the result is safe for innerHTML.
export const nixHTML = (src) => nixTokens(src).map(([c, t]) => (c ? `<span class="tk-${c}">${esc(t)}</span>` : esc(t))).join("");

// Best guess at the lines [start, end] (1-based) declaring an option in its file, or null. Options JSON
// only records the file, so search for the option path followed by `= mk*Option`, longest suffix first
// (services.nginx.enable =, nginx.enable =, enable =). No confident match → null (a wrong jump misleads).
// Segments up to the last placeholder (<name>, *, the modular-services folder) can't appear in source.
export function findOptionLines(text, loc) {
  let start = loc.length;
  while (start > 0 && !/^[<*]/.test(loc[start - 1])) start--;
  const segs = loc.slice(start);
  const re = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const lineOf = (i) => text.slice(0, i).split("\n").length;
  // The declaration ends at the first `;` outside brackets; strings/comments are skipped via the tokenizer.
  const range = (m) => {
    const rest = text.slice(m.index + m[0].length);
    let depth = 0, len = 0;
    for (const [cls, t] of nixTokens(rest)) {
      if (cls === null) for (const [i, ch] of [...t].entries()) {
        if ("{[(".includes(ch)) depth++;
        else if ("}])".includes(ch)) depth--;
        else if (ch === ";" && depth <= 0) return [lineOf(m.index), lineOf(m.index + m[0].length + len + i)];
      }
      len += t.length;
    }
    return [lineOf(m.index), lineOf(m.index)];
  };
  for (let k = segs.length; k >= 1; k--) {
    const path = segs.slice(-k).map((s) => `(?:${re(s)}|"${re(s)}")`).join("\\s*\\.\\s*");
    const decls = [...text.matchAll(new RegExp(`(?<![\\w'"-])${path}\\s*=(?!=)`, "g"))]
      .filter((m) => /^[\s(]*(?:lib\.)?mk\w*Opt/.test(text.slice(m.index + m[0].length, m.index + m[0].length + 120)));
    if (decls.length === 1) return range(decls[0]);
    if (decls.length) return pick(decls, segs.slice(0, -k));
  }
  return null;

  // Several declarations match (enable for both foo and foo.bar): keep the one whose enclosing attribute
  // names end with the most of the option's remaining segments; a tie is no confident match.
  function pick(decls, prefix) {
    const want = new Set(decls.map((m) => m.index)), names = new Map();
    const stack = [];
    let pending = [], at = 0;
    for (const [cls, t] of nixTokens(text)) {
      if (want.has(at)) names.set(at, [...stack.flat(), ...pending]); // pending: xwayland in xwayland.enable =
      if (cls === "attr") pending.push(t);
      else if (cls === null) for (const ch of t) {
        if (ch === "{") { stack.push(pending); pending = []; }
        else if (ch === "}") { stack.pop(); pending = []; }
        else if (ch === ";") pending = [];
      }
      at += t.length;
    }
    const score = (m) => {
      const n = names.get(m.index) ?? [];
      let j = 0;
      while (j < prefix.length && prefix.at(-1 - j) === n.at(-1 - j)) j++;
      return j;
    };
    const scores = decls.map(score), best = Math.max(...scores);
    return scores.filter((s) => s === best).length === 1 ? range(decls[scores.indexOf(best)]) : null;
  }
}

// How many import levels the source page follows when an option isn't in its declaring file
// (nginx: default.nix → vhost-options.nix → location-options.nix). The build bundles the same closure.
export const IMPORT_DEPTH = 3;

// Relative .nix paths referenced in code (not comments/strings) of `file` ("<repo>/<path>"), resolved
// to "<repo>/<path>"; directories map to default.nix. Paths escaping the repo are dropped.
// channelSources in flake.nix reimplements this in jq for the build: keep the two in sync.
export function nixImports(text, file) {
  const out = new Set();
  for (const [cls, t] of nixTokens(text)) {
    if (cls !== "path" || !/^\.\.?\//.test(t)) continue;
    const last = t.replace(/\/$/, "").split("/").pop();
    if (last.includes(".") && !last.endsWith(".nix") && last !== "..") continue; // ./script.sh etc.
    const parts = file.split("/").slice(0, -1);
    let ok = true;
    for (const seg of t.split("/"))
      if (seg === "..") ok &&= parts.length > 1 && !!parts.pop();
      else if (seg && seg !== ".") parts.push(seg);
    if (!ok) continue;
    const p = parts.join("/");
    out.add(p.endsWith(".nix") ? p : p + "/default.nix");
  }
  return [...out];
}

// Option paths <-> the dotted names used in URLs (#nixos:services.nginx.enable), as Nix writes them:
// segments containing "." are quoted, "<…>" placeholders (incl. "<imports = [ pkgs.x ]>") stay atomic.
export const optionName = (segs) =>
  segs.map((s) => (s.includes(".") && !/^<.*>$/.test(s) ? `"${s}"` : s)).join(".");

export function optionPath(name) {
  if (!name) return [];
  const segs = [];
  let cur = "", quoted = false, angle = 0;
  for (const ch of name) {
    if (quoted) { if (ch === '"') quoted = false; else cur += ch; }
    else if (ch === '"') quoted = true;
    else if (ch === "." && !angle) { segs.push(cur); cur = ""; }
    else { if (ch === "<") angle++; else if (ch === ">" && angle) angle--; cur += ch; }
  }
  return [...segs, cur];
}
