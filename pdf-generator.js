'use strict';

const PDFDocument = require('pdfkit');
const path = require('path');

const MARGIN = 50;
const PAGE_WIDTH = 595.28; // A4
const PAGE_HEIGHT = 841.89;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;

const COLORS = {
  primary:      '#1E3A5F', // navy brand
  accent:       '#2E86AB', // medium blue
  lightBlue:    '#EBF4FA', // section background
  sectionBg:    '#F0F4F8', // alternate background
  tableHeader:  '#1E3A5F', // table header
  tableAlt:     '#F8FBFF', // alternate table row
  riskLow:      '#27AE60', // R≤3 green
  riskMedium:   '#F39C12', // R 4-8 amber
  riskHigh:     '#E67E22', // R 9-12 orange
  riskVeryHigh: '#E74C3C', // R>12 red
  text:         '#2C3E50',
  textGray:     '#7F8C8D',
  white:        '#FFFFFF',
  line:         '#BDC3C7'
};

const FONT_PATH = path.join(__dirname, 'fonts');
const FONT_REGULAR = path.join(FONT_PATH, 'Inter-Regular.ttf');
const FONT_BOLD = path.join(FONT_PATH, 'Inter-Bold.ttf');

const SIGNATURES = [
  "Datore di Lavoro dell'impresa esecutrice",
  'RSPP',
  'RLS',
  'Medico Competente',
  'CSE (per presa visione)'
];

// ─── HELPER: Cell height measurement ─────────────────────────────────────────
function measureCellHeight(doc, text, colWidth, padH, padV) {
  doc.font('Inter').fontSize(9);
  const h = doc.heightOfString(text.replace(/\*\*/g, ''), {
    width: colWidth - padH * 2
  });
  return Math.max(h + padV * 2, 22);
}

// ─── HELPER: Detect table type ────────────────────────────────────────────────
function detectTableType(headerCells) {
  const joined = headerCells.join(' ');
  if (/r\s*\(p\s*x\s*d\)|probabilit|livello\s*di\s*rischio|^[PD]$/i.test(joined)) return 'risk';
  if (/cartello|segnale|pittogramma/i.test(joined)) return 'segnaletica';
  return 'default';
}

// ─── HELPER: Risk color from numeric value ────────────────────────────────────
function getRiskColor(rValue) {
  const n = parseFloat(String(rValue).replace(',', '.'));
  if (isNaN(n)) return null;
  if (n <= 3) return COLORS.riskLow;
  if (n <= 8) return COLORS.riskMedium;
  if (n <= 12) return COLORS.riskHigh;
  return COLORS.riskVeryHigh;
}

// ─── HELPER: Color for livello text ───────────────────────────────────────────
function getLivelloColor(text) {
  const t = text.toLowerCase();
  if (t.includes('molto alto') || t.includes('intollerabile') || t.includes('critico')) return COLORS.riskVeryHigh;
  if (t.includes('alto') || t.includes('rilevante')) return COLORS.riskHigh;
  if (t.includes('medio') || t.includes('moderato')) return COLORS.riskMedium;
  if (t.includes('basso') || t.includes('accettabile') || t.includes('trascurabile')) return COLORS.riskLow;
  return null;
}

// ─── HELPER: Draw colored badge for risk value ────────────────────────────────
function drawRiskBadge(doc, value, cellX, rowY, colW, rowH) {
  const color = getRiskColor(value);
  if (!color) return;
  const bw = 30, bh = 16;
  const bx = cellX + (colW - bw) / 2;
  const by = rowY + (rowH - bh) / 2;
  doc.save();
  doc.roundedRect(bx, by, bw, bh, 4).fillColor(color).fill();
  doc.font('Inter-Bold').fontSize(8).fillColor(COLORS.white);
  doc.text(String(value), bx, by + 3, { width: bw, align: 'center' });
  doc.restore();
  // Reset font/color after restore
  doc.font('Inter').fontSize(9).fillColor(COLORS.text);
}

