import { runCheck, type Check } from './runner.ts';

interface EdgeCase {
  name: string;
  check: Omit<Check, 'id'>;
  expectExit: number;
  expectStdout: string;
  expectFiles: Record<string, string>;
}

const cases: EdgeCase[] = [
  // 1. Unified edge cases
  {
    name: 'u-backslash-middle-not-eof',
    check: {
      argv: ['p.diff'],
      stdin: null,
      files: {
        'a.txt': 'one\ntwo\nthree\nfour',
        'p.diff': [
          '--- a/a.txt',
          '+++ b/a.txt',
          '@@ -1,3 +1,3 @@',
          ' one',
          '-two',
          '\\ No newline at end of file',
          '+TWO',
          ' three',
          '',
        ].join('\n'),
      },
    },
    expectExit: 0,
    expectStdout: 'M a.txt\nok: 1 file\n',
    expectFiles: {
      'a.txt': 'one\nTWO\nthree\nfour',
      'p.diff': [
        '--- a/a.txt',
        '+++ b/a.txt',
        '@@ -1,3 +1,3 @@',
        ' one',
        '-two',
        '\\ No newline at end of file',
        '+TWO',
        ' three',
        '',
      ].join('\n'),
    },
  },
  {
    name: 'u-create-no-final-newline',
    check: {
      argv: ['-'],
      stdin: [
        '--- /dev/null',
        '+++ b/new.txt',
        '@@ -0,0 +1,2 @@',
        '+alpha',
        '+beta',
        '\\ No newline at end of file',
        '',
      ].join('\n'),
      files: {},
    },
    expectExit: 0,
    expectStdout: 'A new.txt\nok: 1 file\n',
    expectFiles: {
      'new.txt': 'alpha\nbeta',
    },
  },
  {
    name: 'u-header-dangling-minus',
    check: {
      argv: ['-'],
      stdin: [
        'diff --git a/a.txt b/a.txt',
        'index 111..222 100644',
        '--- a/a.txt',
        '@@ -1 +1 @@',
        '-old',
        '+new',
        '',
      ].join('\n'),
      files: { 'a.txt': 'old\n' },
    },
    expectExit: 2,
    expectStdout: 'error: parse 4\n',
    expectFiles: { 'a.txt': 'old\n' },
  },
  {
    name: 'u-body-ended-by-next-section-pair',
    check: {
      argv: ['-'],
      stdin: [
        '--- a/a.txt',
        '+++ b/a.txt',
        '@@ -1,1 +1,1 @@',
        '-a1',
        '+a2',
        '--- a/b.txt',
        '+++ b/b.txt',
        '@@ -1,1 +1,1 @@',
        '-b1',
        '+b2',
        '',
      ].join('\n'),
      files: { 'a.txt': 'a1\n', 'b.txt': 'b1\n' },
    },
    expectExit: 0,
    expectStdout: 'M a.txt\nM b.txt\nok: 2 files\n',
    expectFiles: { 'a.txt': 'a2\n', 'b.txt': 'b2\n' },
  },
  {
    name: 'u-empty-o-beyond-eof',
    check: {
      argv: ['-'],
      stdin: [
        '--- a/a.txt',
        '+++ b/a.txt',
        '@@ -50,0 +50,2 @@',
        '+x',
        '+y',
        '',
      ].join('\n'),
      files: { 'a.txt': 'first\nsecond' },
    },
    expectExit: 0,
    expectStdout: 'M a.txt\nok: 1 file\n',
    expectFiles: { 'a.txt': 'first\nsecond\nx\ny\n' },
  },
  {
    name: 'u-tie-nearest-earlier-wins',
    check: {
      argv: ['-'],
      stdin: [
        '--- a/a.txt',
        '+++ b/a.txt',
        '@@ -3,1 +3,1 @@',
        '-dup',
        '+HIT',
        '',
      ].join('\n'),
      // 0-based indices: 0='dup', 1='mid', 2='mid', 3='mid', 4='dup'
      // A - 1 + d = 3 - 1 + 0 = 2. dist(0, 2) = 2, dist(4, 2) = 2 -> earlier (0) wins.
      files: { 'a.txt': 'dup\nmid\nmid\nmid\ndup\n' },
    },
    expectExit: 0,
    expectStdout: 'M a.txt\nok: 1 file\n',
    expectFiles: { 'a.txt': 'HIT\nmid\nmid\nmid\ndup\n' },
  },
  {
    name: 'u-pure-rename-no-hunks',
    check: {
      argv: ['-'],
      stdin: [
        'diff --git a/old.txt b/new.txt',
        'similarity index 100%',
        'rename from old.txt',
        'rename to new.txt',
        '',
      ].join('\n'),
      files: { 'old.txt': 'hello\n' },
    },
    expectExit: 0,
    expectStdout: 'R old.txt -> new.txt\nok: 1 file\n',
    expectFiles: { 'new.txt': 'hello\n' },
  },
  {
    name: 'u-two-sections-same-file',
    check: {
      argv: ['-'],
      stdin: [
        '--- a/a.txt',
        '+++ b/a.txt',
        '@@ -1,1 +1,1 @@',
        '-one',
        '+ONE',
        '--- a/a.txt',
        '+++ b/a.txt',
        '@@ -2,1 +2,1 @@',
        '-ONE',
        '+TWO',
        '',
      ].join('\n'),
      files: { 'a.txt': 'one\nend\n' },
    },
    expectExit: 0,
    expectStdout: 'M a.txt\nok: 1 file\n',
    expectFiles: { 'a.txt': 'TWO\nend\n' },
  },

  // 2. Unified in CRLF file (preserving no-final-break and final-break)
  {
    name: 'u-crlf-preserve-no-final-break',
    check: {
      argv: ['-'],
      stdin: [
        '--- a/c.txt',
        '+++ b/c.txt',
        '@@ -1,3 +1,3 @@',
        ' top',
        '-mid',
        '+MID',
        ' bot',
        '\\ No newline at end of file',
        '',
      ].join('\n'),
      files: { 'c.txt': 'top\r\nmid\r\nbot' },
    },
    expectExit: 0,
    expectStdout: 'M c.txt\nok: 1 file\n',
    expectFiles: { 'c.txt': 'top\r\nMID\r\nbot' },
  },
  {
    name: 'u-crlf-preserve-final-break',
    check: {
      argv: ['-'],
      stdin: [
        '--- a/c.txt',
        '+++ b/c.txt',
        '@@ -1,2 +1,2 @@',
        '-top',
        '+TOP',
        ' bot',
        '',
      ].join('\n'),
      files: { 'c.txt': 'top\r\nbot\r\n' },
    },
    expectExit: 0,
    expectStdout: 'M c.txt\nok: 1 file\n',
    expectFiles: { 'c.txt': 'TOP\r\nbot\r\n' },
  },

  // 3. SEARCH/REPLACE edge cases
  {
    name: 'sr-fence-not-path-inherits-prev',
    check: {
      argv: ['-'],
      stdin: [
        'a.txt',
        '<<<<<<< SEARCH',
        'one',
        '=======',
        'ONE',
        '>>>>>>> REPLACE',
        '```ts',
        '<<<<<<< SEARCH',
        'two',
        '=======',
        'TWO',
        '>>>>>>> REPLACE',
        '',
      ].join('\n'),
      files: { 'a.txt': 'one\ntwo\n' },
    },
    expectExit: 0,
    expectStdout: 'M a.txt\nok: 1 file\n',
    expectFiles: { 'a.txt': 'ONE\nTWO\n' },
  },
  {
    name: 'sr-create-exists',
    check: {
      argv: ['-'],
      stdin: [
        'a.txt',
        '<<<<<<< SEARCH',
        '=======',
        'new',
        '>>>>>>> REPLACE',
        '',
      ].join('\n'),
      files: { 'a.txt': 'existing\n' },
    },
    expectExit: 1,
    expectStdout: 'error: exists a.txt\nfailed: 1 of 1 edits\n',
    expectFiles: { 'a.txt': 'existing\n' },
  },
  {
    name: 'sr-tier0-ambiguous-over-lower-tier',
    check: {
      argv: ['-'],
      stdin: [
        'a.txt',
        '<<<<<<< SEARCH',
        'foo',
        '=======',
        'bar',
        '>>>>>>> REPLACE',
        '',
      ].join('\n'),
      files: { 'a.txt': 'foo\nfoo\n  foo\n' },
    },
    expectExit: 1,
    expectStdout: 'error: ambiguous a.txt\nfailed: 1 of 1 edits\n',
    expectFiles: { 'a.txt': 'foo\nfoo\n  foo\n' },
  },

  // 4. V4A edge cases
  {
    name: 'v4a-first-chunk-no-at-sign',
    check: {
      argv: ['-'],
      stdin: [
        '*** Begin Patch',
        '*** Update File: a.txt',
        ' first',
        '-second',
        '+SECOND',
        '*** End Patch',
        '',
      ].join('\n'),
      files: { 'a.txt': 'first\nsecond\n' },
    },
    expectExit: 0,
    expectStdout: 'M a.txt\nok: 1 file\n',
    expectFiles: { 'a.txt': 'first\nSECOND\n' },
  },
  {
    name: 'v4a-eof-chunk-picks-last-occurrence',
    check: {
      argv: ['-'],
      stdin: [
        '*** Begin Patch',
        '*** Update File: a.txt',
        '@@',
        '-dup',
        '+END',
        '*** End of File',
        '*** End Patch',
        '',
      ].join('\n'),
      files: { 'a.txt': 'dup\nmid\ndup\n' },
    },
    expectExit: 0,
    expectStdout: 'M a.txt\nok: 1 file\n',
    expectFiles: { 'a.txt': 'dup\nmid\nEND\n' },
  },
  {
    name: 'v4a-anchor-tier1',
    check: {
      argv: ['-'],
      stdin: [
        '*** Begin Patch',
        '*** Update File: a.txt',
        '@@ fn target()',
        '-old',
        '+new',
        '*** End Patch',
        '',
      ].join('\n'),
      files: { 'a.txt': 'old\nfn target()   \nold\n' },
    },
    expectExit: 0,
    expectStdout: 'M a.txt\nok: 1 file\n',
    expectFiles: { 'a.txt': 'old\nfn target()   \nnew\n' },
  },
  {
    name: 'v4a-add-file-with-empty-lines',
    check: {
      argv: ['-'],
      stdin: [
        '*** Begin Patch',
        '*** Add File: b.txt',
        '+line1',
        '',
        '+line3',
        '*** End Patch',
        '',
      ].join('\n'),
      files: {},
    },
    expectExit: 0,
    expectStdout: 'A b.txt\nok: 1 file\n',
    expectFiles: { 'b.txt': 'line1\n\nline3\n' },
  },
  {
    name: 'v4a-chunk-after-end-of-file-marker',
    check: {
      argv: ['-'],
      stdin: [
        '*** Begin Patch',
        '*** Update File: a.txt',
        '@@',
        ' tail',
        '-end',
        '+END',
        '*** End of File',
        '@@',
        '+appended',
        '*** End Patch',
        '',
      ].join('\n'),
      files: { 'a.txt': 'tail\nend\n' },
    },
    expectExit: 0,
    expectStdout: 'M a.txt\nok: 1 file\n',
    expectFiles: { 'a.txt': 'tail\nEND\nappended\n' },
  },
  {
    name: 'v4a-move-to-without-chunks',
    check: {
      argv: ['-'],
      stdin: [
        '*** Begin Patch',
        '*** Update File: old.txt',
        '*** Move to: new.txt',
        '*** End Patch',
        '',
      ].join('\n'),
      files: { 'old.txt': 'content\n' },
    },
    expectExit: 0,
    expectStdout: 'R old.txt -> new.txt\nok: 1 file\n',
    expectFiles: { 'new.txt': 'content\n' },
  },

  // 5. Tier behaviour
  {
    name: 'tier2-nonprefix-and-context-preserved',
    check: {
      argv: ['-'],
      stdin: [
        '--- a/a.txt',
        '+++ b/a.txt',
        '@@ -1,3 +1,3 @@',
        '     ctx1',
        '-    old',
        '+    prefixed',
        '+  unprefixed',
        '     ctx2',
        '',
      ].join('\n'),
      files: { 'a.txt': '  ctx1\n  old\n  ctx2\n' },
    },
    expectExit: 0,
    expectStdout: 'M a.txt\nok: 1 file\n',
    expectFiles: { 'a.txt': '  ctx1\n  prefixed\n  unprefixed\n  ctx2\n' },
  },
  {
    name: 'strict-rejects-tier1',
    check: {
      argv: ['--strict', '-'],
      stdin: [
        'a.txt',
        '<<<<<<< SEARCH',
        'hello',
        '=======',
        'world',
        '>>>>>>> REPLACE',
        '',
      ].join('\n'),
      files: { 'a.txt': 'hello   \n' },
    },
    expectExit: 1,
    expectStdout: 'error: no-match a.txt\nfailed: 1 of 1 edits\n',
    expectFiles: { 'a.txt': 'hello   \n' },
  },

  // 6. CLI behaviour
  {
    name: 'cli-check-failing-edit',
    check: {
      argv: ['--check', '-'],
      stdin: [
        'a.txt',
        '<<<<<<< SEARCH',
        'one',
        '=======',
        'ONE',
        '>>>>>>> REPLACE',
        'missing.txt',
        '<<<<<<< SEARCH',
        'x',
        '=======',
        'y',
        '>>>>>>> REPLACE',
        '',
      ].join('\n'),
      files: { 'a.txt': 'one\n' },
    },
    expectExit: 1,
    expectStdout: 'error: missing missing.txt\nfailed: 1 of 2 edits\n',
    expectFiles: { 'a.txt': 'one\n' },
  },
  {
    name: 'cli-usage-beats-no-patch',
    check: {
      argv: ['--bogus', 'does-not-exist.patch'],
      stdin: null,
      files: {},
    },
    expectExit: 2,
    expectStdout: 'error: usage\n',
    expectFiles: {},
  },
  {
    name: 'cli-parse-beats-missing-file',
    check: {
      argv: ['--format=v4a', '-'],
      stdin: [
        '*** Begin Patch',
        '*** Update File: missing.txt',
        '*** End Patch',
        '',
      ].join('\n'),
      files: {},
    },
    expectExit: 2,
    expectStdout: 'error: parse 2\n',
    expectFiles: {},
  },
];

let passed = 0;
for (const tc of cases) {
  const got = runCheck({ id: tc.name, ...tc.check });
  const why: string[] = [];
  if (got.exit !== tc.expectExit) why.push(`exit ${got.exit}, expected ${tc.expectExit}`);
  if (got.stdout !== tc.expectStdout) why.push(`stdout ${JSON.stringify(got.stdout)}, expected ${JSON.stringify(tc.expectStdout)}`);
  for (const p of new Set([...Object.keys(tc.expectFiles), ...Object.keys(got.files)])) {
    if (tc.expectFiles[p] === undefined) why.push(`${p} should not exist`);
    else if (got.files[p] === undefined) why.push(`${p} is missing`);
    else if (got.files[p] !== tc.expectFiles[p]) {
      why.push(`${p} differs: expected ${JSON.stringify(tc.expectFiles[p])}, got ${JSON.stringify(got.files[p])}`);
    }
  }
  if (why.length === 0) passed += 1;
  else process.stdout.write(`FAIL ${tc.name}\n  ${why.join('\n  ')}\n`);
}
process.stdout.write(`${passed} of ${cases.length} edge tests passed\n`);
if (passed !== cases.length) process.exitCode = 1;
