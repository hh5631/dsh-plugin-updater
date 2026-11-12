import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import { createGitHubReader, findGitHubUpdate, githubSource } from "./github.js";

const run = promisify(execFile);
const ROUTE = "/dsh-plugin-updater/api";
const CHECK_TTL = 20_000;
const UPDATE_CONCURRENCY = 3;
const badApplication = (value) => value?.application === "failed" || value?.application === "cancelled";
const messageOf = (error) => error instanceof Error ? error.message : String(error);

function updaterKind(pkg) {
  if (!pkg?.installed || pkg.availability !== "profile" || pkg.official || pkg.readOnlyReason || !pkg.version) return null;
  if (pkg.updatable) return "registry";
  return githubSource(pkg.source) ? "github" : null;
}

async function readRequest(req) {
  if (req.headers["content-type"]?.split(";")[0] !== "application/json") throw new Error("Expected JSON");
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 4096) throw new Error("Request too large");
  }
  const { action, name, from, version } = JSON.parse(body);
  if (!["check", "update"].includes(action) || typeof name !== "string" || name.length > 214
    || !/^(@[\w.-]+\/)?[\w.-]+$/.test(name) || typeof from !== "string" || from.length > 128
    || action === "update" && (typeof version !== "string" || version.length > 128)) {
    throw new Error("Invalid update request");
  }
  return { action, name, from, version };
}

function send(res, status, value) {
  if (res.destroyed) return;
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(value));
}

function matchesGitHub(current, pkg) {
  return current?.version === pkg.version && current.source === pkg.source && updaterKind(current) === "github";
}

async function replaceGitHub(manager, jobs) {
  const first = jobs[0];
  let recovered = true;
  const result = await manager.change(async (result) => {
    const current = new Map((await manager.listBundles()).map((bundle) => [bundle.name, bundle]));
    if (jobs.some(({ pkg }) => !matchesGitHub(current.get(pkg.name), pkg))) {
      throw new Error("Installed plugin changed. Check for updates again.");
    }
    const files = await manager.readRestoredFiles();
    try {
      recovered = false;
      const specs = jobs.map(({ pkg, target }) => `${pkg.name}@${target.spec}`);
      // A single pnpm process can fetch all archives concurrently while it owns the profile lock.
      const installed = await manager.runPnpm(["add", ...specs, "--save-exact", "--prefer-offline", "--network-concurrency=3"]);
      result.packageResult = installed;
      if (installed.exitCode !== 0 || installed.timedOut) throw new Error(installed.output || "pnpm add failed");
      const next = new Map((await manager.listBundles()).map((bundle) => [bundle.name, bundle]));
      const ids = [];
      for (const { pkg, target } of jobs) {
        const bundle = next.get(pkg.name);
        if (bundle?.version !== target.version || bundle.error || !githubSource(bundle.source)) {
          throw new Error(`${pkg.name}: GitHub package did not match the expected plugin and version`);
        }
        if (bundle.enabled) ids.push(...bundle.rows.map((row) => row.rowId));
      }
      result.bundle = first.pkg.name;
      result.version = first.target.version;
      Object.assign(result, await manager.configure(() => manager.publishAndReload(ids)));
    } catch (error) {
      await manager.restoreFiles(files);
      const hasLock = [...files].some(([path, content]) => path.endsWith("pnpm-lock.yaml") && content !== undefined);
      const repair = await manager.runPnpm(["install", hasLock ? "--frozen-lockfile" : "--config.lockfile=false", "--prefer-offline"]);
      if (repair.exitCode !== 0 || repair.timedOut) {
        throw new Error(`${messageOf(error)}. Profile files were restored but reinstalling dependencies failed: ${repair.output}`);
      }
      await manager.configure(() => manager.publishAndReload());
      recovered = true;
      throw error;
    }
  }, { stage: "install", target: first.pkg.name }, "install", { target: first.pkg.name, version: first.target.version });
  return { result, recovered };
}

function outcome({ result, restore }) {
  if (badApplication(result)) {
    const diagnostic = result.error?.diagnostic || result.packageResult?.output || result.error?.code;
    const recovery = badApplication(restore) ? `; restore failed: ${restore.error?.diagnostic ?? restore.error?.code}` : "";
    throw new Error((diagnostic || "Update failed") + recovery);
  }
  return { restart: result.application === "restart-required" };
}

