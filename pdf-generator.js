const PDFDocument = require('pdfkit');

const MARGIN = 50;
const PAGE_WIDTH = 595.28; // A4
const PAGE_HEIGHT = 841.89;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;

const COLORS = {
  primary: '#1a237e',
  text: '#333333',
  lightGray: '#666666',
  line: '#cccccc'
};

const SIGNATURES = [
  'Datore di Lavoro dell\'impresa esecutrice',
  'RSPP',
  'RLS',
  'Medico Competente',
  'CSE (per presa visione)'
];

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

  // --- Cover page ---
  renderCoverPage(doc, siteName, revision, posData);

  // --- Content pages ---
  doc.addPage();
  renderContent(doc, content);

  // --- Signature page (if not already in content) ---
  if (!content.includes('FIRME')) {
    doc.addPage();
    renderSignatures(doc);
  }

  // --- Add headers and footers to all pages ---
  const totalPages = doc.bufferedPageRange().count;
  for (let i = 0; i < totalPages; i++) {
    doc.switchToPage(i);

    // Header (skip cover page)
    if (i > 0) {
      doc.save();
      doc.fontSize(8).fillColor(COLORS.lightGray);
      doc.text(
        `POS - ${siteName} - Rev. ${revision}`,
        MARGIN, 20,
        { width: CONTENT_WIDTH, align: 'center' }
      );
      doc.moveTo(MARGIN, 40).lineTo(PAGE_WIDTH - MARGIN, 40).strokeColor(COLORS.line).stroke();
      doc.restore();
    }

    // Footer
    doc.save();
    doc.moveTo(MARGIN, PAGE_HEIGHT - 50).lineTo(PAGE_WIDTH - MARGIN, PAGE_HEIGHT - 50).strokeColor(COLORS.line).stroke();
    doc.fontSize(8).fillColor(COLORS.lightGray);
    doc.text(
      `Pagina ${i + 1} di ${totalPages}`,
      MARGIN, PAGE_HEIGHT - 40,
      { width: CONTENT_WIDTH / 2, align: 'left' }
    );
    doc.text(
      'Generato con Palladia',
      MARGIN + CONTENT_WIDTH / 2, PAGE_HEIGHT - 40,
      { width: CONTENT_WIDTH / 2, align: 'right' }
    );
    doc.restore();
  }

  return doc;
}

function renderCoverPage(doc, siteName, revision, posData) {
  // Title block
  doc.moveDown(6);
  doc.fontSize(28).fillColor(COLORS.primary).font('Helvetica-Bold');
  doc.text('PIANO OPERATIVO', MARGIN, doc.y, { width: CONTENT_WIDTH, align: 'center' });
  doc.text('DI SICUREZZA', { width: CONTENT_WIDTH, align: 'center' });

  doc.moveDown(0.5);
  doc.fontSize(14).fillColor(COLORS.lightGray).font('Helvetica');
  doc.text('ai sensi del D.lgs 81/2008 e s.m.i.', { width: CONTENT_WIDTH, align: 'center' });

  doc.moveDown(1);
  doc.fontSize(16).fillColor(COLORS.primary).font('Helvetica-Bold');
  doc.text(`Revisione ${revision}`, { width: CONTENT_WIDTH, align: 'center' });

  // Divider
  doc.moveDown(2);
  doc.moveTo(MARGIN + 100, doc.y).lineTo(PAGE_WIDTH - MARGIN - 100, doc.y).strokeColor(COLORS.primary).lineWidth(2).stroke();
  doc.moveDown(2);

  // Site info block
  doc.fontSize(12).fillColor(COLORS.text).font('Helvetica');
  const infoItems = [
    ['Cantiere', siteName],
    ['Indirizzo', posData.siteAddress],
    ['Committente', posData.client],
    ['Natura lavori', posData.workType],
    ['Impresa esecutrice', posData.companyName],
    ['P.IVA', posData.companyVat],
    ['Periodo', posData.startDate && posData.endDate ? `${posData.startDate} - ${posData.endDate}` : null],
  ];

  for (const [label, value] of infoItems) {
    if (value && value !== 'N/A') {
      doc.font('Helvetica-Bold').text(`${label}: `, MARGIN + 60, doc.y, { continued: true });
      doc.font('Helvetica').text(value);
      doc.moveDown(0.3);
    }
  }

  // Date
  doc.moveDown(3);
  doc.fontSize(10).fillColor(COLORS.lightGray);
  doc.text(`Documento generato il ${new Date().toLocaleDateString('it-IT')}`, { width: CONTENT_WIDTH, align: 'center' });
}

