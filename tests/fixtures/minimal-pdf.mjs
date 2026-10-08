/**
 * A valid PDF with one line of Helvetica text per page; an empty string gives a page without any
 * text, like a scanned page. Text must be printable ASCII without parentheses or backslashes.
 * @param {string[]} pages
 * @param {{ title?: string }} [options]
 */
export function minimalPdf(pages, { title } = {}) {
  const objects = [
    undefined,
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${pages.map((_, index) => `${4 + index * 2} 0 R`).join(' ')}] /Count ${pages.length} >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  pages.forEach((text, index) => {
    const stream = text ? `BT /F1 12 Tf 72 720 Td (${text}) Tj ET` : '';
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + index * 2} 0 R >>`,
      `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    );
  });
  if (title) objects.push(`<< /Title (${title}) >>`);
  let pdf = '%PDF-1.4\n';
  const offsets = [];
  for (let id = 1; id < objects.length; id++) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf);
  const entries = offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  const info = title ? ` /Info ${objects.length - 1} 0 R` : '';
  pdf += `xref\n0 ${objects.length}\n0000000000 65535 f \n${entries}`;
  pdf += `trailer\n<< /Size ${objects.length} /Root 1 0 R${info} >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}
