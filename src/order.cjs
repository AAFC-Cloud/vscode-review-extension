/*
 * Source Control ordering follows Visual Studio Code's SCMTreeSorter and
 * comparers (src/vs/base/common/comparers.ts), adapted under the MIT License.
 *
 * Copyright (c) Microsoft Corporation. All rights reserved.
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 */

'use strict';

const path = require('node:path');
const filenames = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

const statusLabels = {
  0: 'Index Modified',
  1: 'Index Added',
  2: 'Index Deleted',
  3: 'Index Renamed',
  4: 'Index Copied',
  5: 'Modified',
  6: 'Deleted',
  7: 'Untracked',
  8: 'Ignored',
  9: 'Intent to Add',
  10: 'Intent to Rename',
  11: 'Type Changed',
  12: 'Conflict: Added By Us',
  13: 'Conflict: Added By Them',
  14: 'Conflict: Deleted By Us',
  15: 'Conflict: Deleted By Them',
  16: 'Conflict: Both Added',
  17: 'Conflict: Both Deleted',
  18: 'Conflict: Both Modified'
};

function compareText(a, b) {
  return a === b ? 0 : a < b ? -1 : 1;
}

function compareNames(a, b) {
  const result = filenames.compare(a, b);
  // Numeric collation equates e.g. file1 and file01; SCM disambiguates these.
  return result || compareText(a, b);
}

function comparePaths(a, b, caseSensitive = false) {
  const left = a.split(path.sep);
  const right = b.split(path.sep);
  for (let i = 0; ; i++) {
    const leftEnd = i === left.length - 1;
    const rightEnd = i === right.length - 1;
    if (leftEnd && rightEnd) return compareNames(left[i], right[i]);
    if (leftEnd !== rightEnd) return leftEnd ? -1 : 1;
    const result = compareText(caseSensitive ? left[i] : left[i].toLowerCase(),
      caseSensitive ? right[i] : right[i].toLowerCase());
    if (result) return result;
  }
}

function compareTreePaths(a, b) {
  const left = a.split(path.sep);
  const right = b.split(path.sep);
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    if (left[i] === right[i]) continue;
    const leftDirectory = i < left.length - 1;
    const rightDirectory = i < right.length - 1;
    if (leftDirectory !== rightDirectory) return leftDirectory ? -1 : 1;
    return compareNames(left[i], right[i]);
  }
  return left.length - right.length;
}

/** Return a snapshot ordered as one SCM resource group, without mutating it. */
function sortChanges(changes, rootUri, viewOrder = {}) {
  const records = changes.map(change => ({ change, relative: path.relative(rootUri.fsPath, change.uri.fsPath) }));
  const label = change => {
    const english = statusLabels[change.status] ?? '';
    return viewOrder.statusLabels?.[english] ?? english;
  };
  records.sort((a, b) => {
    let result;
    if (viewOrder.mode === 'tree') {
      result = compareTreePaths(a.relative, b.relative);
    } else if (viewOrder.sortKey === 'name') {
      result = compareNames(path.basename(a.relative), path.basename(b.relative));
    } else if (viewOrder.sortKey === 'status') {
      result = compareText(label(a.change), label(b.change)) || comparePaths(a.relative, b.relative);
    } else {
      result = comparePaths(a.relative, b.relative);
    }
    // Before the UI's stable sort, the SCM extension host sorts each group by
    // case-sensitive path. This decides the visible order of equal basenames.
    return result || comparePaths(a.change.uri.fsPath, b.change.uri.fsPath, true);
  });
  return records.map(record => record.change);
}

module.exports = { sortChanges };
