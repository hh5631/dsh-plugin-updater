const API = "https://api.github.com";
const RAW = "https://raw.githubusercontent.com";
const ARCHIVE = /\.(?:tgz|tar\.gz)$/i;
const REPOSITORY = /^([\w-]+)\/([\w.-]+?)(?:\.git)?$/;
const SHA = /^[\da-f]{7,40}$/i;

export function githubSource(source) {
  if (typeof source !== "string") return null;
  const shorthand = /^(?:github:|git@github\.com:)([^#]+)(?:#(.*))?$/i.exec(source);
  let project;
  let fragment;
  let asset;
  if (shorthand) {
    project = shorthand[1];
    fragment = shorthand[2];
  } else {
    let url;
    try {
      url = new URL(source.replace(/^git\+/, ""));
    } catch {
      return null;
    }
    if (url.hostname !== "github.com" || url.port || url.search
      || !["https:", "http:", "ssh:", "git:"].includes(url.protocol)) return null;
    const [, owner, repo, ...path] = url.pathname.replace(/\/$/, "").split("/");
    project = owner + "/" + repo;
    if (path.length) {
      const [releases, first, second, third] = path;
      if (releases !== "releases" || path.length !== 4
        || !(first === "download" || first === "latest" && second === "download")
        || !ARCHIVE.test(third) || !["https:", "http:"].includes(url.protocol)) return null;
      try {
        asset = decodeURIComponent(third);
      } catch {
        return null;
      }
    }
    fragment = url.hash.slice(1);
  }
  const repo = REPOSITORY.exec(project);
  if (!repo || repo[2] === "." || repo[2] === "..") return null;
  let ref = "";
  let directory = "";
  for (const part of (fragment ?? "").split("&")) {
    let value;
    try {
      value = decodeURIComponent(part);
    } catch {
      return null;
    }
    if (value.startsWith("path:")) {
      directory = value.slice(5).replace(/^\/+|\/+$/g, "");
      if (!directory || directory.split("/").some((segment) => !segment || segment === "." || segment === ".."
        || !/^[\w.@-]+$/.test(segment))) return null;
    } else if (value && !ref) {
      ref = value;
    } else if (value) {
      return null;
    }
  }
  return { project: repo[1] + "/" + repo[2], asset, ref, directory };
}

export function createGitHubReader(ghApi) {
  // One request per repository endpoint during a scan, even for monorepos.
  const cache = new Map();
  let rateLimitedUntil = 0;
  return async function read(url) {
    const cached = cache.get(url);
    if (cached?.until > Date.now()) return cached.promise;
    const promise = (async () => {
      const apiPath = url.startsWith(API + "/") ? url.slice(API.length) : null;
      if (apiPath && rateLimitedUntil > Date.now()) return ghApi(apiPath);
      const response = await fetch(url, {
        headers: { accept: "application/json", "user-agent": "dsh-plugin-updater" },
        signal: AbortSignal.timeout(6_000),
      });
      if (response.ok) return response.json();
      if (response.status === 404) return null;
      if (apiPath && [401, 403, 429].includes(response.status)) {
        try {
          const result = await ghApi(apiPath);
          if (response.headers.get("x-ratelimit-remaining") === "0") rateLimitedUntil = Date.now() + 60_000;
          return result;
        } catch {
          // Keep the GitHub status when gh is absent or cannot authenticate.
        }
      }
      throw new Error(`GitHub HTTP ${response.status}`);
    })();
    if (cache.size >= 256) cache.delete(cache.keys().next().value);
    const entry = { until: Date.now() + 20_000, promise };
    cache.set(url, entry);
    try {
      return await promise;
    } catch (error) {
      if (cache.get(url) === entry) cache.delete(url);
      throw error;
    }
  };
}

function assetStem(name) {
  return name.replace(ARCHIVE, "").replace(/[-_.]v?\d+\.\d+\.\d+(?:[-+].*)?$/i, "").toLowerCase();
}

function releaseAsset(release, source, name) {
  const names = new Set(source.asset
    ? [assetStem(source.asset)]
    : [name.split("/").at(-1).toLowerCase(), name.replace(/^@/, "").replace("/", "-").toLowerCase()]);
  const tag = encodeURIComponent(release.tag_name);
  const assets = (release.assets ?? []).filter((asset) => asset.state === "uploaded"
    && ARCHIVE.test(asset.name) && names.has(assetStem(asset.name)));
  const chosen = assets.find((asset) => asset.name === source.asset)
    ?? (assets.length === 1 ? assets[0] : null);
  if (!chosen || /[/\\]/.test(chosen.name)) return null;
  const spec = `https://github.com/${source.project}/releases/download/${tag}/${encodeURIComponent(chosen.name)}`;
  return spec;
}

function gitSpec(source, commit) {
  return `github:${source.project}#${commit}${source.directory ? `&path:/${source.directory}` : ""}`;
}

export async function findGitHubUpdate(pkg, source, { read, semver, compatible }) {
  const endpoint = `${API}/repos/${source.project}`;
  const range = source.ref.startsWith("semver:") ? source.ref.slice(7) : null;
  const newer = (version) => semver.valid(version) && !semver.prerelease(version)
    && semver.gt(version, pkg.version) && (!range || semver.satisfies(version, range));
  const makeTarget = (version, spec) => ({ version, spec, repository: source.project });
  const readManifest = async (ref) => {
    const path = source.directory ? source.directory.split("/").map(encodeURIComponent).join("/") + "/" : "";
    return read(`${RAW}/${source.project}/${encodeURIComponent(ref)}/${path}package.json`);
  };
  const validManifest = (manifest) => manifest?.name === pkg.name && manifest.dsh?.bundle
    && newer(manifest.version) && compatible(manifest);

  const releases = await read(endpoint + "/releases?per_page=10");
  if (!releases) throw new Error("GitHub repository is unavailable");
  const published = releases.filter((release) => !release.draft && !release.prerelease && newer(release.tag_name))
    .sort((a, b) => semver.rcompare(a.tag_name, b.tag_name));
  for (const release of published) {
    const spec = releaseAsset(release, source, pkg.name);
    if (!spec) continue;
    const manifest = await readManifest(release.tag_name).catch(() => null);
    if (manifest?.name === pkg.name) {
      if (!newer(manifest.version) || !compatible(manifest)) continue;
      return makeTarget(manifest.version, spec);
    }
    return makeTarget(semver.valid(release.tag_name), spec);
  }
  if (source.asset) return null;

  const tags = await read(endpoint + "/tags?per_page=30") ?? [];
  const newerTags = tags.filter(({ name, commit }) => newer(name) && SHA.test(commit?.sha ?? ""))
    .sort((a, b) => semver.rcompare(a.name, b.name));
  for (const { commit } of newerTags.slice(0, 3)) {
    const manifest = await readManifest(commit.sha);
    if (validManifest(manifest)) return makeTarget(manifest.version, gitSpec(source, commit.sha));
  }

  // Untagged packages can still publish a newer package version on their default branch.
  if (range || source.ref && !SHA.test(source.ref) && !semver.valid(source.ref)) return null;
  const manifest = await readManifest("HEAD");
  if (!validManifest(manifest)) return null;
  const commits = await read(endpoint + "/commits?per_page=1");
  const commit = commits?.[0]?.sha;
  if (!SHA.test(commit ?? "")) return null;
  const exact = await readManifest(commit);
  return validManifest(exact) ? makeTarget(exact.version, gitSpec(source, commit)) : null;
}