function renderContent(doc, content) {
  const lines = content.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      doc.moveDown(0.5);
      continue;
    }

    // Check if we need a new page (leave room for footer)
    if (doc.y > PAGE_HEIGHT - 100) {
      doc.addPage();
    }

    // Markdown-style heading detection
    if (trimmed.startsWith('# ')) {
      doc.moveDown(1);
      doc.fontSize(18).fillColor(COLORS.primary).font('Helvetica-Bold');
      doc.text(trimmed.slice(2), MARGIN, doc.y, { width: CONTENT_WIDTH });
      doc.moveDown(0.5);
    } else if (trimmed.startsWith('## ')) {
      doc.moveDown(0.8);
      doc.fontSize(15).fillColor(COLORS.primary).font('Helvetica-Bold');
      doc.text(trimmed.slice(3), MARGIN, doc.y, { width: CONTENT_WIDTH });
      doc.moveDown(0.3);
    } else if (trimmed.startsWith('### ')) {
      doc.moveDown(0.5);
      doc.fontSize(13).fillColor(COLORS.primary).font('Helvetica-Bold');
      doc.text(trimmed.slice(4), MARGIN, doc.y, { width: CONTENT_WIDTH });
      doc.moveDown(0.2);
    } else if (/^\d+\.\s+[A-ZÀÈÉÌÒÙ]/.test(trimmed) && trimmed === trimmed.toUpperCase()) {
      // Numbered uppercase section heading (e.g., "1. DATI GENERALI")
      doc.moveDown(1);
      doc.fontSize(14).fillColor(COLORS.primary).font('Helvetica-Bold');
      doc.text(trimmed, MARGIN, doc.y, { width: CONTENT_WIDTH });
      doc.moveDown(0.3);
      doc.moveTo(MARGIN, doc.y).lineTo(PAGE_WIDTH - MARGIN, doc.y).strokeColor(COLORS.line).lineWidth(0.5).stroke();
      doc.moveDown(0.3);
    } else if (/^[A-ZÀÈÉÌÒÙ\s]{5,}$/.test(trimmed) && !trimmed.startsWith('-')) {
      // All-caps heading (no numbers)
      doc.moveDown(0.8);
      doc.fontSize(13).fillColor(COLORS.primary).font('Helvetica-Bold');
      doc.text(trimmed, MARGIN, doc.y, { width: CONTENT_WIDTH });
      doc.moveDown(0.3);
    } else if (trimmed.startsWith('- ') || trimmed.startsWith('• ')) {
      // Bullet point
      const bulletText = trimmed.slice(2);
      doc.fontSize(10).fillColor(COLORS.text).font('Helvetica');
      doc.text(`  •  ${bulletText}`, MARGIN + 10, doc.y, { width: CONTENT_WIDTH - 10 });
      doc.moveDown(0.1);
    } else if (/^\d+\.\d+/.test(trimmed)) {
      // Sub-numbered item (e.g., "4.1 ...")
      doc.moveDown(0.3);
      doc.fontSize(11).fillColor(COLORS.text).font('Helvetica-Bold');
      doc.text(trimmed, MARGIN + 10, doc.y, { width: CONTENT_WIDTH - 10 });
      doc.moveDown(0.2);
    } else if (trimmed.includes('_________________')) {
      // Signature line - render with actual lines
      renderSignatureLine(doc, trimmed);
    } else if (trimmed.startsWith('|') && trimmed.endsWith('|')) {
      // Simple table row
      renderTableRow(doc, trimmed);
    } else {
      // Regular paragraph text
      doc.fontSize(10).fillColor(COLORS.text).font('Helvetica');
      doc.text(trimmed, MARGIN, doc.y, { width: CONTENT_WIDTH, lineGap: 2 });
      doc.moveDown(0.2);
    }
  }
}

