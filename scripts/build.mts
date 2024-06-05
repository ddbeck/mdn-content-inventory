import { Temporal } from "@js-temporal/polyfill";
import { execFileSync } from "child_process";
import { copyFileSync, readFileSync, writeFileSync } from "fs";
import winston from "winston";
import yargs from "yargs";

const argv = yargs(process.argv.slice(2))
  .scriptName("build")
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
  const publishDate = Temporal.PlainDate.from(
    argv.date ?? Temporal.Now.zonedDateTimeISO(),
  )
    .toZonedDateTime({ timeZone: "UTC", plainTime: "00:00:01" })
    .startOfDay();

  logger.info("Generating inventory…");
  makeInventoryJSON();

  logger.info("Creating package.json…");
  makePackageJSON({ publishDate });

  logger.info("Copying readme.md");
  copyFileSync("readme.md", "package/readme.md");
}

function makeInventoryJSON() {
  const startOfDay = Temporal.PlainDate.from(
    argv.date ?? Temporal.Now.zonedDateTimeISO(),
  )
    .toZonedDateTime({ timeZone: "UTC", plainTime: "00:00:01" })
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

function makePackageJSON(opts: { publishDate: Temporal.ZonedDateTime }) {
  const { publishDate } = opts;

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
        version: `${version}-${publishDate.toString().slice(0, 10).replaceAll("-", "")}.${metadata.commitShort}`,
        description,
        author,
        license,
        main: "index.js",
        type: "module",
        scripts: {},
      },
      undefined,
      2,
    ),
    { encoding: "utf-8" },
  );
}
