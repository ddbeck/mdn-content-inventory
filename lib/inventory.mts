import { Temporal } from "@js-temporal/polyfill";
import assert from "node:assert/strict";
import {
  ExecFileSyncOptionsWithStringEncoding,
  execFileSync,
  spawn,
} from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join, relative } from "node:path";
import winston from "winston";

const defaultLogger = winston.createLogger({
  level: "warn",
  format: winston.format.combine(
    winston.format.colorize(),
    winston.format.simple(),
  ),
  transports: new winston.transports.Console({
    stderrLevels: ["debug", "warn", "info"],
  }),
});

export class Inventory {
  repo: string;
  destPath: string;
  logger: winston.Logger;

  rawInventoryStdErr: string = "";
  rawInventoryStdOut: string = "";
  rawRedirects: string | undefined;

  constructor(opts?: {
    repo?: string;
    destPath?: string;
    logger?: winston.Logger;
  }) {
    const defaults = {
      repo: "mdn/content",
      destPath: relative(process.cwd(), ".mdn-content"), // TODO: use tempdir by default
      logger: defaultLogger,
    };
    const resolvedOpts = { ...defaults, ...opts };

    this.repo = resolvedOpts.repo;
    this.destPath = resolvedOpts.destPath;
    this.logger = resolvedOpts.logger;
  }

  async init(ref: string, date?: string) {
    this.clone();
    this.checkout(ref, date);
    this.loadRedirects();
    this.installDeps();
    const result = await this.loadInventory();
    if (result === null || result > 0) {
      this.logger.error(this.rawInventoryStdErr);
      throw new Error("Failed to load data. See stdout above for details.");
    }
  }

  clone() {
    if (
      !existsSync(this.destPath) ||
      !existsSync(join(this.destPath, "/.git"))
    ) {
      this.logger.info(`Cloning ${this.repo} to ${this.destPath}`);
      execFileSync("gh", [
        "repo",
        "clone",
        this.repo,
        this.destPath,
        "--",
        "--filter=blob:none",
        "--quiet",
      ]);
    } else {
      this.logger.info(`Reusing existing clone at ${this.destPath}`);
    }
  }

  checkout(ref: string, date?: string) {
    this.logger.debug(`Fetching from origin`);
    execFileSync("git", ["fetch", "origin"], { cwd: this.destPath });
    if (date) {
      const target = Temporal.PlainDate.from(date)
        .toZonedDateTime({ timeZone: "UTC", plainTime: "00:00:01" })
        .startOfDay();
      this.logger.info(`Looking for commit on ${ref} at ${target.toString()}`);
      const hash = execFileSync(
        "git",
        ["rev-list", "-1", `--before=${target.toString()}`, ref],
        { cwd: this.destPath, encoding: "utf-8" },
      )
        .split("\n")
        .filter((line) => line.length > 0)
        .at(-1);
      if (!hash) {
        throw new Error(`Could not find commit near to ${target.toString()}`);
      }
      ref = hash;
    }

    this.logger.info(`Checking out ${ref}`);
    execFileSync("git", ["switch", "--quiet", "--detach", ref], {
      cwd: this.destPath,
      encoding: "utf-8",
    });
  }

  installDeps() {
    this.logger.info("Installing dependencies…");
    execFileSync("yarn", ["--silent"], {
      cwd: this.destPath,
      encoding: "utf-8",
      stdio: "ignore",
      env: { ...process.env, CI: "true" },
    });
  }

  loadInventory(): Promise<number | null> {
    const process = spawn(
      "yarn",
      ["--silent", "run", "content", "--quiet", "inventory"],
      { cwd: this.destPath },
    );

    process.stdout.setEncoding("utf-8");
    process.stderr.setEncoding("utf-8");
    process.stdout.on("data", (chunk: string) => {
      this.rawInventoryStdOut = this.rawInventoryStdOut + chunk;
    });
    process.stderr.on("data", (chunk: string) => {
      this.rawInventoryStdErr = this.rawInventoryStdErr + chunk;
    });

    return new Promise((resolve, reject) => {
      process.on("error", (err) => {
        reject(err);
      });

      process.on("close", (code) => {
        resolve(code);
      });
    });
  }

  loadRedirects() {
    this.rawRedirects = readFileSync(
      `${this.destPath}/files/en-us/_redirects.txt`,
      "utf8",
    );
  }

  metadata() {
    const readOpts: ExecFileSyncOptionsWithStringEncoding = {
      cwd: this.destPath,
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf-8",
    };

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

    return { commit, commitShort, authorDate };
  }

  inventory() {
    return JSON.parse(this.rawInventoryStdOut);
  }

  redirects() {
    if (this.rawRedirects === undefined) {
      throw new Error(
        "Redirects haven't been loaded. Did you call `init()` or `loadRedirects()` first?",
      );
    }

    const lines = this.rawRedirects.split("\n");
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
  }

  toObject() {
    return {
      metadata: this.metadata(),
      inventory: this.inventory(),
      redirects: this.redirects(),
    };
  }

  cleanUp() {
    this.logger.info("Cleaning up…");
    rmSync(this.destPath, { recursive: true, force: true });
  }
}