export function createUpdater(manager, { semver, compatible, read, warm }) {
  const checks = new Map();
  const updates = new Map();
  let tail = Promise.resolve();
  let inventory;
  let inventoryAt = 0;
  let githubQueue = [];
  let githubTimer;

  async function installed(name, from, fresh = false) {
    if (fresh || Date.now() >= inventoryAt) {
      inventory = manager.listBundles();
      inventoryAt = Date.now() + 350;
    }
    const pkg = (await inventory).find((item) => item.name === name);
    if (!updaterKind(pkg) || pkg.version !== from) throw new Error("Installed plugin changed. Check for updates again.");
    return pkg;
  }

  async function check(pkg) {
    const key = JSON.stringify([pkg.name, pkg.version, pkg.source]);
    const cached = checks.get(key);
    if (cached?.until > Date.now()) return cached.promise;
    const promise = (async () => {
      if (!semver.valid(pkg.version)) return null;
      if (pkg.updatable) {
        const list = await manager.listVersions(pkg.name, {}, AbortSignal.timeout(22_000));
        if (list.status !== "listed") throw new Error(list.reason || "Registry lookup failed");
        if (list.installed !== pkg.version) throw new Error("Installed plugin changed. Check for updates again.");
        const candidate = list.versions.find((item) => item.bundle && !item.incompatible && !item.deprecated && !item.prerelease);
        return candidate ? { version: candidate.version, registry: list.registry, spec: `${pkg.name}@${candidate.version}` } : null;
      }
      return findGitHubUpdate(pkg, githubSource(pkg.source), { read, semver, compatible });
    })();
    if (checks.size >= 256) checks.delete(checks.keys().next().value);
    const entry = { until: Date.now() + CHECK_TTL, promise };
    checks.set(key, entry);
    try {
      const target = await promise;
      entry.until = Date.now() + CHECK_TTL;
      return target;
    } catch (error) {
      if (checks.get(key) === entry) checks.delete(key);
      throw error;
    }
  }

  function commit(task) {
    const settled = tail.then(task).finally(() => { inventoryAt = 0; });
    tail = settled.catch(() => {});
    return settled;
  }

  function flushGitHub() {
    clearTimeout(githubTimer);
    githubTimer = undefined;
    const jobs = githubQueue;
    githubQueue = [];
    commit(async () => {
      const current = new Map((await manager.listBundles()).map((pkg) => [pkg.name, pkg]));
      const ready = jobs.filter(({ pkg, reject }) => {
        if (matchesGitHub(current.get(pkg.name), pkg)) return true;
        reject(new Error("Installed plugin changed. Check for updates again."));
        return false;
      });
      if (!ready.length) return;
      const batch = await replaceGitHub(manager, ready);
      if (!badApplication(batch.result) || !batch.recovered || ready.length === 1) {
        const value = outcome(batch);
        for (const job of ready) job.resolve(value);
        return;
      }
      // Retry independently after a full rollback so one bad archive cannot block the rest.
      for (const job of ready) {
        const single = await replaceGitHub(manager, [job]);
        try {
          job.resolve(outcome(single));
        } catch (error) {
          job.reject(error);
          if (!single.recovered) throw error;
        }
      }
    }).catch((error) => {
      for (const job of jobs) job.reject(error);
    });
  }

  async function update({ name, from, version }) {
    const pkg = await installed(name, from, true);
    const target = await check(pkg);
    if (target?.version !== version) throw new Error("Update target changed. Check for updates again.");
    if (!pkg.updatable) {
      return new Promise((resolve, reject) => {
        githubQueue.push({ pkg, target, resolve, reject });
        if (githubQueue.length === UPDATE_CONCURRENCY) flushGitHub();
        else githubTimer ??= setTimeout(flushGitHub, 35);
      });
    }
    // Warm the registry store outside DSH's profile lock.
    await warm(target).catch(() => {});
    return commit(async () => {
      const current = await installed(name, from, true);
      if (current.source !== pkg.source) throw new Error("Installed source changed. Check for updates again.");
      return outcome(await manager.updateBundle(name, version, { registry: target.registry }));
    });
  }

  return async ({ action, name, from, version }) => {
    if (action === "check") {
      const target = await check(await installed(name, from));
      return { target: target ? { version: target.version, repository: target.repository } : null };
    }
    const pending = updates.get(name);
    if (pending) {
      if (pending.from === from && pending.version === version) return pending.promise;
      throw new Error("An update for this plugin is already running");
    }
    const promise = update({ name, from, version }).finally(() => updates.delete(name));
    updates.set(name, { from, version, promise });
    return promise;
  };
}

export function apply(ctx) {
  ctx.inject(["connection", "webServer", "pluginManager", "profileContext"], (host) => {
    const profile = host.profileContext;
    const require = createRequire(profile.installAnchor);
    const semver = require("semver");
    const boot = require("@deepseek-ai/dsh-app-boot");
    const { scrubbedParentEnv } = require("@deepseek-ai/dsh-subprocess");
    const manager = host.pluginManager;
    const read = createGitHubReader(async (path) => {
      const { stdout } = await run("gh", ["api", path], { timeout: 5_000, maxBuffer: 2 * 1024 * 1024, windowsHide: true });
      return JSON.parse(stdout);
    });
    const dispatch = createUpdater(manager, {
      semver,
      read,
      compatible(manifest) {
        const issue = boot.evaluatePluginCompatibility(manifest, boot.readProfileVersionExemptions(profile.dir));
        if (issue && !issue.exempted) return false;
        try {
          boot.assertBundlePlatform(manifest.dsh?.bundle?.platforms, process.platform);
          return true;
        } catch {
          return false;
        }
      },
      warm({ spec, registry }) {
        const config = profile.packageManager;
        const flags = typeof registry === "string" ? [`--registry=${registry}`] : [];
        return run(config?.command ?? manager.pnpmCommand, [
          ...config?.args ?? [], "store", "add", spec, "--ignore-scripts", "--fetch-retries=0", ...flags,
        ], { cwd: profile.dir, env: { ...scrubbedParentEnv(), ...config?.env }, timeout: 20_000, windowsHide: true });
      },
    });
    host.effect(() => host.webServer.register({
      kind: "exact",
      path: ROUTE,
      handler: async (req, res) => {
        const rejected = host.connection.requestRejection(req);
        if (rejected) return send(res, rejected, { error: "Unauthorized" });
        if (req.method !== "POST") return send(res, 405, { error: "Expected POST" });
        try {
          const result = await dispatch(await readRequest(req));
          send(res, 200, result);
        } catch (error) {
          send(res, 400, { error: messageOf(error).slice(-2000) });
        }
      },
    }), "dsh-plugin-updater: authenticated update route");
  });
}
