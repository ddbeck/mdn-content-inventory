import { Temporal } from "@js-temporal/polyfill";
import assert from "assert";
import {
  ExecFileSyncOptionsWithStringEncoding,
  execFileSync,
} from "child_process";
import { existsSync, readFileSync, rmSync } from "fs";
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

const MDNContentRepo = "mdn/content";
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
    execFileSync("gh", [
      "repo",
      "clone",
      MDNContentRepo,
      destPath,
      "--",
      "--filter=blob:none",
      "--quiet",
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

  logger.info("Working around rari stdout pollution …");
  // TODO: remove me when https://github.com/mdn/rari/issues/131 is fixed
  execFileSync("yarn", ["--silent", "content", "validate-redirects"], {
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

  const redirects = (() => {
    const file = readFileSync(`${destPath}/files/en-us/_redirects.txt`, "utf8");
    const lines = file.split("\n");
    const redirectLines = lines.filter(
      (line) => line.startsWith("/") && line.includes("\t"),
    );
    const redirectMap = new Map<string, string>();
    for (const redirectLine of redirectLines) {
      const [source, target] = redirectLine.split("\t", 2);
      if (source && target) {
        redirectMap.set(source, target);
      }
    }
    return Object.fromEntries(redirectMap);
  })();

  console.log(
    JSON.stringify({
      metadata: { commit, commitShort, authorDate },
      inventory,
      redirects,
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
