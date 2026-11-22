// main.ts implements mend as specified in SPEC.md (MIT), covering sections 1 to 10: CLI argument parsing, output
// formatting and exit codes, file/line/path handling, format detection, three-tier line matching (with --strict),
// unified diffs (section 6), SEARCH/REPLACE blocks (section 7), V4A patches (section 8), JSON edits (section 9),
// and atomic all-or-nothing writes with per-edit rollback and move bookkeeping (`R <old> -> <new>`, section 10).
// Node 22, standard library only; run as `node main.ts [--format=NAME] [--check] [--strict] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree, moves: Array<[string, string]>) => void;

const trimEndST = (s: string): string => s.replace(/[ \t]+$/, '');
const trimBothST = (s: string): string => s.replace(/^[ \t]+|[ \t]+$/g, '');
const leadingST = (s: string): string => s.match(/^[ \t]*/)![0];

function splitFile(text: string): { br: '\r\n' | '\n'; lines: string[]; final: boolean } {
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  if (text === '') return { br, lines: [], final: false };
  const lines = text.split(br);
  const final = text.endsWith(br);
  if (final) lines.pop();
  return { br, lines, final };
}

function joinFile(lines: string[], br: string, final: boolean): string {
  return lines.length === 0 ? '' : lines.join(br) + (final ? br : '');
}

function normLine(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return trimEndST(s);
  return trimBothST(s);
}

function matchesAt(fileLines: string[], oldLines: string[], pos: number, tier: number): boolean {
  if (pos < 0 || pos + oldLines.length > fileLines.length) return false;
  for (let j = 0; j < oldLines.length; j++) {
    if (normLine(fileLines[pos + j]!, tier) !== normLine(oldLines[j]!, tier)) return false;
  }
  return true;
}

function findOccurrences(
  fileLines: string[],
  oldLines: string[],
  startIndex: number,
  strict: boolean,
  eofOnly = false,
): { tier: number; positions: number[] } | null {
  const maxTier = strict ? 0 : 2;
  for (let tier = 0; tier <= maxTier; tier++) {
    const positions: number[] = [];
    if (eofOnly) {
      const pos = fileLines.length - oldLines.length;
      if (pos >= startIndex && matchesAt(fileLines, oldLines, pos, tier)) positions.push(pos);
    } else {
      for (let i = startIndex; i <= fileLines.length - oldLines.length; i++) {
        if (matchesAt(fileLines, oldLines, i, tier)) positions.push(i);
      }
    }
    if (positions.length > 0) return { tier, positions };
  }
  return null;
}

interface NewItem {
  kind: ' ' | '+';
  text: string;
  oldIdx: number;
}

function buildReplacement(
  fileLines: string[],
  pos: number,
  oldLines: string[],
  newItems: NewItem[],
  tier: number,
): string[] {
  const F = leadingST(fileLines[pos]!);
  const P = leadingST(oldLines[0]!);
  return newItems.map((item) => {
    if (item.kind === ' ') return fileLines[pos + item.oldIdx]!;
    if (tier === 2 && !blank(item.text) && item.text.startsWith(P)) return F + item.text.slice(P.length);
    return item.text;
  });
}

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

interface UnifiedHunk {
  a: number;
  oldLines: string[];
  newItems: NewItem[];
  plusLines: string[];
  noNewlineAfterLastN: boolean;
  lastPlusHadNoNewline: boolean;
}

function parseUnifiedPath(line: string): string | null {
  let rest = line.slice(4);
  const tab = rest.indexOf('\t');
  if (tab >= 0) rest = rest.slice(0, tab);
  rest = rest.trim();
  if (rest === '/dev/null') return null;
  if (rest.startsWith('a/') || rest.startsWith('b/')) rest = rest.slice(2);
  return rest;
}

