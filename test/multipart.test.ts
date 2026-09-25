import { test } from "node:test";
import assert from "node:assert/strict";
import { parseContentType, parseMultipart } from "../src/app/multipart.js";

async function realBody(build: (fd: FormData) => void): Promise<{ buf: Buffer; boundary: string }> {
  const fd = new FormData();
  build(fd);
  const req = new Request("http://x", { method: "POST", body: fd });
  const { boundary } = parseContentType(req.headers.get("content-type") ?? undefined);
  return { buf: Buffer.from(await req.arrayBuffer()), boundary: boundary! };
}

test("parseContentType: boundary nikalta hai", () => {
  assert.deepEqual(parseContentType("multipart/form-data; boundary=abc123"), { type: "multipart/form-data", boundary: "abc123" });
  assert.deepEqual(parseContentType("application/json"), { type: "application/json", boundary: null });
  assert.deepEqual(parseContentType(undefined), { type: "", boundary: null });
});

test("parseMultipart: text fields sahi milte hain", async () => {
  const { buf, boundary } = await realBody((fd) => {
    fd.set("name", "Fire Monkey");
    fd.set("price", "0.001");
  });
  const r = parseMultipart(buf, boundary);
  assert.deepEqual(r.fields, { name: "Fire Monkey", price: "0.001" });
  assert.equal(r.files.length, 0);
});

test("parseMultipart: BINARY file (har byte 0-255, non-UTF8) BILKUL sahi milta hai", async () => {
  const raw = Buffer.from(Array.from({ length: 512 }, (_, i) => i % 256));
  const { buf, boundary } = await realBody((fd) => {
    fd.set("cover", new Blob([raw], { type: "image/png" }), "cover.png");
  });
  const r = parseMultipart(buf, boundary);
  assert.equal(r.files.length, 1);
  assert.equal(r.files[0].field, "cover");
  assert.equal(r.files[0].filename, "cover.png");
  assert.equal(r.files[0].contentType, "image/png");
  assert.equal(Buffer.compare(r.files[0].data, raw), 0);
});

test("parseMultipart: multiple files (same field, jaise <input multiple>) sab milte hain, sahi order me", async () => {
  const { buf, boundary } = await realBody((fd) => {
    fd.append("images", new Blob([Buffer.from([1, 1, 1])], { type: "image/png" }), "1.png");
    fd.append("images", new Blob([Buffer.from([2, 2, 2, 2])], { type: "image/png" }), "2.png");
    fd.append("images", new Blob([Buffer.from([3])], { type: "image/png" }), "3.png");
  });
  const r = parseMultipart(buf, boundary);
  assert.equal(r.files.length, 3);
  assert.deepEqual(r.files.map((f) => f.data.length), [3, 4, 1]);
  assert.deepEqual(r.files.map((f) => f.filename), ["1.png", "2.png", "3.png"]);
});

test("parseMultipart: text aur files mix, khaali file, khaali field", async () => {
  const { buf, boundary } = await realBody((fd) => {
    fd.set("a", "");
    fd.set("f", new Blob([]), "empty.png");
    fd.set("b", "hello");
  });
  const r = parseMultipart(buf, boundary);
  assert.equal(r.fields.a, "");
  assert.equal(r.fields.b, "hello");
  assert.equal(r.files[0].data.length, 0);
});

test("parseMultipart: kharab/adhoora body => throw, crash nahi", () => {
  assert.throws(() => parseMultipart(Buffer.from("garbage no boundary here"), "xyz"));
  assert.throws(() => parseMultipart(Buffer.from("--xyz\r\nContent-Disposition: form-data; name=\"a\"\r\n\r\nno-end"), "xyz"));
  assert.throws(() => parseMultipart(Buffer.alloc(0), "xyz"));
  assert.throws(() => parseMultipart(Buffer.from("--xyz--"), ""));
});

test("parseMultipart: har byte-value wali boundary-jaisi content bhi sahi tarah nikalti hai (koi galat split nahi)", async () => {
  // content ke andar khud "--boundary" jaisa text ho, par asli boundary alag random string ho to koi confusion nahi
  const raw = Buffer.from("--fake-boundary-inside--\r\nContent-Disposition: fake\r\n\r\n");
  const { buf, boundary } = await realBody((fd) => {
    fd.set("f", new Blob([raw]), "x.png");
  });
  const r = parseMultipart(buf, boundary);
  assert.equal(Buffer.compare(r.files[0].data, raw), 0);
});
