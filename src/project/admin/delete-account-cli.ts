/**
 * Hapus akun aplikasi atas permintaan lewat email (halaman /hapus-akun di web):
 *
 *   npm run delete-account -- <email | nama panggilan | id akun>          cari dan tampilkan saja
 *   npm run delete-account -- <email | nama panggilan | id akun> --yes    benar-benar menghapus
 *
 * Tanpa --yes tidak ada yang berubah, jadi periksa dulu bahwa akunnya benar. Menghapus hanya bila
 * tepat satu akun cocok. Memakai DATABASE_URL dari .env, sama dengan server.
 */
import dotenv from "dotenv";
import { connectDatabase } from "../db/client.js";
import { deleteAccount } from "../auth/service.js";
import { findAccounts, type AccountMatch } from "./accounts.js";

dotenv.config({ quiet: true });

function describe(account: AccountMatch): string {
  const date = (d: Date) => d.toISOString().slice(0, 10);
  return [
    `  id          ${account.id}`,
    `  email       ${account.email ?? "-"}`,
    `  nama        ${account.displayName ?? "(belum memilih nama)"}`,
    `  dibuat      ${date(account.createdAt)}`,
    `  login akhir ${date(account.lastLoginAt)}`,
  ].join("\n");
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const confirmed = args.includes("--yes");
  const query = args.filter((a) => a !== "--yes").join(" ").trim();
  if (!query) {
    console.error("Pakai: npm run delete-account -- <email | nama panggilan | id akun> [--yes]");
    return 2;
  }
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL belum diisi.");
    return 2;
  }

  const handle = await connectDatabase(url, { max: 1 });
  try {
    const matches = await findAccounts(handle.db, query);
    if (matches.length === 0) {
      console.log(`Tidak ada akun untuk "${query}".`);
      return 1;
    }
    if (matches.length > 1) {
      console.log(`${matches.length} akun cocok. Pakai id akun supaya tepat satu:\n`);
      console.log(matches.map(describe).join("\n\n"));
      return 1;
    }

    const [account] = matches as [AccountMatch];
    console.log(`Akun ditemukan:\n${describe(account)}\n`);
    if (!confirmed) {
      console.log("Belum dihapus. Jalankan lagi dengan --yes untuk menghapus akun ini.");
      return 0;
    }
    const deleted = await deleteAccount(handle.db, account.id);
    console.log(deleted ? "Akun dan semua sesinya sudah dihapus." : "Akun sudah tidak ada (mungkin baru dihapus).");
    return 0;
  } finally {
    await handle.close();
  }
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error);
    process.exit(1);
  },
);
