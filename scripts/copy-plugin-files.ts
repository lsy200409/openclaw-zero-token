import { mkdir, cp } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const extensions = ["device-pair", "phone-control", "talk-voice", "thread-ownership"];

for (const ext of extensions) {
  const src = resolve(__dirname, `../extensions/${ext}/openclaw.plugin.json`);
  const destDir = resolve(__dirname, `../dist/extensions/${ext}`);
  const dest = resolve(__dirname, `../dist/extensions/${ext}/openclaw.plugin.json`);

  try {
    await mkdir(destDir, { recursive: true });
    await cp(src, dest);
    console.log(`[copy-plugin-files] Copied ${ext}/openclaw.plugin.json`);
  } catch (err) {
    if (err.code !== "ENOENT") {
      console.warn(`[copy-plugin-files] Warning: ${ext} - ${err.message}`);
    }
  }
}
