import { Temporal } from "@js-temporal/polyfill";
import assert from "assert";
import {
  ExecFileSyncOptionsWithStringEncoding,
  execFileSync,
} from "child_process";
import { existsSync, rmSync } from "fs";
import { join, relative } from "path";
import { fileURLToPath } from "url";
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
  .option("clean", {
    describe: "Wipe out repo when finished",
    type: "boolean",
    default: false,
  })
  .parseSync();

const logger = winston.createLogger({
  level: argv.verbose > 0 ? "debug" : "warn",
  format: winston.format.combine(
    winston.format.colorize(),
    winston.format.simple(),
  ),
  transports: new winston.transports.Console({
    stderrLevels: ["debug", "warn", "info"],
  }),
});

const MDNContentRepo = "git@github.com:mdn/content.git";
const destPath = relative(process.cwd(), ".mdn-content");

function main() {
  try {
    if (argv.date) {
      clone({ date: argv.date, ref: argv.ref });
    } else {
      clone({ ref: argv.ref });
    }
    installDeps();
    inventory();
  } finally {
    if (argv.clean) {
      cleanUp();
    }
  }
}

function clone(opts: { ref: string; date?: string }) {
  let { ref } = opts;

  if (!existsSync(destPath) || !existsSync(join(destPath, "/.git"))) {
    logger.info(`Cloning mdn/content into ${destPath}…`);
    execFileSync("git", [
      "clone",
      "--filter=blob:none",
      "--quiet",
      MDNContentRepo,
      destPath,
    ]);
  } else {
    logger.info(`Reusing existing clone at ${destPath}…`);
    execFileSync("git", ["fetch", "origin"]);
  }

  if (opts.date) {
    // find commit on ref nearest to date
    const target = Temporal.PlainDate.from(opts.date)
      .toZonedDateTime({ timeZone: "UTC", plainTime: "00:00:01" })
      .startOfDay();
    logger.info(`Looking for commit on ${ref} at ${target.toString()}`);
    const hash = execFileSync(
      "git",
      ["rev-list", "-1", `--before=${target.toString()}`, ref],
      { cwd: destPath, encoding: "utf-8" },
    )
      .split("\n")
      .filter((line) => line.length > 0)
      .at(-1);
    if (!hash) {
      throw new Error(`Could not find commit near to ${target.toString()}`);
    }
    ref = hash;
  }

  logger.info(`Checking out ${ref}`);
  execFileSync("git", ["switch", "--quiet", "--detach", ref], {
    cwd: destPath,
    encoding: "utf-8",
  });
}

function installDeps() {
  logger.info("Installing dependencies…");
  execFileSync("yarn", ["--silent"], {
    cwd: destPath,
    encoding: "utf-8",
    stdio: "ignore",
  });
}

function inventory() {
  const readOpts: ExecFileSyncOptionsWithStringEncoding = {
    cwd: destPath,
    stdio: ["ignore", "pipe", "ignore"],
    encoding: "utf-8",
  };

  logger.info("Generating content inventory…");
  const inventory = JSON.parse(
    execFileSync("yarn", ["--silent", "run", "content", "inventory"], {
      ...readOpts,
      maxBuffer: 1024 * 1024 * 5,
    }),
  );

  const commitShort = execFileSync(
    "git",
    ["rev-parse", "--short", "HEAD"],
    readOpts,
  )
    .split("\n")
    .filter((line) => line.length > 0)
    .at(-1);
  const commit = execFileSync("git", ["rev-parse", "HEAD"], readOpts)
    .split("\n")
    .filter((line) => line.length > 0)
    .at(-1);

  const authorInstant = execFileSync(
    "git",
    ["show", "--no-patch", "--format=%aI"],
    readOpts,
  )
    .split("\n")
    .filter((line) => line.length > 0)
    .at(-1);
  assert(authorInstant?.length);
  const authorDate = Temporal.Instant.from(authorInstant)
    .toZonedDateTimeISO("UTC")
    .toString();

  console.log(
    JSON.stringify({
      metadata: { commit, commitShort, authorDate },
      inventory,
    }),
  );
}

function cleanUp() {
  logger.info("Cleaning up…");
  rmSync(destPath, { recursive: true, force: true });
}

if (import.meta.url.startsWith("file:")) {
  if (process.argv[1] === fileURLToPath(import.meta.url)) {
    main();
  }
}