// ─── HELPER: Draw segnaletica pictogram ───────────────────────────────────────
function drawSegnaleticaSign(doc, code, cellX, cy) {
  const prefix = (code || '').trim().charAt(0).toUpperCase();
  const iconCx = cellX + 13;
  const r = 9;

  doc.save();
  switch (prefix) {
    case 'P': // Divieto – red circle
      doc.circle(iconCx, cy, r).fillColor('#E74C3C').fill();
      doc.circle(iconCx, cy, r).strokeColor('#C0392B').lineWidth(1.5).stroke();
      break;
    case 'W': // Avvertimento – yellow triangle
      doc.polygon(
        [iconCx, cy - r],
        [iconCx + r * 1.1, cy + r * 0.75],
        [iconCx - r * 1.1, cy + r * 0.75]
      ).fillColor('#F39C12').fill();
      doc.polygon(
        [iconCx, cy - r],
        [iconCx + r * 1.1, cy + r * 0.75],
        [iconCx - r * 1.1, cy + r * 0.75]
      ).strokeColor('#D68910').lineWidth(1.5).stroke();
      break;
    case 'M': // Obbligo – blue circle
      doc.circle(iconCx, cy, r).fillColor('#2E86AB').fill();
      doc.circle(iconCx, cy, r).strokeColor('#1A6A8A').lineWidth(1.5).stroke();
      break;
    case 'E': // Salvataggio – green rect
      doc.roundedRect(iconCx - r, cy - r * 0.65, r * 2, r * 1.3, 2).fillColor('#27AE60').fill();
      break;
    case 'F': // Antincendio – red rect
      doc.roundedRect(iconCx - r, cy - r * 0.65, r * 2, r * 1.3, 2).fillColor('#E74C3C').fill();
      break;
    default:
      doc.roundedRect(iconCx - r, cy - r * 0.65, r * 2, r * 1.3, 2).fillColor(COLORS.textGray).fill();
  }
  doc.restore();
  // Reset after restore
  doc.font('Inter').fontSize(9).fillColor(COLORS.text);
}

// ─── SECTION HEADER (## SEZIONE N - ...) ─────────────────────────────────────
function renderSectionHeader(doc, text) {
  const match = text.match(/^SEZIONE\s+(\d+)\s*[-:]\s*(.+)$/i);
  const sectionNum = match ? match[1] : '';
  const sectionTitle = match ? match[2].trim() : text;

  if (doc.y > PAGE_HEIGHT - 80) doc.addPage();

  doc.moveDown(0.8);
  const boxY = doc.y;
  const boxH = 32;

  // Light blue background + left border navy 4px
  doc.save();
  doc.rect(MARGIN, boxY, CONTENT_WIDTH, boxH).fillColor(COLORS.lightBlue).fill();
  doc.rect(MARGIN, boxY, 4, boxH).fillColor(COLORS.primary).fill();
  doc.restore();

  // Badge circle with section number
  const badgeX = MARGIN + 22;
  const badgeY = boxY + boxH / 2;
  const badgeR = 10;
  doc.save();
  doc.circle(badgeX, badgeY, badgeR).fillColor(COLORS.primary).fill();
  doc.font('Inter-Bold').fontSize(9).fillColor(COLORS.white);
  doc.text(sectionNum, badgeX - badgeR, badgeY - 5, { width: badgeR * 2, align: 'center' });
  doc.restore();

  // Title
  doc.font('Inter-Bold').fontSize(11).fillColor(COLORS.primary);
  doc.text(sectionTitle.toUpperCase(), MARGIN + 40, boxY + 10, { width: CONTENT_WIDTH - 44 });

  doc.y = boxY + boxH + 8;
}

// ─── SUB-HEADING (## non-SEZIONE) ─────────────────────────────────────────────
function renderSubHeading(doc, text) {
  if (doc.y > PAGE_HEIGHT - 80) doc.addPage();

  doc.moveDown(0.8);
  const headY = doc.y;
  doc.font('Inter-Bold').fontSize(13).fillColor(COLORS.primary);
  doc.text(text, MARGIN, headY, { width: CONTENT_WIDTH });

  const lineY = doc.y + 1;
  doc.moveTo(MARGIN, lineY)
    .lineTo(MARGIN + 80, lineY)
    .strokeColor(COLORS.accent)
    .lineWidth(1.5)
    .stroke();

  doc.y = lineY + 8;
}

