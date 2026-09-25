/**
 * Chhota CSV parser (koi library nahi): OpenSea-jaisi bulk-metadata sheet ke liye.
 * Quoted fields, commas-inside-quotes, "" escape, CRLF/LF sab sambhalta hai.
 */
export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  const pushField = () => {
    row.push(field);
    field = "";
  };
  const pushRow = () => {
    pushField();
    if (row.some((f) => f.trim() !== "")) rows.push(row);
    row = [];
  };
  const s = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") pushField();
    else if (c === "\n") pushRow();
    else field += c;
  }
  if (field !== "" || row.length) pushRow();
  if (rows.length === 0) return [];
  const header = rows[0].map((h) => h.trim());
  return rows.slice(1).map((r) => {
    const o: Record<string, string> = {};
    header.forEach((h, i) => (o[h] = (r[i] ?? "").trim()));
    return o;
  });
}

export interface CsvMetadata {
  name?: string;
  description?: string;
  attributes: { trait_type: string; value: string | number }[];
}

const RESERVED = new Set(["filename", "file", "image", "token", "name", "description"]);

/**
 * CSV rows ko per-image metadata me badalta hai. Match "filename"/"file"/"image"/"token"
 * column se hota hai (extension ke saath ya bina). Baaki columns attributes ban jaate hain
 * (empty cell wali skip). "trait:X" prefix bhi chalta hai, sirf "X" bhi.
 */
export function csvToMetadataMap(rows: Record<string, string>[]): Map<string, CsvMetadata> {
  const map = new Map<string, CsvMetadata>();
  for (const row of rows) {
    const key = (row.filename || row.file || row.image || row.token || "").trim();
    if (!key) continue;
    const attributes: CsvMetadata["attributes"] = [];
    for (const [col, val] of Object.entries(row)) {
      const lc = col.toLowerCase().trim();
      if (RESERVED.has(lc) || val.trim() === "") continue;
      const trait = col.toLowerCase().startsWith("trait:") ? col.slice(6).trim() : col.trim();
      const num = Number(val);
      attributes.push({ trait_type: trait, value: val.trim() !== "" && Number.isFinite(num) && String(num) === val.trim() ? num : val.trim() });
    }
    const meta: CsvMetadata = { attributes };
    if (row.name?.trim()) meta.name = row.name.trim();
    if (row.description?.trim()) meta.description = row.description.trim();
    map.set(key.toLowerCase(), meta);
    map.set(key.replace(/\.[^.]+$/, "").toLowerCase(), meta); // extension ke bina bhi match ho jaaye
  }
  return map;
}
