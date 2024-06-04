import { Temporal } from "@js-temporal/polyfill";
import { execFileSync } from "child_process";
import { readFileSync, writeFileSync } from "fs";
import winston from "winston";
import yargs from "yargs";

const argv = yargs(process.argv.slice(2))
  .scriptName("dist")
  .usage("$0", "Generate JSON from MDN content")
  .option("ref", {
    describe:
      "Choose a specific ref (commit, branch, or tag) to generate the inventory from",
    type: "string",
    default: "origin/main",
  })
  .option("date", {
    describe:
      "Choose a specific date (in YYYY-MM-DD) to generate the inventory from",
    type: "string",
  })
  .option("verbose", {
    alias: "v",
    describe: "Show more information about calculating the status",
    type: "count",
    default: 0,
    defaultDescription: "warn",
  })
  .parseSync();

const logger = winston.createLogger({
  level: argv.verbose > 0 ? "debug" : "warn",
  format: winston.format.combine(
    winston.format.colorize(),
    winston.format.simple(),
  ),
  transports: new winston.transports.Console({
    stderrLevels: ["debug", "info", "warn"],
  }),
});

main();

function main() {
  logger.info("Generating inventory…");
  makeInventoryJSON();

  logger.info("Creating package.json…");
  makePackageJSON();
}

function makeInventoryJSON() {
  const startOfDay = Temporal.Now.instant()
    .toZonedDateTimeISO("UTC")
    .startOfDay();
  const inventory = JSON.stringify(
    JSON.parse(
      execFileSync(
        "npx",
        [
          "tsx",
          "./scripts/generate-inventory.mts",
          "--verbose",
          `--date=${startOfDay.toString()}`,
        ],
        {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "inherit"],
          maxBuffer: 1024 * 1024 * 5,
        },
      ),
    ),
  );
  writeFileSync("package/index.json", inventory, { encoding: "utf8" });
}

function makePackageJSON() {
  const { metadata } = JSON.parse(
    readFileSync("package/index.json", { encoding: "utf-8" }),
  );

  const { name, version, description, author, license } = JSON.parse(
    readFileSync("package.json", { encoding: "utf-8" }),
  );
  writeFileSync(
    "package/package.json",
    JSON.stringify(
      {
        name,
        version: `${version}-${metadata.authorDate.slice(0, 10).replaceAll("-", "")}.${metadata.commitShort}`,
        description,
        author,
        license,
        main: "index.js",
        type: "module",
      },
      undefined,
      2,
    ),
    { encoding: "utf-8" },
  );
}
