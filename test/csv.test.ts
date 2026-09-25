import { test } from "node:test";
import assert from "node:assert/strict";
import { csvToMetadataMap, parseCsv } from "../src/assets/csv.js";

test("parseCsv: basic rows, header trim", () => {
  const rows = parseCsv("filename,name,description\n1.png,First,Hello\n2.png,Second,World\n");
  assert.deepEqual(rows, [
    { filename: "1.png", name: "First", description: "Hello" },
    { filename: "2.png", name: "Second", description: "World" },
  ]);
});

test("parseCsv: quoted fields with commas and escaped quotes", () => {
  const rows = parseCsv('filename,name\n1.png,"Hello, World"\n2.png,"She said ""hi"""\n');
  assert.equal(rows[0].name, "Hello, World");
  assert.equal(rows[1].name, 'She said "hi"');
});

test("parseCsv: CRLF line endings, trailing blank lines ignored", () => {
  const rows = parseCsv("filename,name\r\n1.png,A\r\n2.png,B\r\n\r\n");
  assert.equal(rows.length, 2);
});

test("parseCsv: khaali input => khaali array", () => {
  assert.deepEqual(parseCsv(""), []);
  assert.deepEqual(parseCsv("filename,name\n"), []);
});

test("csvToMetadataMap: filename/file/image/token columns me se koi bhi chalta hai", () => {
  const a = csvToMetadataMap(parseCsv("filename,name\n1.png,A\n"));
  assert.equal(a.get("1.png")!.name, "A");
  const b = csvToMetadataMap(parseCsv("token,name\n1.png,B\n"));
  assert.equal(b.get("1.png")!.name, "B");
});

test("csvToMetadataMap: extension ke bina bhi match hota hai", () => {
  const m = csvToMetadataMap(parseCsv("filename,name\n1.png,A\n"));
  assert.equal(m.get("1")!.name, "A");
});

test("csvToMetadataMap: baaki columns attributes ban jaate hain, khaali cell skip", () => {
  const m = csvToMetadataMap(parseCsv("filename,name,Background,Eyes\n1.png,A,Red,\n"));
  assert.deepEqual(m.get("1.png")!.attributes, [{ trait_type: "Background", value: "Red" }]);
});

test("csvToMetadataMap: 'trait:' prefix hata deta hai; numeric value number ban jaati hai", () => {
  const m = csvToMetadataMap(parseCsv("filename,trait:Level,trait:Name\n1.png,7,Bob\n"));
  assert.deepEqual(m.get("1.png")!.attributes, [{ trait_type: "Level", value: 7 }, { trait_type: "Name", value: "Bob" }]);
});

test("csvToMetadataMap: filename khaali row skip hoti hai", () => {
  const m = csvToMetadataMap(parseCsv("filename,name\n,Ghost\n1.png,Real\n"));
  assert.equal(m.size, 2); // sirf "1.png" aur "1" (extension ke bina)
  assert.equal(m.get("1.png")!.name, "Real");
});