// ─── BULLET POINT ─────────────────────────────────────────────────────────────
function renderBullet(doc, text) {
  if (doc.y > PAGE_HEIGHT - 60) doc.addPage();

  const bulletX = MARGIN + 10;
  const textX = MARGIN + 24;
  const textW = CONTENT_WIDTH - 24;
  const bulletCY = doc.y + 6; // approximate center of first text line

  doc.save();
  doc.circle(bulletX, bulletCY, 3).fillColor(COLORS.primary).fill();
  doc.restore();

  doc.font('Inter').fontSize(10).fillColor(COLORS.text);
  renderRichText(doc, text, textX, doc.y, textW);
  doc.moveDown(0.2);
}

// ─── TABLE ROW DRAWING ────────────────────────────────────────────────────────
function drawTableRow(doc, cells, colWidths, rowY, rowH, isHeader, dataRowIdx, tableType, headerCells) {
  const padH = 6;
  const padV = 5;

  // Row background
  doc.save();
  if (isHeader) {
    doc.rect(MARGIN, rowY, CONTENT_WIDTH, rowH).fillColor(COLORS.tableHeader).fill();
  } else if (dataRowIdx % 2 === 0) {
    doc.rect(MARGIN, rowY, CONTENT_WIDTH, rowH).fillColor(COLORS.tableAlt).fill();
  } else {
    doc.rect(MARGIN, rowY, CONTENT_WIDTH, rowH).fillColor(COLORS.white).fill();
  }
  doc.restore();

  // Outer border
  doc.save();
  doc.rect(MARGIN, rowY, CONTENT_WIDTH, rowH).strokeColor(COLORS.line).lineWidth(0.5).stroke();
  doc.restore();

  // Vertical column dividers
  doc.save();
  let xOff = MARGIN;
  for (let ci = 0; ci < colWidths.length - 1; ci++) {
    xOff += colWidths[ci];
    doc.moveTo(xOff, rowY).lineTo(xOff, rowY + rowH).strokeColor(COLORS.line).lineWidth(0.5).stroke();
  }
  doc.restore();

  // Find risk value column index for row-level tinting
  let rColIdx = -1;
  if (tableType === 'risk') {
    rColIdx = headerCells.findIndex(h => /r\s*[\(=]|^r$/i.test(h.trim()));
  }

  // Cell content
  let cellX = MARGIN;
  for (let ci = 0; ci < cells.length; ci++) {
    const cellText = (cells[ci] || '').trim().replace(/\*\*/g, '');
    const cw = colWidths[ci];
    const cellMidY = rowY + rowH / 2;

    if (isHeader) {
      doc.font('Inter-Bold').fontSize(9).fillColor(COLORS.white);
      doc.text(cellText, cellX + padH, rowY + padV, { width: cw - padH * 2, align: 'left' });
    } else {
      const headerName = (headerCells[ci] || '').toLowerCase().trim();
      const isRiskValueCol = /r\s*[\(=]|^r$/i.test(headerName);
      const isLivelloCol = /livello/i.test(headerName);
      const isSegnaleticaFirst = ci === 0 && tableType === 'segnaletica';

      // Left accent bar for risk rows (first column only, risk tables)
      if (tableType === 'risk' && ci === 0 && rColIdx >= 0 && cells[rColIdx]) {
        const rColor = getRiskColor(cells[rColIdx].trim());
        if (rColor) {
          doc.save();
          doc.rect(MARGIN, rowY, 3, rowH).fillColor(rColor).fill();
          doc.restore();
        }
      }

      if (isSegnaleticaFirst && /^[PWMEF]\d*/i.test(cellText)) {
        // Draw pictogram + code
        drawSegnaleticaSign(doc, cellText, cellX, cellMidY);
        doc.font('Inter').fontSize(8).fillColor(COLORS.text);
        doc.text(cellText, cellX + 28, rowY + padV, { width: cw - 32 });

      } else if (isRiskValueCol && /^\d+([,.]\d+)?$/.test(cellText)) {
        drawRiskBadge(doc, cellText, cellX, rowY, cw, rowH);

      } else if (isLivelloCol) {
        const lvlColor = getLivelloColor(cellText);
        if (lvlColor) {
          doc.save();
          doc.rect(cellX + 2, rowY + 2, cw - 4, rowH - 4).fillColor(lvlColor).fillOpacity(0.18).fill();
          doc.restore();
          doc.font('Inter-Bold').fontSize(9).fillColor(lvlColor);
          doc.text(cellText, cellX + padH, rowY + padV, { width: cw - padH * 2, align: 'center' });
        } else {
          doc.font('Inter').fontSize(9).fillColor(COLORS.text);
          doc.text(cellText, cellX + padH, rowY + padV, { width: cw - padH * 2 });
        }

      } else {
        doc.font('Inter').fontSize(9).fillColor(COLORS.text);
        doc.text(cellText, cellX + padH, rowY + padV, { width: cw - padH * 2, lineGap: 1 });
      }
    }
    cellX += cw;
  }
}

// ─── TABLE RENDERING ──────────────────────────────────────────────────────────
function renderTable(doc, rows) {
  // Filter separator lines (only dashes/colons)
  const dataRows = rows.filter(r => {
    const cells = r.split('|').filter(c => c.trim() !== '');
    return !cells.every(c => /^[\s\-:]+$/.test(c));
  });

  if (dataRows.length === 0) return;

  const headerCells = dataRows[0]
    .split('|')
    .filter(c => c.trim() !== '')
    .map(c => c.trim().replace(/\*\*/g, ''));

  const numCols = headerCells.length;
  const colW = CONTENT_WIDTH / numCols;
  const colWidths = Array(numCols).fill(colW);
  const tableType = detectTableType(headerCells);
  const padH = 6, padV = 5;

  // Pre-measure row heights
  const rowHeights = dataRows.map((row, ri) => {
    if (ri === 0) return 26; // fixed header height
    const cells = row.split('|').filter(c => c.trim() !== '');
    let maxH = 22;
    for (let ci = 0; ci < cells.length; ci++) {
      const txt = (cells[ci] || '').trim().replace(/\*\*/g, '');
      const h = measureCellHeight(doc, txt, colWidths[ci], padH, padV);
      if (h > maxH) maxH = h;
    }
    return maxH;
  });

  if (doc.y > PAGE_HEIGHT - 100) doc.addPage();
  doc.moveDown(0.3);

  let currentY = doc.y;
  let dataRowIdx = 0;

  for (let ri = 0; ri < dataRows.length; ri++) {
    const cells = dataRows[ri].split('|').filter(c => c.trim() !== '');
    const isHeader = ri === 0;
    const rowH = rowHeights[ri];

    // Page break for data rows
    if (!isHeader && currentY + rowH > PAGE_HEIGHT - 70) {
      doc.addPage();
      currentY = doc.y;
      // Re-draw header on new page
      const hdrCells = dataRows[0].split('|').filter(c => c.trim() !== '');
      drawTableRow(doc, hdrCells, colWidths, currentY, rowHeights[0], true, 0, tableType, headerCells);
      currentY += rowHeights[0];
    }

    drawTableRow(doc, cells, colWidths, currentY, rowH, isHeader, dataRowIdx, tableType, headerCells);
    if (!isHeader) dataRowIdx++;
    currentY += rowH;
  }

  doc.y = currentY;
  doc.moveDown(0.5);
}

// ─── RICH TEXT (inline bold) ──────────────────────────────────────────────────
function renderRichText(doc, text, x, y, width) {
  const parts = text.split(/(\*\*[^*]+\*\*)/).filter(Boolean);
  if (parts.length === 1) {
    doc.font('Inter').fontSize(10).fillColor(COLORS.text);
    doc.text(text, x, y, { width, lineGap: 2 });
    return;
  }
  let first = true;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const isBold = part.startsWith('**') && part.endsWith('**');
    const cleanText = isBold ? part.slice(2, -2) : part;
    const isLast = i === parts.length - 1;
    doc.font(isBold ? 'Inter-Bold' : 'Inter').fontSize(10).fillColor(COLORS.text);
    if (first) {
      doc.text(cleanText, x, y, { width, lineGap: 2, continued: !isLast });
      first = false;
    } else {
      doc.text(cleanText, { continued: !isLast });
    }
  }
}

// ─── COVER PAGE ───────────────────────────────────────────────────────────────
function renderCoverPage(doc, siteName, revision, posData) {
  // Full page light blue background
  doc.save();
  doc.rect(0, 0, PAGE_WIDTH, PAGE_HEIGHT).fillColor(COLORS.lightBlue).fill();
  doc.restore();

  // Navy band at top (h=130)
  const bandH = 130;
  doc.save();
  doc.rect(0, 0, PAGE_WIDTH, bandH).fillColor(COLORS.primary).fill();
  doc.restore();

  // "PALLADIA" in white
  doc.font('Inter-Bold').fontSize(38).fillColor(COLORS.white);
  doc.text('PALLADIA', 0, 26, { width: PAGE_WIDTH, align: 'center', characterSpacing: 14 });

  // Subtitle lines in white
  doc.font('Inter').fontSize(13).fillColor(COLORS.white);
  doc.text('Piano Operativo di Sicurezza', 0, 74, { width: PAGE_WIDTH, align: 'center' });
  doc.font('Inter').fontSize(10).fillColor(COLORS.white);
  doc.text('ai sensi D.lgs 81/2008 e s.m.i.', 0, 94, { width: PAGE_WIDTH, align: 'center' });

  // Rev badge below band
  const badgeW = 90, badgeH = 26;
  const badgeX = (PAGE_WIDTH - badgeW) / 2;
  const badgeY = bandH + 18;
  doc.save();
  doc.roundedRect(badgeX, badgeY, badgeW, badgeH, 6).fillColor(COLORS.accent).fill();
  doc.font('Inter-Bold').fontSize(11).fillColor(COLORS.white);
  doc.text(`Rev. ${revision}`, badgeX, badgeY + 7, { width: badgeW, align: 'center' });
  doc.restore();

  // Navy divider
  const divY = badgeY + badgeH + 18;
  doc.moveTo(MARGIN + 40, divY)
    .lineTo(PAGE_WIDTH - MARGIN - 40, divY)
    .strokeColor(COLORS.primary)
    .lineWidth(1.5)
    .stroke();

  // Info box
  const infoItems = [
    ['Cantiere',          siteName],
    ['Indirizzo',         posData.siteAddress],
    ['Committente',       posData.client],
    ['Natura lavori',     posData.workType],
    ['Impresa esecutrice',posData.companyName],
    ['P.IVA',            posData.companyVat],
    ['Periodo',           posData.startDate && posData.endDate
                            ? `${posData.startDate} – ${posData.endDate}` : null]
  ].filter(([, v]) => v && v !== 'N/A');

  if (infoItems.length > 0) {
    const boxX = MARGIN + 20;
    const boxW = CONTENT_WIDTH - 40;
    const padBox = 14;
    const lineH = 24;
    const boxH = padBox * 2 + infoItems.length * lineH;
    const boxY = divY + 18;

    // Gray-blue box with left navy border 4px
    doc.save();
    doc.roundedRect(boxX, boxY, boxW, boxH, 4).fillColor(COLORS.sectionBg).fill();
    doc.rect(boxX, boxY, 4, boxH).fillColor(COLORS.primary).fill();
    doc.restore();

    let textY = boxY + padBox;
    for (const [label, value] of infoItems) {
      doc.font('Inter-Bold').fontSize(10).fillColor(COLORS.primary);
      doc.text(`${label}: `, boxX + 14, textY, { continued: true, width: boxW - 20 });
      doc.font('Inter').fontSize(10).fillColor(COLORS.text);
      doc.text(value, { continued: false });
      textY += lineH;
    }
  }

  // Navy strip at bottom with date
  const stripH = 36;
  doc.save();
  doc.rect(0, PAGE_HEIGHT - stripH, PAGE_WIDTH, stripH).fillColor(COLORS.primary).fill();
  doc.font('Inter').fontSize(9).fillColor(COLORS.white);
  doc.text(
    `Documento emesso il ${new Date().toLocaleDateString('it-IT')}`,
    0, PAGE_HEIGHT - stripH + 12,
    { width: PAGE_WIDTH, align: 'center' }
  );
  doc.restore();
}

// ─── CONTENT RENDERING ────────────────────────────────────────────────────────
function renderContent(doc, content) {
  const lines = content.split('\n');
  let inTable = false;
  let tableRows = [];

  for (let idx = 0; idx < lines.length; idx++) {
    const trimmed = lines[idx].trim();

    // Collect table rows
    if (trimmed.startsWith('|') && trimmed.endsWith('|')) {
      if (!inTable) { inTable = true; tableRows = []; }
      tableRows.push(trimmed);
      continue;
    } else if (inTable) {
      inTable = false;
      renderTable(doc, tableRows);
      tableRows = [];
    }

    if (!trimmed) {
      doc.moveDown(0.4);
      continue;
    }

    if (doc.y > PAGE_HEIGHT - 100) doc.addPage();

    if (trimmed.startsWith('# ')) {
      // H1 – major title
      doc.moveDown(1.5);
      doc.font('Inter-Bold').fontSize(16).fillColor(COLORS.primary);
      doc.text(trimmed.slice(2), MARGIN, doc.y, { width: CONTENT_WIDTH });
      doc.moveDown(0.3);
      doc.moveTo(MARGIN, doc.y)
        .lineTo(PAGE_WIDTH - MARGIN, doc.y)
        .strokeColor(COLORS.accent).lineWidth(1.5).stroke();
      doc.moveDown(0.8);

    } else if (trimmed.startsWith('## ')) {
      const headingText = trimmed.slice(3).trim();
      if (/^SEZIONE\s+\d+/i.test(headingText)) {
        renderSectionHeader(doc, headingText);
      } else {
        renderSubHeading(doc, headingText);
      }

    } else if (trimmed.startsWith('### ')) {
      doc.moveDown(0.6);
      doc.font('Inter-Bold').fontSize(11).fillColor(COLORS.primary);
      doc.text(trimmed.slice(4), MARGIN, doc.y, { width: CONTENT_WIDTH });
      doc.moveDown(0.4);

    } else if (/^\d+\.\s+[A-ZÀÈÉÌÒÙ]/.test(trimmed) && trimmed === trimmed.toUpperCase()) {
      // Numbered uppercase section
      doc.moveDown(1.5);
      doc.font('Inter-Bold').fontSize(14).fillColor(COLORS.primary);
      doc.text(trimmed, MARGIN, doc.y, { width: CONTENT_WIDTH });
      doc.moveDown(0.3);
      doc.moveTo(MARGIN, doc.y)
        .lineTo(PAGE_WIDTH - MARGIN, doc.y)
        .strokeColor(COLORS.accent).lineWidth(1).stroke();
      doc.moveDown(0.5);

    } else if (/^[A-ZÀÈÉÌÒÙ\s]{5,}$/.test(trimmed) && !trimmed.startsWith('-')) {
      // All-caps heading
      doc.moveDown(0.8);
      doc.font('Inter-Bold').fontSize(12).fillColor(COLORS.primary);
      doc.text(trimmed, MARGIN, doc.y, { width: CONTENT_WIDTH });
      doc.moveDown(0.4);

    } else if (trimmed.startsWith('- ') || trimmed.startsWith('• ')) {
      renderBullet(doc, trimmed.slice(2));

    } else if (/^\d+\.\d+/.test(trimmed)) {
      doc.moveDown(0.3);
      doc.font('Inter-Bold').fontSize(11).fillColor(COLORS.text);
      doc.text(trimmed, MARGIN + 10, doc.y, { width: CONTENT_WIDTH - 10 });
      doc.moveDown(0.2);

    } else if (trimmed.includes('_________________')) {
      renderSignatureLine(doc, trimmed);

    } else {
      doc.font('Inter').fontSize(10).fillColor(COLORS.text);
      renderRichText(doc, trimmed, MARGIN, doc.y, CONTENT_WIDTH);
      doc.moveDown(0.2);
    }
  }

  // Flush trailing table
  if (inTable && tableRows.length > 0) {
    renderTable(doc, tableRows);
  }
}

// ─── SIGNATURE LINE (inline, from content) ────────────────────────────────────
function renderSignatureLine(doc, text) {
  doc.moveDown(0.5);
  const rolePart = text.split(':')[0] || text.split('_')[0];
  const role = rolePart.replace(/^[-•\s*]+/, '').trim();

  if (doc.y > PAGE_HEIGHT - 100) doc.addPage();

  const boxY = doc.y;
  const boxH = 80;

  // Box with left border navy 3px
  doc.save();
  doc.roundedRect(MARGIN, boxY, CONTENT_WIDTH, boxH, 3).fillColor(COLORS.sectionBg).fill();
  doc.rect(MARGIN, boxY, 3, boxH).fillColor(COLORS.primary).fill();
  doc.restore();

  doc.font('Inter-Bold').fontSize(11).fillColor(COLORS.primary);
  doc.text(role, MARGIN + 14, boxY + 10, { width: CONTENT_WIDTH - 20 });

  const lineStartY = boxY + 32;
  const labelW = 42;
  const lineLen = 140;
  const gap = 20;

  doc.font('Inter').fontSize(8).fillColor(COLORS.textGray);

  doc.text('Nome', MARGIN + 14, lineStartY);
  doc.moveTo(MARGIN + 14 + labelW, lineStartY + 10)
    .lineTo(MARGIN + 14 + labelW + lineLen, lineStartY + 10)
    .strokeColor(COLORS.line).lineWidth(0.5).stroke();

  const firmaX = MARGIN + 14 + labelW + lineLen + gap;
  doc.text('Firma', firmaX, lineStartY);
  doc.moveTo(firmaX + labelW, lineStartY + 10)
    .lineTo(firmaX + labelW + lineLen, lineStartY + 10)
    .strokeColor(COLORS.line).lineWidth(0.5).stroke();

  doc.text('Data', MARGIN + 14, lineStartY + 26);
  doc.moveTo(MARGIN + 14 + labelW, lineStartY + 36)
    .lineTo(MARGIN + 14 + labelW + lineLen, lineStartY + 36)
    .strokeColor(COLORS.line).lineWidth(0.5).stroke();

  doc.y = boxY + boxH + 10;
}

// ─── SIGNATURE PAGE ───────────────────────────────────────────────────────────
function renderSignatures(doc) {
  doc.moveDown(1);
  const boxY = doc.y;
  const boxH = 32;

  // Section header style for FIRME
  doc.save();
  doc.rect(MARGIN, boxY, CONTENT_WIDTH, boxH).fillColor(COLORS.lightBlue).fill();
  doc.rect(MARGIN, boxY, 4, boxH).fillColor(COLORS.primary).fill();
  doc.restore();

  doc.font('Inter-Bold').fontSize(13).fillColor(COLORS.primary);
  doc.text('FIRME E APPROVAZIONE', MARGIN + 14, boxY + 9, { width: CONTENT_WIDTH - 20 });
  doc.y = boxY + boxH + 16;

  for (const role of SIGNATURES) {
    if (doc.y > PAGE_HEIGHT - 140) doc.addPage();

    const sigBoxY = doc.y;
    const sigBoxH = 95;

    doc.save();
    doc.roundedRect(MARGIN, sigBoxY, CONTENT_WIDTH, sigBoxH, 3).fillColor(COLORS.sectionBg).fill();
    doc.rect(MARGIN, sigBoxY, 3, sigBoxH).fillColor(COLORS.primary).fill();
    doc.restore();

    doc.font('Inter-Bold').fontSize(11).fillColor(COLORS.primary);
    doc.text(role, MARGIN + 16, sigBoxY + 12, { width: CONTENT_WIDTH - 30 });

    const lineStartY = sigBoxY + 36;
    const labelW = 42;
    const lineLen = 150;
    const gap = 25;

    doc.font('Inter').fontSize(9).fillColor(COLORS.textGray);

    doc.text('Nome', MARGIN + 16, lineStartY);
    doc.moveTo(MARGIN + 16 + labelW, lineStartY + 12)
      .lineTo(MARGIN + 16 + labelW + lineLen, lineStartY + 12)
      .strokeColor(COLORS.line).lineWidth(0.5).stroke();

    const firmaX = MARGIN + 16 + labelW + lineLen + gap;
    doc.text('Firma', firmaX, lineStartY);
    doc.moveTo(firmaX + labelW, lineStartY + 12)
      .lineTo(firmaX + labelW + lineLen, lineStartY + 12)
      .strokeColor(COLORS.line).lineWidth(0.5).stroke();

    doc.text('Data', MARGIN + 16, lineStartY + 30);
    doc.moveTo(MARGIN + 16 + labelW, lineStartY + 42)
      .lineTo(MARGIN + 16 + labelW + lineLen, lineStartY + 42)
      .strokeColor(COLORS.line).lineWidth(0.5).stroke();

    doc.y = sigBoxY + sigBoxH + 15;
  }
}

// ─── MAIN ENTRY POINT ─────────────────────────────────────────────────────────
function generatePdf(content, options = {}) {
  const { siteName = 'Cantiere', revision = 1, posData = {} } = options;

  const doc = new PDFDocument({
    size: 'A4',
    margins: { top: 80, bottom: 70, left: MARGIN, right: MARGIN },
    bufferPages: true,
    info: {
      Title: `POS - ${siteName} - Rev. ${revision}`,
      Author: 'Palladia',
      Subject: 'Piano Operativo di Sicurezza'
    }
  });

  doc.registerFont('Inter', FONT_REGULAR);
  doc.registerFont('Inter-Bold', FONT_BOLD);

  // Cover page
  renderCoverPage(doc, siteName, revision, posData);

  // Content pages
  doc.addPage();
  renderContent(doc, content);

  // Signature page (unless content already has one)
  if (!content.includes('FIRME')) {
    doc.addPage();
    renderSignatures(doc);
  }

  // Headers and footers on all pages
  const totalPages = doc.bufferedPageRange().count;
  const docTitle = `POS – ${siteName} – Rev. ${revision}`;

  for (let i = 0; i < totalPages; i++) {
    doc.switchToPage(i);

    // Header (skip cover page)
    if (i > 0) {
      doc.save();
      doc.font('Inter-Bold').fontSize(9).fillColor(COLORS.primary);
      doc.text('PALLADIA', MARGIN, 20);
      doc.font('Inter').fontSize(8).fillColor(COLORS.textGray);
      doc.text(docTitle, MARGIN, 20, { width: CONTENT_WIDTH, align: 'right' });
      doc.moveTo(MARGIN, 36)
        .lineTo(PAGE_WIDTH - MARGIN, 36)
        .strokeColor(COLORS.accent)
        .lineWidth(1)
        .stroke();
      doc.restore();
    }

    // Footer
    doc.save();
    doc.moveTo(MARGIN, PAGE_HEIGHT - 50)
      .lineTo(PAGE_WIDTH - MARGIN, PAGE_HEIGHT - 50)
      .strokeColor(COLORS.primary)
      .lineWidth(1)
      .stroke();

    // Page X/Y – navy left
    doc.font('Inter-Bold').fontSize(8).fillColor(COLORS.primary);
    doc.text(`Pagina ${i + 1} di ${totalPages}`, MARGIN, PAGE_HEIGHT - 38, {
      width: CONTENT_WIDTH / 3,
      align: 'left'
    });

    // Doc name – gray center
    doc.font('Inter').fontSize(8).fillColor(COLORS.textGray);
    doc.text(docTitle, MARGIN + CONTENT_WIDTH / 3, PAGE_HEIGHT - 38, {
      width: CONTENT_WIDTH / 3,
      align: 'center'
    });

    // "Riservato" – gray right
    doc.font('Inter').fontSize(8).fillColor(COLORS.textGray);
    doc.text('Riservato', MARGIN + (CONTENT_WIDTH * 2) / 3, PAGE_HEIGHT - 38, {
      width: CONTENT_WIDTH / 3,
      align: 'right'
    });

    doc.restore();
  }

  return doc;
}

module.exports = { generatePdf };
