import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const scriptdir = dirname(fileURLToPath(import.meta.url));

function read() {
  return JSON.parse(
    readFileSync(join(scriptdir, "index.json"), { encoding: "utf-8" }),
  );
}

export default read();