function parseUnifiedHunk(rawBody: string[], a: number): UnifiedHunk {
  const oldLines: string[] = [];
  const newItems: NewItem[] = [];
  const plusLines: string[] = [];
  let lastNIdx = -1;
  let lastPlusIdx = -1;
  for (let k = 0; k < rawBody.length; k++) {
    const l = rawBody[k]!;
    if (l === '') {
      const oldIdx = oldLines.length;
      oldLines.push('');
      lastNIdx = k;
      newItems.push({ kind: ' ', text: '', oldIdx });
    } else if (l[0] === ' ') {
      const text = l.slice(1);
      const oldIdx = oldLines.length;
      oldLines.push(text);
      lastNIdx = k;
      newItems.push({ kind: ' ', text, oldIdx });
    } else if (l[0] === '-') {
      oldLines.push(l.slice(1));
    } else if (l[0] === '+') {
      const text = l.slice(1);
      lastNIdx = k;
      lastPlusIdx = k;
      newItems.push({ kind: '+', text, oldIdx: -1 });
      plusLines.push(text);
    }
  }
  const noNewlineAfterLastN = lastNIdx >= 0 && lastNIdx + 1 < rawBody.length && rawBody[lastNIdx + 1]![0] === '\\';
  const lastPlusHadNoNewline = lastPlusIdx >= 0 && lastPlusIdx + 1 < rawBody.length && rawBody[lastPlusIdx + 1]![0] === '\\';
  return { a, oldLines, newItems, plusLines, noNewlineAfterLastN, lastPlusHadNoNewline };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let i = 0;
  const isDiffGit = (l: string): boolean => l === 'diff --git' || l.startsWith('diff --git ');
  const isHeaderPair = (idx: number): boolean =>
    idx + 1 < lines.length && lines[idx]!.startsWith('--- ') && lines[idx + 1]!.startsWith('+++ ');

  while (i < lines.length) {
    const line = lines[i]!;
    if (!isDiffGit(line) && !isHeaderPair(i)) {
      if (line.startsWith('@@')) throw new Exit2(`error: parse ${i + 1}`);
      i++;
      continue;
    }

    let gitOld: string | null = null;
    let gitNew: string | null = null;
    let minusPath: string | null = null;
    let plusPath: string | null = null;
    let sawMinusPlus = false;
    let renameFrom: string | null = null;
    let renameTo: string | null = null;
    let isNew = false;
    let isDeleted = false;

    if (isDiffGit(line)) {
      const m = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      gitOld = m[1]!;
      gitNew = m[2]!;
      i++;
    } else {
      minusPath = parseUnifiedPath(lines[i]!);
      plusPath = parseUnifiedPath(lines[i + 1]!);
      sawMinusPlus = true;
      i += 2;
    }

    while (i < lines.length) {
      const h = lines[i]!;
      if (h.startsWith('@@') || isDiffGit(h)) break;
      if (h.startsWith('--- ')) {
        if (i + 1 >= lines.length || !lines[i + 1]!.startsWith('+++ ')) {
          throw new Exit2(`error: parse ${i + 2}`);
        }
        if (sawMinusPlus) break;
        minusPath = parseUnifiedPath(h);
        plusPath = parseUnifiedPath(lines[i + 1]!);
        sawMinusPlus = true;
        i += 2;
        continue;
      }
      if (h.startsWith('rename from ')) renameFrom = h.slice(12).trim();
      else if (h.startsWith('rename to ')) renameTo = h.slice(10).trim();
      else if (h.startsWith('new file mode')) isNew = true;
      else if (h.startsWith('deleted file mode')) isDeleted = true;
      i++;
    }

    const hunks: UnifiedHunk[] = [];
    while (i < lines.length) {
      const l = lines[i]!;
      if (isDiffGit(l) || isHeaderPair(i)) break;
      if (!l.startsWith('@@')) {
        i++;
        continue;
      }
      const m = l.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      const a = Number(m[1]);
      i++;
      const rawBody: string[] = [];
      while (i < lines.length) {
        const b = lines[i]!;
        if (isDiffGit(b) || isHeaderPair(i)) break;
        if (b !== '' && b[0] !== ' ' && b[0] !== '-' && b[0] !== '+' && b[0] !== '\\') break;
        rawBody.push(b);
        i++;
      }
      while (rawBody.length > 0 && rawBody[rawBody.length - 1] === '') rawBody.pop();
      hunks.push(parseUnifiedHunk(rawBody, a));
    }

    const oldPath = sawMinusPlus ? minusPath : (renameFrom ?? gitOld);
    const newPath = sawMinusPlus ? plusPath : (renameTo ?? gitNew);

    edits.push((tree, moves) => {
      if (oldPath === null || isNew) {
        const target = newPath ?? '/dev/null';
        if (!safe(target)) throw new Fail('unsafe', target);
        if (tree.get(target) !== null) throw new Fail('exists', target);
        const createdLines: string[] = [];
        let endWithBreak = true;
        for (const h of hunks) {
          if (h.plusLines.length > 0) {
            createdLines.push(...h.plusLines);
            endWithBreak = !h.lastPlusHadNoNewline;
          }
        }
        tree.now.set(target, joinFile(createdLines, '\n', endWithBreak));
        return;
      }
      if (newPath === null || isDeleted) {
        if (!safe(oldPath)) throw new Fail('unsafe', oldPath);
        if (tree.get(oldPath) === null) throw new Fail('missing', oldPath);
        tree.now.set(oldPath, null);
        return;
      }
      if (!safe(oldPath)) throw new Fail('unsafe', oldPath);
      if (oldPath !== newPath && !safe(newPath)) throw new Fail('unsafe', newPath);
      const before = tree.get(oldPath);
      if (before === null) throw new Fail('missing', oldPath);
      if (oldPath !== newPath && tree.get(newPath) !== null) throw new Fail('exists', newPath);

      const state = splitFile(before);
      const fileLines = state.lines;
      let final = state.final;
      let d = 0;

      for (const h of hunks) {
        if (h.oldLines.length > 0) {
          const found = findOccurrences(fileLines, h.oldLines, 0, strict);
          if (!found) throw new Fail('no-match', oldPath);
          const target = h.a - 1 + d;
          let bestPos = found.positions[0]!;
          let bestDist = Math.abs(bestPos - target);
          for (let k = 1; k < found.positions.length; k++) {
            const p = found.positions[k]!;
            const dist = Math.abs(p - target);
            if (dist < bestDist) {
              bestDist = dist;
              bestPos = p;
            }
          }
          const rep = buildReplacement(fileLines, bestPos, h.oldLines, h.newItems, found.tier);
          const atEnd = bestPos + h.oldLines.length === fileLines.length;
          fileLines.splice(bestPos, h.oldLines.length, ...rep);
          if (atEnd) final = !h.noNewlineAfterLastN;
          d += h.newItems.length - h.oldLines.length;
        } else {
          const insertAt = Math.max(0, Math.min(h.a + d, fileLines.length));
          const atEnd = insertAt === fileLines.length;
          const rep = h.newItems.map((item) => item.text);
          fileLines.splice(insertAt, 0, ...rep);
          if (atEnd) final = !h.noNewlineAfterLastN;
          d += rep.length;
        }
      }

      const out = joinFile(fileLines, state.br, final);
      if (oldPath !== newPath) {
        tree.now.set(oldPath, null);
        tree.now.set(newPath, out);
        moves.push([oldPath, newPath]);
      } else {
        tree.now.set(oldPath, out);
      }
    });
  }
  return edits;
}

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = 0;
  let prevPath: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') continue;
    const searchLine = i + 1;
    let path: string | null = null;
    for (let j = i - 1; j >= prevEnd; j--) {
      const cand = lines[j]!;
      if (!blank(cand) && !cand.trim().startsWith('```')) {
        path = cand.trim();
        break;
      }
    }
    if (path === null) {
      if (prevPath !== null) path = prevPath;
      else throw new Exit2(`error: parse ${searchLine}`);
    }
    let eq = i + 1;
    while (eq < lines.length && lines[eq]!.trimEnd() !== '=======') eq++;
    if (eq >= lines.length) throw new Exit2(`error: parse ${searchLine}`);
    let end = eq + 1;
    while (end < lines.length && lines[end]!.trimEnd() !== '>>>>>>> REPLACE') end++;
    if (end >= lines.length) throw new Exit2(`error: parse ${searchLine}`);

    const oldLines = lines.slice(i + 1, eq);
    const newLines = lines.slice(eq + 1, end);
    const blockPath = path;
    edits.push((tree) => {
      if (!safe(blockPath)) throw new Fail('unsafe', blockPath);
      if (oldLines.length === 0) {
        if (tree.get(blockPath) !== null) throw new Fail('exists', blockPath);
        tree.now.set(blockPath, joinFile(newLines, '\n', true));
        return;
      }
      const before = tree.get(blockPath);
      if (before === null) throw new Fail('missing', blockPath);
      const state = splitFile(before);
      const found = findOccurrences(state.lines, oldLines, 0, strict);
      if (!found) throw new Fail('no-match', blockPath);
      if (found.positions.length > 1) throw new Fail('ambiguous', blockPath);
      const pos = found.positions[0]!;
      const F = leadingST(state.lines[pos]!);
      const P = leadingST(oldLines[0]!);
      const rep =
        found.tier === 2
          ? newLines.map((l) => (!blank(l) && l.startsWith(P) ? F + l.slice(P.length) : l))
          : newLines;
      state.lines.splice(pos, oldLines.length, ...rep);
      tree.now.set(blockPath, joinFile(state.lines, state.br, state.final));
    });

    prevPath = path;
    prevEnd = end + 1;
    i = end;
  }
  return edits;
}

