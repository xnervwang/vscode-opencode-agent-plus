// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * node pack-vsix.js <repository> [--out <file>] [--base-content-url <url>] [--base-images-url <url>]
 *
 * A .vsix is a zip with the extension under extension/ and two descriptor files (make-manifest.js); VS Code needs
 * nothing else for a local install. The extension's files are the fixed list in OWN; node_modules contributes only the
 * packages reachable from package.json "dependencies", looked up the way Node's require() resolves them, so devDependencies and
 * anything installed by hand stay out. Inside those packages, type declarations, source maps, the ES module builds
 * (require() loads the CommonJS ones) and change logs are left out. A package only a web page loads (PAGE_ONLY) brings
 * just the files the page reads and its licence, and none of its own dependencies, which only its Node entry needs.
 */
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const manifest = require('./make-manifest');

const OWN = ['package.json', 'extension.js', 'README.md', 'ThirdPartyNotices.txt', 'src', 'media', 'images', 'opencode-plugin'];
const SKIP_DIRS = new Set(['dist-es', 'dist-types', '.github', 'test', 'tests', '__tests__']);
const SKIP_FILE = /(\.d\.ts|\.map|\.tsbuildinfo)$|^(CHANGELOG|HISTORY)(\.md)?$/i;
/* media/chat.js loads markdown-it's self-contained browser build and highlight.js's (its common languages), and the
   page's buttons use the codicon font (src/ui/chat-panel.js); nothing requires any of them. */
const PAGE_ONLY = {
  'markdown-it': ['package.json', 'LICENSE', 'dist/browser/markdown-it.umd.min.js'],
  '@vscode/codicons': ['package.json', 'LICENSE', 'LICENSE-CODE', 'dist/codicon.css', 'dist/codicon.ttf'],
  '@highlightjs/cdn-assets': ['package.json', 'LICENSE', 'highlight.min.js'],
};

/* The folder of package `name` as require() would find it from `fromDir`, or ''. */
function findPackage(name, fromDir, root) {
  for (let dir = fromDir; ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, 'node_modules', name);
    if (fs.existsSync(path.join(candidate, 'package.json'))) return candidate;
    if (dir === root || path.dirname(dir) === dir) return '';
  }
}

/* Every package folder the run-time dependencies need, each once. Optional ones that are not installed are skipped. */
function runtimePackages(root) {
  root = fs.realpathSync(root);
  const seen = new Set();
  const missing = [];
  const visit = (dir, deps, optional) => {
    for (const name of Object.keys(deps || {})) {
      const at = findPackage(name, dir, root);
      if (!at) { if (!optional.has(name)) missing.push(`${name} (needed by ${path.relative(root, dir) || 'the extension'})`); continue; }
      const real = fs.realpathSync(at);
      if (seen.has(real)) continue;
      seen.add(real);
      if (PAGE_ONLY[name] && dir === root) continue;
      const pkg = JSON.parse(fs.readFileSync(path.join(at, 'package.json'), 'utf8'));
      visit(at, { ...pkg.dependencies, ...pkg.optionalDependencies }, new Set(Object.keys(pkg.optionalDependencies || {})));
    }
  };
  const top = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  visit(root, top.dependencies, new Set());
  if (missing.length) throw new Error(`run-time packages not installed (run npm install): ${missing.join(', ')}`);
  return [...seen].map((p) => path.relative(root, p).split(path.sep).join('/')).filter((p) => p.startsWith('node_modules/')).sort();
}

function stage(root, dir) {
  const into = path.join(dir, 'extension');
  const files = [];
  const copy = (rel, inModules) => {
    const from = path.join(root, rel);
    const st = fs.lstatSync(from);
    if (st.isSymbolicLink()) return;
    const base = path.basename(rel);
    if (st.isDirectory()) {
      /* Running the plugin's hooks in this checkout leaves __pycache__ beside them. */
      if (inModules ? SKIP_DIRS.has(base) : base === 'node_modules' || base === '__pycache__') return;
      for (const name of fs.readdirSync(from).sort()) {
        if (inModules && name === 'node_modules') continue;
        copy(`${rel}/${name}`, inModules);
      }
      return;
    }
    if (inModules && SKIP_FILE.test(base)) return;
    fs.mkdirSync(path.dirname(path.join(into, rel)), { recursive: true });
    fs.copyFileSync(from, path.join(into, rel));
    files.push(rel);
  };
  for (const rel of OWN) {
    if (!fs.existsSync(path.join(root, rel))) throw new Error(`no ${rel} in ${root}`);
    copy(rel, false);
  }
  /* Nested node_modules are packages of their own and come in through runtimePackages. */
  for (const rel of runtimePackages(root)) {
    const only = PAGE_ONLY[rel.replace(/^node_modules\//, '')];
    if (!only) { copy(rel, true); continue; }
    for (const f of only) {
      if (!fs.existsSync(path.join(root, rel, f))) throw new Error(`${rel}/${f} is missing (run npm install)`);
      copy(`${rel}/${f}`, true);
    }
  }
  fs.copyFileSync(path.join(root, 'LICENSE'), path.join(into, 'LICENSE.txt'));
  files.push('LICENSE.txt');
  return files;
}

/*
 * Marketplace pages show README.md without the files beside it, so the packed copy points its relative links at the
 * repository.
 */
function rebaseLinks(text, contentBase, imagesBase) {
  const dir = (url) => (url && !url.endsWith('/') ? `${url}/` : url);
  const [content, images] = [dir(contentBase), dir(imagesBase || contentBase)];
  return text.replace(/(!?)(\[[^\]]*\]\()([^)\s]+)/g, (all, bang, head, target) => {
    const base = bang ? images : content;
    if (!base || target.startsWith('#') || /^[a-z][a-z0-9+.-]*:/i.test(target)) return all;
    return `${bang}${head}${base}${target.replace(/^\.?\//, '')}`;
  });
}

module.exports = { runtimePackages, findPackage, stage, rebaseLinks, OWN, PAGE_ONLY };

if (require.main === module) {
  const args = process.argv.slice(2);
  const option = (name) => {
    const at = args.indexOf(name);
    return at >= 0 ? args.splice(at, 2)[1] || '' : '';
  };
  const outArg = option('--out');
  const contentBase = option('--base-content-url');
  const imagesBase = option('--base-images-url');
  /* The root with its links resolved: package folders are compared with it after their own links are resolved. */
  const root = fs.realpathSync(path.resolve(args[0] || path.join(__dirname, '..')));
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const out = path.resolve(outArg || path.join(root, 'build', `${pkg.publisher}.${pkg.name}-${pkg.version}.vsix`));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-agent-plus-pack-'));
  let status = 1;
  try {
    const files = stage(root, dir);
    if (contentBase || imagesBase) {
      const readme = path.join(dir, 'extension', 'README.md');
      fs.writeFileSync(readme, rebaseLinks(fs.readFileSync(readme, 'utf8'), contentBase, imagesBase));
    }
    manifest.write(dir);
    fs.rmSync(out, { force: true });
    const zip = cp.spawnSync('zip', ['-q', '-r', '-X', out, '[Content_Types].xml', 'extension.vsixmanifest', 'extension'], { cwd: dir, stdio: 'inherit' });
    if (zip.status === 0) {
      console.log(`${out} (${files.length} files, ${(fs.statSync(out).size / 1048576).toFixed(1)} MB)`);
      status = 0;
    } else console.error(zip.error ? `pack.sh: the zip command could not run (${zip.error.code || zip.error.message}); install zip` : 'pack.sh: zip failed');
  } catch (e) {
    console.error(`pack.sh: ${e.message}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  process.exit(status);
}
