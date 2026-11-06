'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { sortChanges } = require('../src/order.cjs');

const rootUri = { fsPath: path.resolve('fixture-repository') };
const change = (filename, status = 5) => ({ uri: { fsPath: path.join(rootUri.fsPath, filename) }, status });
const names = changes => changes.map(item => path.relative(rootUri.fsPath, item.uri.fsPath).split(path.sep).join('/'));
const ordered = (changes, order) => names(sortChanges(changes, rootUri, order));

test('list Name follows basenames when nested paths imply the opposite order', () => {
  const changes = [change('a/zebra.txt'), change('z/apple.txt'), change('middle.txt')];
  assert.deepEqual({
    name: ordered(changes, { mode: 'list', sortKey: 'name' }),
    path: ordered(changes, { mode: 'list', sortKey: 'path' }),
    original: names(changes)
  }, {
    name: ['z/apple.txt', 'middle.txt', 'a/zebra.txt'],
    path: ['middle.txt', 'a/zebra.txt', 'z/apple.txt'],
    original: ['a/zebra.txt', 'z/apple.txt', 'middle.txt']
  });
});

test('equal basenames retain SCM extension-host path order rather than Git API order', () => {
  const changes = [change('b/same.txt'), change('a/same.txt'), change('A/same.txt')];
  assert.deepEqual(ordered(changes, { mode: 'list', sortKey: 'name' }),
    ['A/same.txt', 'a/same.txt', 'b/same.txt']);
});

test('list Path sorts directories lexically and filenames numerically', () => {
  const changes = ['dir2/file2.txt', 'dir10/file2.txt', 'dir2/file10.txt', 'dir2/file1.txt', 'dir2/file01.txt']
    .map(filename => change(filename));
  assert.deepEqual(ordered(changes, { mode: 'list', sortKey: 'path' }),
    ['dir10/file2.txt', 'dir2/file01.txt', 'dir2/file1.txt', 'dir2/file2.txt', 'dir2/file10.txt']);
});

test('list Name disambiguates numeric-equivalent and case-equivalent filenames', () => {
  const changes = ['file10.txt', 'file2.txt', 'file1.txt', 'file01.txt', 'File1.txt'].map(filename => change(filename));
  assert.deepEqual(ordered(changes, { mode: 'list', sortKey: 'name' }),
    ['File1.txt', 'file01.txt', 'file1.txt', 'file2.txt', 'file10.txt']);
});

test('tree order visits folders before files at every level and sorts directory names numerically', () => {
  const changes = ['root.txt', 'dir10/first.txt', 'dir2/zero.txt', 'dir2/nested/z.txt', 'dir2/a.txt', 'a.txt']
    .map(filename => change(filename));
  assert.deepEqual(ordered(changes, { mode: 'tree', sortKey: 'name' }),
    ['dir2/nested/z.txt', 'dir2/a.txt', 'dir2/zero.txt', 'dir10/first.txt', 'a.txt', 'root.txt']);
});

test('list Status follows displayed status labels and resolves matching statuses by path', () => {
  const changes = [change('a.txt', 7), change('b/z.txt', 5), change('z.txt', 6), change('d.txt', 9), change('c.txt', 5)];
  assert.deepEqual(ordered(changes, { mode: 'list', sortKey: 'status' }),
    ['z.txt', 'd.txt', 'c.txt', 'b/z.txt', 'a.txt']);
});

test('localized status labels determine status ordering', () => {
  const changes = [change('modified.txt', 5), change('deleted.txt', 6), change('untracked.txt', 7)];
  assert.deepEqual(ordered(changes, {
    mode: 'list', sortKey: 'status', statusLabels: { Modified: 'A', Deleted: 'Z', Untracked: 'M' }
  }), ['modified.txt', 'untracked.txt', 'deleted.txt']);
});

test('empty and single-change snapshots return independent arrays without cloning entries', () => {
  const changes = [change('a.txt')];
  const result = sortChanges(changes, rootUri);
  assert.deepEqual({ empty: sortChanges([], rootUri), copied: result !== changes, sameChange: result[0] === changes[0] },
    { empty: [], copied: true, sameChange: true });
});
