// Karakter kontrol, zero-width, dan bidi override yang sering dipakai untuk "spoof" nama.
// Ditulis sebagai string escape (bukan regex literal) supaya file tetap ASCII.
const INVISIBLE_CHARS = new RegExp(
  "[\\u0000-\\u001f\\u007f-\\u009f\\u200b-\\u200f\\u2028-\\u202e\\u2066-\\u2069\\ufeff]",
  "g",
);

/** Bersihkan teks dari user: hapus karakter tak terlihat & rapikan spasi. */
export function cleanText(value: string): string {
  return value.replace(INVISIBLE_CHARS, "").replace(/\s+/g, " ").trim();
}