interface V4aChunk {
  anchor: string | null;
  oldLines: string[];
  newItems: NewItem[];
  eof: boolean;
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const firstNonBlank = lines.findIndex((l) => !blank(l));
  if (firstNonBlank < 0) throw new Exit2('error: parse 1');
  if (lines[firstNonBlank]!.trim() !== '*** Begin Patch') {
    throw new Exit2(`error: parse ${firstNonBlank + 1}`);
  }
  let lastNonBlank = lines.length - 1;
  while (lastNonBlank >= 0 && blank(lines[lastNonBlank]!)) lastNonBlank--;
  if (lines[lastNonBlank]!.trim() !== '*** End Patch') {
    throw new Exit2(`error: parse ${lines.length + 1}`);
  }

  const isSectionHeader = (l: string): boolean =>
    l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');

  const edits: Edit[] = [];
  let i = firstNonBlank + 1;
  while (i < lastNonBlank) {
    const line = lines[i]!;
    if (blank(line)) {
      i++;
      continue;
    }
    if (!isSectionHeader(line)) throw new Exit2(`error: parse ${i + 1}`);
    const headerLine = i + 1;
    i++;
    const secStart = i;
    while (i < lastNonBlank && !isSectionHeader(lines[i]!)) i++;
    let secEnd = i;
    while (secEnd > secStart && blank(lines[secEnd - 1]!)) secEnd--;

    if (line.startsWith('*** Add File: ')) {
      const path = line.slice(14).trim();
      const fileLines: string[] = [];
      for (let k = secStart; k < secEnd; k++) {
        const l = lines[k]!;
        if (l.startsWith('+')) fileLines.push(l.slice(1));
        else if (l === '') fileLines.push('');
        else throw new Exit2(`error: parse ${k + 1}`);
      }
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) !== null) throw new Fail('exists', path);
        tree.now.set(path, joinFile(fileLines, '\n', true));
      });
    } else if (line.startsWith('*** Delete File: ')) {
      const path = line.slice(17).trim();
      if (secStart < secEnd) throw new Exit2(`error: parse ${secStart + 1}`);
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) === null) throw new Fail('missing', path);
        tree.now.set(path, null);
      });
    } else {
      const path = line.slice(16).trim();
      let k = secStart;
      let moveTo: string | null = null;
      if (k < secEnd && lines[k]!.startsWith('*** Move to: ')) {
        moveTo = lines[k]!.slice(13).trim();
        k++;
      }
      if (k >= secEnd && moveTo === null) throw new Exit2(`error: parse ${headerLine}`);

      const chunks: V4aChunk[] = [];
      let cur: V4aChunk | null = null;
      let chunkClosed = false;
      for (; k < secEnd; k++) {
        const l = lines[k]!;
        if (l.startsWith('@@')) {
          if (cur) chunks.push(cur);
          const anchor = l.slice(2).trim();
          cur = { anchor: anchor === '' ? null : anchor, oldLines: [], newItems: [], eof: false };
          chunkClosed = false;
        } else if (l.trim() === '*** End of File') {
          if (!cur) throw new Exit2(`error: parse ${k + 1}`);
          cur.eof = true;
          chunks.push(cur);
          cur = null;
          chunkClosed = true;
        } else if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+') {
          if (chunkClosed) throw new Exit2(`error: parse ${k + 1}`);
          if (!cur) cur = { anchor: null, oldLines: [], newItems: [], eof: false };
          if (l === '') {
            const oldIdx = cur.oldLines.length;
            cur.oldLines.push('');
            cur.newItems.push({ kind: ' ', text: '', oldIdx });
          } else if (l[0] === ' ') {
            const text = l.slice(1);
            const oldIdx = cur.oldLines.length;
            cur.oldLines.push(text);
            cur.newItems.push({ kind: ' ', text, oldIdx });
          } else if (l[0] === '-') {
            cur.oldLines.push(l.slice(1));
          } else {
            cur.newItems.push({ kind: '+', text: l.slice(1), oldIdx: -1 });
          }
        } else {
          throw new Exit2(`error: parse ${k + 1}`);
        }
      }
      if (cur) chunks.push(cur);

      edits.push((tree, moves) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
        const before = tree.get(path);
        if (before === null) throw new Fail('missing', path);
        if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);

        const state = splitFile(before);
        const fileLines = state.lines;
        let cursor = 0;

        for (const ch of chunks) {
          if (ch.anchor !== null) {
            const foundAnchor = findOccurrences(fileLines, [ch.anchor], cursor, strict);
            if (!foundAnchor) throw new Fail('no-match', path);
            cursor = foundAnchor.positions[0]! + 1;
          }
          if (ch.oldLines.length > 0) {
            const found = findOccurrences(fileLines, ch.oldLines, cursor, strict, ch.eof);
            if (!found) throw new Fail('no-match', path);
            const pos = found.positions[0]!;
            const rep = buildReplacement(fileLines, pos, ch.oldLines, ch.newItems, found.tier);
            fileLines.splice(pos, ch.oldLines.length, ...rep);
            cursor = pos + rep.length;
          } else {
            const pos = ch.eof ? fileLines.length : cursor;
            const rep = ch.newItems.map((item) => item.text);
            fileLines.splice(pos, 0, ...rep);
            cursor = pos + rep.length;
          }
        }

        const out = joinFile(fileLines, state.br, state.final);
        if (moveTo !== null) {
          tree.now.set(path, null);
          tree.now.set(moveTo, out);
          moves.push([path, moveTo]);
        } else {
          tree.now.set(path, out);
        }
      });
    }
  }
  return edits;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines, strict)
          : kind === 'search-replace'
            ? searchReplaceEdits(lines, strict)
            : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const moves: Array<[string, string]> = [];
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesLen = moves.length;
    try {
      edit(tree, moves);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      moves.length = movesLen;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const suppressedD = new Set<string>();
  const moveByNew = new Map<string, string>();
  for (const [oldP, newP] of moves) {
    if (tree.original(oldP) !== null && tree.get(oldP) === null && tree.original(newP) === null && tree.get(newP) !== null) {
      if (!suppressedD.has(oldP) && !moveByNew.has(newP)) {
        suppressedD.add(oldP);
        moveByNew.set(newP, oldP);
      }
    }
  }
  const rows: string[] = [];
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (now === null) {
      if (!suppressedD.has(p)) rows.push(`D ${p}`);
    } else if (was === null) {
      const oldP = moveByNew.get(p);
      rows.push(oldP !== undefined ? `R ${oldP} -> ${p}` : `A ${p}`);
    } else {
      rows.push(`M ${p}`);
    }
    if (check) continue;
    if (now === null) rmSync(p, { force: true });
    else {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
