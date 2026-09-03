// Block[] -> .docx
//
// The mirror image of renderBlocks(): same block model, WordprocessingML out
// instead of Markdown. A .docx is a zip of XML parts, and converter.js already
// ships makeZip() — so this returns the part list and the caller zips it. No
// new dependency, nothing loaded at runtime.
//
// Word has no callout and no code block. A callout becomes a single-cell shaded
// table, code becomes a shaded monospace paragraph. Both are what Word users
// expect to see, and both survive a round trip through Word's own styles.
//
// Images are the one thing this cannot do alone. A ReadMe zip export contains
// no image files at all — every <Image> is an https://files.readme.io URL — so
// the bytes have to come from somewhere. The caller passes `media`: a map of
// url -> {data, ext}. Anything missing renders as a labelled placeholder with
// the URL, so a document is never silently short a screenshot.

(function (root) {
  'use strict';

  const EMU_PER_PX = 9525;              // 96 dpi
  const MAX_W_EMU = 6.0 * 914400;       // 6in: letter minus 1.25in margins

  function xml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      // Word rejects the C0 range outright; a stray control char from a PDF or
      // a copy-pasted terminal session makes the whole file unopenable.
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
  }

  // ---------------------------------------------------------------- inline

  // Markdown inline -> runs. Deliberately small: bold, italic, code, links and
  // images are what ReadMe pages actually contain. Anything else stays literal,
  // which is the safe direction — a stray asterisk is better than lost text.
  function inlineRuns(text, ctx, baseProps) {
    const runs = [];
    const src = String(text == null ? '' : text);
    let i = 0, buf = '';

    const flush = () => { if (buf) { runs.push(textRun(buf, baseProps)); buf = ''; } };

    while (i < src.length) {
      const rest = src.slice(i);

      // `code`
      let m = /^`([^`]+)`/.exec(rest);
      if (m) { flush(); runs.push(textRun(m[1], Object.assign({}, baseProps, { code: true }))); i += m[0].length; continue; }

      // ![alt](url)
      m = /^!\[([^\]]*)\]\(([^)\s]+)[^)]*\)/.exec(rest);
      if (m) { flush(); runs.push.apply(runs, imageRuns(m[2], m[1], ctx)); i += m[0].length; continue; }

      // [text](url)
      m = /^\[([^\]]+)\]\(([^)\s]+)[^)]*\)/.exec(rest);
      if (m) {
        flush();
        runs.push(hyperlink(m[1], m[2], ctx, baseProps));
        i += m[0].length; continue;
      }

      // **bold** / __bold__
      m = /^(\*\*|__)(?=\S)([\s\S]*?\S)\1/.exec(rest);
      if (m) { flush(); runs.push.apply(runs, inlineRuns(m[2], ctx, Object.assign({}, baseProps, { b: true }))); i += m[0].length; continue; }

      // *italic* — not intraword, and never an underscore: GFM does not treat
      // client_credentials as emphasis and neither should this.
      m = /^\*(?=\S)([^*]+?\S)\*/.exec(rest);
      if (m) { flush(); runs.push.apply(runs, inlineRuns(m[1], ctx, Object.assign({}, baseProps, { i: true }))); i += m[0].length; continue; }

      if (src[i] === '\n') { flush(); runs.push('<w:r><w:br/></w:r>'); i++; continue; }
      buf += src[i]; i++;
    }
    flush();
    return runs;
  }

  function rPr(p) {
    p = p || {};
    const out = [];
    if (p.b) out.push('<w:b/>');
    if (p.i) out.push('<w:i/>');
    if (p.code) out.push('<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/><w:sz w:val="18"/>');
    if (p.link) out.push('<w:color w:val="0B5FFF"/><w:u w:val="single"/>');
    if (p.mono) out.push('<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/><w:sz w:val="18"/>');
    return out.length ? '<w:rPr>' + out.join('') + '</w:rPr>' : '';
  }

  function textRun(t, props) {
    // xml:space="preserve" or Word eats leading/trailing spaces between runs.
    return '<w:r>' + rPr(props) + '<w:t xml:space="preserve">' + xml(t) + '</w:t></w:r>';
  }

  function hyperlink(label, url, ctx, baseProps) {
    const rid = ctx.rel(url, true);
    const inner = inlineRuns(label, ctx, Object.assign({}, baseProps, { link: true })).join('');
    return '<w:hyperlink r:id="' + rid + '">' + inner + '</w:hyperlink>';
  }

  // ---------------------------------------------------------------- images

  // Enough of PNG/JPEG/GIF to get intrinsic size. Word needs an extent in EMU;
  // guessing one distorts every screenshot, so read it from the bytes.
  function imageSize(bytes) {
    if (!bytes || bytes.length < 24) return null;
    const b = bytes;
    if (b[0] === 0x89 && b[1] === 0x50) {                       // PNG
      const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
      return { w: dv.getUint32(16), h: dv.getUint32(20) };
    }
    if (b[0] === 0xFF && b[1] === 0xD8) {                        // JPEG
      let p = 2;
      while (p < b.length - 9) {
        if (b[p] !== 0xFF) { p++; continue; }
        const marker = b[p + 1];
        const len = (b[p + 2] << 8) | b[p + 3];
        if (marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC) {
          return { h: (b[p + 5] << 8) | b[p + 6], w: (b[p + 7] << 8) | b[p + 8] };
        }
        p += 2 + len;
      }
      return null;
    }
    if (b[0] === 0x47 && b[1] === 0x49) {                        // GIF
      return { w: b[6] | (b[7] << 8), h: b[8] | (b[9] << 8) };
    }
    return null;
  }

  function imageRuns(url, alt, ctx) {
    const found = ctx.media && ctx.media[url];
    if (!found || !found.data) {
      // Never drop it silently — say what is missing and where it lived.
      const label = alt ? alt + ' — ' : '';
      return [textRun('[image: ' + label, { i: true }),
              hyperlink(url, url, ctx, { i: true }),
              textRun(']', { i: true })];
    }
    const rid = ctx.rel(found.path, false);
    const size = imageSize(found.data) || { w: 600, h: 400 };
    let cx = size.w * EMU_PER_PX, cy = size.h * EMU_PER_PX;
    if (cx > MAX_W_EMU) { cy = Math.round(cy * (MAX_W_EMU / cx)); cx = MAX_W_EMU; }
    const id = ctx.nextDrawingId();
    return ['<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0">' +
      '<wp:extent cx="' + cx + '" cy="' + cy + '"/>' +
      '<wp:docPr id="' + id + '" name="Image' + id + '" descr="' + xml(alt || '') + '"/>' +
      '<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">' +
      '<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
      '<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
      '<pic:nvPicPr><pic:cNvPr id="' + id + '" name="Image' + id + '"/><pic:cNvPicPr/></pic:nvPicPr>' +
      '<pic:blipFill><a:blip r:embed="' + rid + '"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>' +
      '<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="' + cx + '" cy="' + cy + '"/></a:xfrm>' +
      '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>' +
      '</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>'];
  }

  // ---------------------------------------------------------------- blocks

  function para(runsXml, style, extraPr) {
    const pr = (style ? '<w:pStyle w:val="' + style + '"/>' : '') + (extraPr || '');
    return '<w:p>' + (pr ? '<w:pPr>' + pr + '</w:pPr>' : '') + runsXml + '</w:p>';
  }

  function codeBlock(text) {
    // One paragraph per line, kept together, so a fence does not fragment across
    // pages any worse than it has to.
    return String(text).split('\n').map((line) =>
      para(textRun(line || ' ', { mono: true }), 'Code')).join('');
  }

  function tableXml(rows, ctx) {
    if (!rows || !rows.length) return '';
    const width = Math.max.apply(null, rows.map((r) => r.length));
    const cellW = Math.floor(9360 / width);
    const body = rows.map((r, ri) => {
      const cells = [];
      for (let c = 0; c < width; c++) {
        const raw = r[c] == null ? '' : String(r[c]);
        const shade = ri === 0 ? '<w:shd w:val="clear" w:fill="F1F3F5"/>' : '';
        cells.push('<w:tc><w:tcPr><w:tcW w:w="' + cellW + '" w:type="dxa"/>' + shade + '</w:tcPr>' +
          para(inlineRuns(raw, ctx, ri === 0 ? { b: true } : {}).join('') ||
               textRun('', {}), 'TableText') + '</w:tc>');
      }
      return '<w:tr>' + (ri === 0 ? '<w:trPr><w:tblHeader/></w:trPr>' : '') + cells.join('') + '</w:tr>';
    }).join('');
    return '<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/>' +
      '<w:tblW w:w="0" w:type="auto"/>' +
      '<w:tblBorders>' +
      ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map((s) =>
        '<w:' + s + ' w:val="single" w:sz="4" w:space="0" w:color="D0D7DE"/>').join('') +
      '</w:tblBorders></w:tblPr>' + body + '</w:tbl>' + para('', 'Spacer');
  }

  function calloutXml(block, ctx) {
    // Word has no callout. A one-cell shaded table with a coloured left edge is
    // the closest thing that still looks deliberate after a human edits it.
    const emoji = block.emoji || '📘';
    const head = textRun(emoji + ' ', {}) ;
    const bodyRuns = String(block.text || '').split('\n')
      .map((l) => para(inlineRuns(l, ctx, {}).join('') || textRun('', {}), 'CalloutText'))
      .join('');
    return '<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/>' +
      '<w:tblBorders>' +
      '<w:left w:val="single" w:sz="18" w:space="0" w:color="0B5FFF"/>' +
      ['top', 'bottom', 'right', 'insideH', 'insideV'].map((s) =>
        '<w:' + s + ' w:val="single" w:sz="4" w:space="0" w:color="DCE3EA"/>').join('') +
      '</w:tblBorders></w:tblPr><w:tr><w:tc>' +
      '<w:tcPr><w:tcW w:w="9360" w:type="dxa"/><w:shd w:val="clear" w:fill="F5F8FC"/></w:tcPr>' +
      para(head, 'CalloutText') + bodyRuns +
      '</w:tc></w:tr></w:tbl>' + para('', 'Spacer');
  }

  // Markdown pipe table inside an mdxtable/text blob -> rows. Only used for the
  // rare <Table> component; plain tables already arrive as `table` blocks.
  function pipeRows(text) {
    const lines = String(text || '').split('\n').filter((l) => /\|/.test(l));
    const rows = [];
    for (const l of lines) {
      if (/^\s*\|?\s*:?-{2,}/.test(l.replace(/\|/g, ''))) continue;
      const cells = l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      if (cells.length) rows.push(cells);
    }
    return rows;
  }

  function blocksToXml(blocks, ctx) {
    const out = [];
    for (const b of blocks || []) {
      if (!b || b.kind === 'blank' || b.kind === 'toc') continue;
      if (b.kind === 'heading') {
        const lvl = Math.max(1, Math.min(6, b.level || 1));
        out.push(para(inlineRuns(b.text, ctx, {}).join(''), 'Heading' + lvl));
      } else if (b.kind === 'para') {
        const runs = inlineRuns(b.text, ctx, {}).join('');
        if (runs) out.push(para(runs, 'Body'));
      } else if (b.kind === 'list') {
        const lvl = Math.max(0, Math.min(8, b.level || 0));
        const numId = b.ordered ? 2 : 1;
        out.push(para(inlineRuns(String(b.text || '').replace(/<br\s*\/?>/gi, ' ')
          .replace(/\s*\n\s*/g, ' ').trim(), ctx, {}).join(''),
          'ListParagraph',
          '<w:numPr><w:ilvl w:val="' + lvl + '"/><w:numId w:val="' + numId + '"/></w:numPr>'));
      } else if (b.kind === 'code') {
        out.push(codeBlock(b.text));
      } else if (b.kind === 'callout') {
        out.push(calloutXml(b, ctx));
      } else if (b.kind === 'table') {
        out.push(tableXml(b.rows, ctx));
      } else if (b.kind === 'mdxtable') {
        const rows = pipeRows(b.text);
        out.push(rows.length ? tableXml(rows, ctx) : para(textRun(b.text, { mono: true }), 'Code'));
      }
    }
    return out.join('');
  }

  // ---------------------------------------------------------------- document

  const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/><w:sz w:val="22"/></w:rPr></w:rPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:styleId="Normal" w:default="1"><w:name w:val="Normal"/></w:style>
<w:style w:type="paragraph" w:styleId="Body"><w:name w:val="Body Text"/><w:pPr><w:spacing w:before="60" w:after="140" w:line="276" w:lineRule="auto"/></w:pPr></w:style>
<w:style w:type="paragraph" w:styleId="Spacer"><w:name w:val="Spacer"/><w:pPr><w:spacing w:after="120"/></w:pPr><w:rPr><w:sz w:val="8"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:pPr><w:spacing w:after="320"/></w:pPr><w:rPr><w:b/><w:sz w:val="56"/><w:color w:val="0B2A4A"/></w:rPr></w:style>
${[1, 2, 3, 4, 5, 6].map((n) => {
  const sz = [32, 28, 25, 23, 22, 22][n - 1];
  return '<w:style w:type="paragraph" w:styleId="Heading' + n + '"><w:name w:val="heading ' + n +
    '"/><w:basedOn w:val="Normal"/><w:next w:val="Body"/><w:pPr><w:outlineLvl w:val="' + (n - 1) +
    '"/><w:keepNext/><w:spacing w:before="' + (360 - n * 30) + '" w:after="120"/></w:pPr>' +
    '<w:rPr><w:b/><w:sz w:val="' + sz + '"/><w:color w:val="' + (n <= 2 ? '0B2A4A' : '243B53') + '"/></w:rPr></w:style>';
}).join('')}
<w:style w:type="paragraph" w:styleId="Code"><w:name w:val="Code"/><w:pPr><w:shd w:val="clear" w:fill="F6F8FA"/><w:spacing w:after="0" w:line="240" w:lineRule="auto"/><w:ind w:left="180" w:right="180"/></w:pPr><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/><w:sz w:val="18"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="CalloutText"><w:name w:val="Callout Text"/><w:pPr><w:spacing w:before="60" w:after="60"/><w:ind w:left="120" w:right="120"/></w:pPr></w:style>
<w:style w:type="paragraph" w:styleId="TableText"><w:name w:val="Table Text"/><w:pPr><w:spacing w:before="40" w:after="40"/></w:pPr><w:rPr><w:sz w:val="20"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:pPr><w:spacing w:after="60"/><w:contextualSpacing/></w:pPr></w:style>
<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/></w:style>
</w:styles>`;

  const BULLETS = ['\uF0B7', '\uF06F', '\uF0A7'];

  function numbering() {
    const lvls = (fmt) => [0, 1, 2, 3, 4, 5, 6, 7, 8].map((l) =>
      '<w:lvl w:ilvl="' + l + '"><w:start w:val="1"/><w:numFmt w:val="' +
      (fmt === 'bullet' ? 'bullet' : ['decimal', 'lowerLetter', 'lowerRoman'][l % 3]) +
      '"/><w:lvlText w:val="' + (fmt === 'bullet' ? BULLETS[l % 3] : '%' + (l + 1) + '.') +
      '"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="' + (360 + l * 360) + '" w:hanging="360"/></w:pPr>' +
      (fmt === 'bullet' ? '<w:rPr><w:rFonts w:ascii="Symbol" w:hAnsi="Symbol"/></w:rPr>' : '') +
      '</w:lvl>').join('');
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
      '<w:abstractNum w:abstractNumId="1">' + lvls('bullet') + '</w:abstractNum>' +
      '<w:abstractNum w:abstractNumId="2">' + lvls('decimal') + '</w:abstractNum>' +
      '<w:num w:numId="1"><w:abstractNumId w:val="1"/></w:num>' +
      '<w:num w:numId="2"><w:abstractNumId w:val="2"/></w:num>' +
      '</w:numbering>';
  }

  /**
   * Build one .docx.
   *
   * @param {{title:string, pages:Array<{title:string,depth:number,blocks:Array}>}} doc
   * @param {{media?:Object, toc?:boolean}} [opts]  media maps image url -> {data,ext}
   * @returns {Array<{path:string,data:(string|Uint8Array)}>} parts for makeZip()
   */
  function renderDocx(doc, opts) {
    opts = opts || {};
    const media = opts.media || {};
    const rels = [];
    const files = [];
    let drawingId = 1;
    const seenMedia = {};

    const ctx = {
      media,
      nextDrawingId() { return drawingId++; },
      rel(target, external) {
        if (!external && seenMedia[target]) return seenMedia[target];
        const id = 'rId' + (rels.length + 10);
        rels.push('<Relationship Id="' + id + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/' +
          (external ? 'hyperlink" Target="' + xml(target) + '" TargetMode="External"'
                    : 'image" Target="' + xml(target) + '"') + '/>');
        if (!external) seenMedia[target] = id;
        return id;
      },
    };

    // media parts, keyed by url so a repeated screenshot is stored once
    let n = 0;
    for (const url of Object.keys(media)) {
      const m = media[url];
      if (!m || !m.data) continue;
      n++;
      m.path = 'media/image' + n + '.' + (m.ext || 'png');
      files.push({ path: 'word/' + m.path, data: m.data });
    }

    const body = [];
    body.push(para(textRun(doc.title, {}), 'Title'));
    if (opts.toc !== false) {
      // A real TOC field: empty until the reader hits "update field", which is
      // the normal Word contract and beats a hand-built list that goes stale.
      body.push('<w:p><w:pPr><w:pStyle w:val="Body"/></w:pPr>' +
        '<w:r><w:fldChar w:fldCharType="begin"/></w:r>' +
        '<w:r><w:instrText xml:space="preserve"> TOC \\o "1-3" \\h \\z \\u </w:instrText></w:r>' +
        '<w:r><w:fldChar w:fldCharType="separate"/></w:r>' +
        '<w:r><w:t>Right-click and choose “Update Field” to build the table of contents.</w:t></w:r>' +
        '<w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>');
      body.push('<w:p><w:r><w:br w:type="page"/></w:r></w:p>');
    }

    for (const page of doc.pages || []) {
      const lvl = Math.max(1, Math.min(6, page.depth || 1));
      body.push(para(inlineRuns(page.title, ctx, {}).join(''), 'Heading' + lvl));
      body.push(blocksToXml(page.blocks, ctx));
    }

    const document = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
      'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
      'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing">' +
      '<w:body>' + body.join('') +
      '<w:sectPr><w:pgSz w:w="12240" w:h="15840"/>' +
      '<w:pgMar w:top="1440" w:right="1080" w:bottom="1440" w:left="1080" w:header="720" w:footer="720"/>' +
      '</w:sectPr></w:body></w:document>';

    const exts = {};
    Object.keys(media).forEach((u) => { if (media[u] && media[u].ext) exts[media[u].ext] = true; });
    const defaults = ['<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
      '<Default Extension="xml" ContentType="application/xml"/>']
      .concat(Object.keys(exts).map((e) =>
        '<Default Extension="' + e + '" ContentType="image/' + (e === 'jpg' ? 'jpeg' : e) + '"/>'));

    files.push({ path: '[Content_Types].xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' + defaults.join('') +
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
      '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
      '<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>' +
      '</Types>' });

    files.push({ path: '_rels/.rels', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
      '</Relationships>' });

    files.push({ path: 'word/_rels/document.xml.rels', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
      '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>' +
      rels.join('') + '</Relationships>' });

    files.push({ path: 'word/styles.xml', data: STYLES });
    files.push({ path: 'word/numbering.xml', data: numbering() });
    files.push({ path: 'word/document.xml', data: document });
    return files;
  }

  root.docxRender = { renderDocx, imageSize, inlineRuns, pipeRows };
}(typeof window !== 'undefined' ? window : globalThis));
