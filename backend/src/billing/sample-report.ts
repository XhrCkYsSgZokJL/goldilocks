// Sample report generation.
//
// When a person is first enabled on a client's plan, a sample PDF is
// generated and sent to the client's Reports channel.  This gives the
// client immediate confirmation that the system is working and shows
// them what a real report will look like.
//
// The PDF is a simple one-page placeholder with the person's name and
// the date.  In the future this can be replaced with a real report
// generator that pulls live data.

import { writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { eq, and } from 'drizzle-orm';
import { db } from '../db/client.js';
import { coveredPersons } from '../db/schema.js';
import { logger } from '../observability/logger.js';

const log = logger.child({ module: 'billing.sample-report' });

const REPORTS_DIR = process.env.REPORTS_DIR ?? './reports';

// Generate a minimal PDF for the sample report.  This builds a valid
// PDF manually (no library needed) — just enough to display the
// person's name, the client number, and the date on a single page.
function buildSamplePdf(personName: string, clientNumber: number): Buffer {
  const date: string = new Date().toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });

  const title = `Sample Report — ${personName}`;
  const body = [
    `Client #${clientNumber}`,
    `Person: ${personName}`,
    `Date: ${date}`,
    '',
    'This is a sample report confirming that coverage',
    'has been activated for this person. Your first',
    'full report will be delivered on the 1st of',
    'the next month.',
  ];

  // Build a minimal valid PDF with text content.
  const textLines: string[] = body.map(
    (line, i) => `BT /F1 12 Tf 72 ${700 - i * 20} Td (${escapePdf(line)}) Tj ET`,
  );
  const titleLine = `BT /F1 18 Tf 72 740 Td (${escapePdf(title)}) Tj ET`;
  const stream = [titleLine, ...textLines].join('\n');
  const streamLength: number = Buffer.byteLength(stream, 'utf-8');

  const objects: string[] = [
    // Object 1: Catalog
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj',
    // Object 2: Pages
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj',
    // Object 3: Page
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj',
    // Object 4: Content stream
    `4 0 obj\n<< /Length ${streamLength} >>\nstream\n${stream}\nendstream\nendobj`,
    // Object 5: Font
    '5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj',
  ];

  // Build cross-reference table.
  let offset = 0;
  const header = '%PDF-1.4\n';
  offset += Buffer.byteLength(header, 'utf-8');

  const offsets: number[] = [];
  const bodyParts: string[] = [];
  for (const obj of objects) {
    offsets.push(offset);
    const part = obj + '\n';
    bodyParts.push(part);
    offset += Buffer.byteLength(part, 'utf-8');
  }

  const xrefOffset: number = offset;
  const xref: string[] = [
    'xref',
    `0 ${objects.length + 1}`,
    '0000000000 65535 f ',
    ...offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n `),
  ];

  const trailer = [
    'trailer',
    `<< /Size ${objects.length + 1} /Root 1 0 R >>`,
    'startxref',
    String(xrefOffset),
    '%%EOF',
  ];

  const pdf: string = header + bodyParts.join('') + xref.join('\n') + '\n' + trailer.join('\n') + '\n';
  return Buffer.from(pdf, 'utf-8');
}

function escapePdf(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

// Queue a sample report for the reports-watcher to pick up and send.
// The file is dropped into the reports directory with the client number
// prefix so the watcher routes it to the correct Reports channel.
export async function queueSampleReport(
  clientId: string,
  clientNumber: number,
  personId: string,
  personName: string,
): Promise<void> {
  try {
    await mkdir(REPORTS_DIR, { recursive: true });

    const sanitizedName: string = personName.replace(/[^a-zA-Z0-9 ]/g, '').trim() || 'Person';
    const filename = `${clientNumber}-Sample-Report-${sanitizedName}.pdf`;
    const pdfBuffer: Buffer = buildSamplePdf(personName, clientNumber);

    await writeFile(join(REPORTS_DIR, filename), pdfBuffer);

    // Mark the initial report as queued (the watcher will update
    // initial_report_sent_at once it actually posts).
    await db
      .update(coveredPersons)
      .set({ initialReportSentAt: new Date() })
      .where(
        and(
          eq(coveredPersons.clientId, clientId),
          eq(coveredPersons.personId, personId),
        ),
      );

    log.info({ clientId, clientNumber, personId, filename }, 'sample report queued');
  } catch (err) {
    log.error({ err, clientId, personId }, 'failed to queue sample report');
  }
}