function renderSignatureLine(doc, text) {
  doc.moveDown(0.5);
  // Extract the role name before the first colon or underscore
  const rolePart = text.split(':')[0] || text.split('_')[0];
  const role = rolePart.replace(/^[-•]\s*/, '').trim();

  doc.fontSize(10).fillColor(COLORS.text).font('Helvetica-Bold');
  doc.text(role, MARGIN, doc.y, { width: CONTENT_WIDTH });
  doc.moveDown(0.5);

  const lineY = doc.y;
  const lineLength = 150;
  const gap = 30;

  // Nome line
  doc.fontSize(8).fillColor(COLORS.lightGray).font('Helvetica');
  doc.text('Nome', MARGIN, lineY);
  doc.moveTo(MARGIN + gap, lineY + 10).lineTo(MARGIN + gap + lineLength, lineY + 10).strokeColor(COLORS.text).lineWidth(0.5).stroke();

  // Firma line
  doc.text('Firma', MARGIN + gap + lineLength + 20, lineY);
  doc.moveTo(MARGIN + gap + lineLength + 20 + gap, lineY + 10).lineTo(MARGIN + gap + lineLength + 20 + gap + lineLength, lineY + 10).stroke();

  doc.y = lineY + 25;
  // Data line
  doc.text('Data', MARGIN, doc.y);
  doc.moveTo(MARGIN + gap, doc.y + 10).lineTo(MARGIN + gap + lineLength, doc.y + 10).stroke();

  doc.y = doc.y + 30;
}

function renderTableRow(doc, line) {
  const cells = line.split('|').filter(c => c.trim() !== '');
  if (cells.length === 0) return;

  // Skip separator rows (e.g., |---|---|)
  if (cells.every(c => /^[\s-:]+$/.test(c))) {
    doc.moveTo(MARGIN, doc.y).lineTo(PAGE_WIDTH - MARGIN, doc.y).strokeColor(COLORS.line).lineWidth(0.5).stroke();
    doc.moveDown(0.1);
    return;
  }

  const cellWidth = CONTENT_WIDTH / cells.length;
  const startY = doc.y;

  // Check if it's a header row (bold)
  const isHeader = cells.some(c => c.trim().startsWith('**') || /^[A-ZÀÈÉÌÒÙ\s]+$/.test(c.trim()));

  doc.fontSize(9).fillColor(COLORS.text);
  doc.font(isHeader ? 'Helvetica-Bold' : 'Helvetica');

  for (let i = 0; i < cells.length; i++) {
    let cellText = cells[i].trim().replace(/\*\*/g, '');
    doc.text(cellText, MARGIN + i * cellWidth, startY, {
      width: cellWidth - 5,
      align: 'left'
    });
  }

  doc.y = Math.max(doc.y, startY + 14);
  doc.moveDown(0.1);
}

function renderSignatures(doc) {
  doc.fontSize(16).fillColor(COLORS.primary).font('Helvetica-Bold');
  doc.text('FIRME', MARGIN, doc.y, { width: CONTENT_WIDTH, align: 'center' });
  doc.moveDown(1);
  doc.moveTo(MARGIN, doc.y).lineTo(PAGE_WIDTH - MARGIN, doc.y).strokeColor(COLORS.primary).lineWidth(1).stroke();
  doc.moveDown(1.5);

  for (const role of SIGNATURES) {
    if (doc.y > PAGE_HEIGHT - 150) {
      doc.addPage();
    }

    doc.fontSize(11).fillColor(COLORS.text).font('Helvetica-Bold');
    doc.text(role, MARGIN, doc.y);
    doc.moveDown(0.8);

    const lineY = doc.y;
    const lineLength = 150;
    const gap = 35;

    doc.fontSize(9).fillColor(COLORS.lightGray).font('Helvetica');

    // Nome
    doc.text('Nome', MARGIN, lineY);
    doc.moveTo(MARGIN + gap, lineY + 10).lineTo(MARGIN + gap + lineLength, lineY + 10).strokeColor(COLORS.text).lineWidth(0.5).stroke();

    // Firma
    const firmaX = MARGIN + gap + lineLength + 30;
    doc.text('Firma', firmaX, lineY);
    doc.moveTo(firmaX + gap, lineY + 10).lineTo(firmaX + gap + lineLength, lineY + 10).stroke();

    doc.y = lineY + 25;

    // Data
    doc.text('Data', MARGIN, doc.y);
    doc.moveTo(MARGIN + gap, doc.y + 10).lineTo(MARGIN + gap + lineLength, doc.y + 10).stroke();

    doc.y = doc.y + 40;
  }
}

module.exports = { generatePdf };
