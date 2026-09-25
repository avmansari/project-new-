/**
 * multipart/form-data parser (binary-safe: Buffer.indexOf se, string split se NAHI, warna image bytes
 * corrupt ho sakte hain). Koi library nahi, poori tarah in-memory (size limit caller lagata hai).
 */
export interface MultipartFile {
  field: string;
  filename: string;
  contentType: string;
  data: Buffer;
}
export interface MultipartResult {
  fields: Record<string, string>;
  files: MultipartFile[];
}

export function parseContentType(header: string | undefined): { type: string; boundary: string | null } {
  const parts = (header ?? "").split(";").map((s) => s.trim());
  const type = (parts[0] || "").toLowerCase();
  const b = parts.find((p) => p.toLowerCase().startsWith("boundary="));
  const boundary = b ? b.slice("boundary=".length).replace(/^"|"$/g, "") : null;
  return { type, boundary };
}

const CRLF = Buffer.from("\r\n");
const CRLFCRLF = Buffer.from("\r\n\r\n");

export function parseMultipart(body: Buffer, boundary: string): MultipartResult {
  if (!boundary || boundary.length > 200) throw new Error("boundary galat hai");
  const delim = Buffer.from(`--${boundary}`);
  const fields: Record<string, string> = {};
  const files: MultipartFile[] = [];

  let pos = body.indexOf(delim);
  if (pos === -1) throw new Error("multipart body me boundary nahi mila");
  pos += delim.length;

  while (true) {
    // ye boundary ke turant baad "--" (end) ya CRLF (agla part) hona chahiye
    if (body.subarray(pos, pos + 2).equals(Buffer.from("--"))) break; // final boundary
    if (!body.subarray(pos, pos + 2).equals(CRLF)) throw new Error("multipart format galat hai");
    pos += 2;

    const headerEnd = body.indexOf(CRLFCRLF, pos);
    if (headerEnd === -1) throw new Error("part ke headers khatam nahi hue");
    const headerText = body.subarray(pos, headerEnd).toString("utf8");
    pos = headerEnd + CRLFCRLF.length;

    const nextDelim = body.indexOf(delim, pos);
    if (nextDelim === -1) throw new Error("part ka content khatam nahi hua (boundary nahi mila)");
    // content aur agle boundary ke beech CRLF hota hai, wo content ka hissa nahi
    let contentEnd = nextDelim;
    if (contentEnd >= 2 && body.subarray(contentEnd - 2, contentEnd).equals(CRLF)) contentEnd -= 2;
    const content = body.subarray(pos, contentEnd);

    let field = "";
    let filename: string | null = null;
    let contentType = "application/octet-stream";
    for (const line of headerText.split("\r\n")) {
      const [rawName, ...rest] = line.split(":");
      if (!rawName) continue;
      const name = rawName.trim().toLowerCase();
      const value = rest.join(":").trim();
      if (name === "content-disposition") {
        const fm = /name="([^"]*)"/.exec(value);
        const fn = /filename="([^"]*)"/.exec(value);
        field = fm ? fm[1] : "";
        if (fn) filename = fn[1];
      } else if (name === "content-type") {
        contentType = value.split(";")[0].trim();
      }
    }
    if (filename !== null) {
      files.push({ field, filename, contentType, data: Buffer.from(content) });
    } else {
      fields[field] = content.toString("utf8");
    }

    pos = nextDelim + delim.length;
  }
  return { fields, files };
}
