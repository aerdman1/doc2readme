'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { makeWindow, buildDocx, heading, para } = require('./harness');

test('harness stands up the shipped modules', async () => {
  const win = makeWindow();
  for (const g of ['docx2readme', 'mdClean', 'htmlExtract', 'gitSync', 'pdfExtract', 'readmePreview']) {
    assert.ok(win[g], g + ' is not on window');
  }
  const buf = await buildDocx(win, heading(1, 'Title') + para('Hello world.'));
  const opts = win.docx2readme.defaultOptions();
  const { files, report } = await win.docx2readme.convertDocument(buf, 'demo.docx', opts);
  assert.equal(report.kind, 'docx');
  assert.match(files[0].text, /Hello world\./);
});
