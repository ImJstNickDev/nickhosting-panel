import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';

/** Original, deterministic PDFs. No downloaded documents, fonts or private data. */
export function pdfFixture(
  options: {
    pages?: number;
    paddingBytes?: number;
    password?: string;
    corruptFirstPage?: boolean;
  } = {},
) {
  const objects: Buffer[] = [];
  const reserve = () => objects.push(Buffer.alloc(0));
  const set = (id: number, body: string | Buffer) => {
    objects[id - 1] = typeof body === 'string' ? Buffer.from(body, 'latin1') : body;
  };
  const catalog = reserve(),
    pages = reserve(),
    font = reserve();
  const pageIds = Array.from({ length: options.pages ?? 3 }, () => reserve());
  const password = options.password;
  const fileId = Buffer.from('6e69636b686f7374696e672d666f6c696f', 'hex');
  const md5 = (bytes: Buffer) => createHash('md5').update(bytes).digest();
  const padding = Buffer.from(
    '28bf4e5e4e758a4164004e56fffa01082e2e00b6d0683e802f0ca9fe6453697a',
    'hex',
  );
  const paddedPassword = (value: string) =>
    Buffer.concat([Buffer.from(value, 'latin1'), padding]).subarray(0, 32);
  const owner =
    password === undefined
      ? undefined
      : rc4(md5(paddedPassword('fixture-owner')).subarray(0, 5), paddedPassword(password));
  const permissions = Buffer.alloc(4);
  permissions.writeInt32LE(-4);
  const key =
    owner === undefined
      ? undefined
      : md5(Buffer.concat([paddedPassword(password ?? ''), owner, permissions, fileId])).subarray(
          0,
          5,
        );
  const encrypt = (id: number, bytes: Buffer) => {
    if (!key) return bytes;
    const suffix = Buffer.from([id & 255, (id >> 8) & 255, (id >> 16) & 255, 0, 0]);
    return rc4(md5(Buffer.concat([key, suffix])).subarray(0, 10), bytes);
  };
  const string = (id: number, value: string) =>
    `<${encrypt(id, Buffer.from(value, 'latin1')).toString('hex')}>`;
  const stream = (id: number, body: Buffer) => {
    const encrypted = encrypt(id, body);
    set(
      id,
      Buffer.concat([
        Buffer.from(`<< /Length ${encrypted.length} >>\nstream\n`),
        encrypted,
        Buffer.from('\nendstream'),
      ]),
    );
  };
  set(font, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const annotations: number[] = [];
  const annotation = (body: (id: number) => string) => {
    const id = reserve();
    annotations.push(id);
    set(id, body(id));
    return id;
  };
  annotation(
    () =>
      `<< /Type /Annot /Subtype /Link /Rect [48 620 240 642] /Border [0 0 0] /Dest [${pageIds[1] ?? pageIds[0]} 0 R /Fit] >>`,
  );
  annotation(
    (id) =>
      `<< /Type /Annot /Subtype /Link /Rect [48 585 240 607] /Border [0 0 0] /A << /S /URI /URI ${string(id, 'https://example.test/folio')} >> >>`,
  );
  annotation(
    (id) =>
      `<< /Type /Annot /Subtype /Link /Rect [48 550 240 572] /A << /S /URI /URI ${string(id, 'javascript:globalThis.folioScriptRan=true')} >> >>`,
  );
  annotation(
    (id) =>
      `<< /Type /Annot /Subtype /Link /Rect [48 515 240 537] /A << /S /Launch /F ${string(id, '/folio-must-not-launch')} >> >>`,
  );
  const widget = annotation(
    (id) =>
      `<< /Type /Annot /Subtype /Widget /FT /Tx /T ${string(id, 'fixtureField')} /V ${string(id, 'Read-only field')} /Rect [48 460 300 490] /P ${pageIds[0]} 0 R >>`,
  );
  const outline = reserve(),
    firstOutline = reserve(),
    secondOutline = reserve(),
    script = reserve();
  set(
    outline,
    `<< /Type /Outlines /First ${firstOutline} 0 R /Last ${secondOutline} 0 R /Count 2 >>`,
  );
  set(
    firstOutline,
    `<< /Title ${string(firstOutline, 'Opening chapter')} /Parent ${outline} 0 R /Dest [${pageIds[0]} 0 R /Fit] /Next ${secondOutline} 0 R >>`,
  );
  set(
    secondOutline,
    `<< /Title ${string(secondOutline, 'Landscape chapter')} /Parent ${outline} 0 R /Dest [${pageIds[1] ?? pageIds[0]} 0 R /Fit] /Prev ${firstOutline} 0 R >>`,
  );
  set(
    script,
    `<< /S /JavaScript /JS ${string(script, 'globalThis.folioScriptRan=true;fetch("/folio-script-must-not-run")')} >>`,
  );
  set(
    catalog,
    `<< /Type /Catalog /Pages ${pages} 0 R /Outlines ${outline} 0 R /OpenAction ${script} 0 R /AcroForm << /Fields [${widget} 0 R] /NeedAppearances true /DA (/Helv 12 Tf 0 g) /DR << /Font << /Helv ${font} 0 R >> >> >> >>`,
  );
  set(
    pages,
    `<< /Type /Pages /Count ${pageIds.length} /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] >>`,
  );
  pageIds.forEach((id, index) => {
    const content = reserve();
    const width = index % 2 === 0 ? 612 : 792,
      height = index % 2 === 0 ? 792 : 612;
    const text = `BT /F1 24 Tf 48 ${height - 70} Td (Folio fixture page ${index + 1}) Tj 0 -40 Td /F1 14 Tf (Orchid chapter ${index + 1}: selectable document text.) Tj ET\n`;
    stream(
      content,
      Buffer.from(
        text +
          (index === 0
            ? 'BT /F1 14 Tf 48 625 Td (Go to landscape page) Tj 0 -35 Td (External HTTPS link) Tj 0 -35 Td (Blocked JavaScript link) Tj 0 -35 Td (Blocked launch action) Tj ET\n'
            : ''),
      ),
    );
    set(
      id,
      `<< /Type /Page /Parent ${pages} 0 R /MediaBox [0 0 ${width} ${height}] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${content} 0 R${index === 0 ? ` /Annots [${annotations.map((value) => `${value} 0 R`).join(' ')}]` : ''} >>`,
    );
  });
  if (options.corruptFirstPage && pageIds[0]) set(pageIds[0], 'null');
  if (options.paddingBytes) stream(reserve(), Buffer.alloc(options.paddingBytes, 32));
  let encryption: number | undefined;
  if (key && owner) {
    encryption = reserve();
    set(
      encryption,
      `<< /Filter /Standard /V 1 /R 2 /Length 40 /O <${owner.toString('hex')}> /U <${rc4(key, padding).toString('hex')}> /P -4 >>`,
    );
  }
  const chunks = [Buffer.from('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
  const offsets = [0];
  let offset = chunks[0]?.length ?? 0;
  objects.forEach((body, index) => {
    offsets.push(offset);
    const chunk = Buffer.concat([
      Buffer.from(`${index + 1} 0 obj\n`),
      body,
      Buffer.from('\nendobj\n'),
    ]);
    chunks.push(chunk);
    offset += chunk.length;
  });
  chunks.push(
    Buffer.from(
      `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets
        .slice(1)
        .map((value) => `${String(value).padStart(10, '0')} 00000 n \n`)
        .join(
          '',
        )}trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R /ID [<${fileId.toString('hex')}> <${fileId.toString('hex')}>]${encryption ? ` /Encrypt ${encryption} 0 R` : ''} >>\nstartxref\n${offset}\n%%EOF\n`,
    ),
  );
  return Buffer.concat(chunks);
}

/** RC4 is used only to construct a legacy PDF encryption test vector. */
function rc4(key: Buffer, input: Buffer): Buffer {
  const state = Array.from({ length: 256 }, (_, index) => index);
  let j = 0;
  for (let i = 0; i < 256; i++) {
    j = (j + (state[i] ?? 0) + (key[i % key.length] ?? 0)) % 256;
    [state[i], state[j]] = [state[j] ?? 0, state[i] ?? 0];
  }
  let i = 0;
  j = 0;
  return Buffer.from(
    input.map((byte) => {
      i = (i + 1) % 256;
      j = (j + (state[i] ?? 0)) % 256;
      [state[i], state[j]] = [state[j] ?? 0, state[i] ?? 0];
      return byte ^ (state[((state[i] ?? 0) + (state[j] ?? 0)) % 256] ?? 0);
    }),
  );
}
