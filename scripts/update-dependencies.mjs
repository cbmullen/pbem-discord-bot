import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

function majorVersion(version) {
  const match = version?.match(/^(?:[~^=v\s]*)?(\d+)\./);
  return match ? Number(match[1]) : null;
}

export function classifyUpdates(manifest, outdated) {
  const updates = [];
  const majorUpdates = [];

  for (const [name, info] of Object.entries(outdated)) {
    const section = ["dependencies", "devDependencies", "optionalDependencies"]
      .find((key) => manifest[key]?.[name] !== undefined);
    if (!section || !info.latest) continue;

    const currentMajor = majorVersion(info.current) ??
      majorVersion(manifest[section][name]);
    const latestMajor = majorVersion(info.latest);
    if (currentMajor === null || latestMajor === null) {
      throw new Error(`Could not determine the major version for ${name}.`);
    }

    const update = {
      name,
      current: manifest[section][name],
      latest: info.latest,
    };
    if (latestMajor > currentMajor) {
      majorUpdates.push(update);
    }
    manifest[section][name] = `^${info.latest}`;
    updates.push(update);
  }

  return { updates, majorUpdates };
}

function setOutput(name, value) {
  const outputFile = process.env.GITHUB_OUTPUT;
  if (!outputFile) return;
  const escaped = String(value).replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
  return writeFile(outputFile, `${name}=${escaped}\n`, { flag: "a" });
}

async function main() {
  const manifestPath = new URL("../package.json", import.meta.url);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const outdatedResult = spawnSync("npm", ["outdated", "--json"], {
    encoding: "utf8",
  });
  if (outdatedResult.error) throw outdatedResult.error;

  let outdated;
  try {
    outdated = JSON.parse(outdatedResult.stdout || "{}");
  } catch {
    throw new Error(
      `Could not parse npm outdated output: ${outdatedResult.stderr || outdatedResult.stdout}`,
    );
  }
  if (
    outdatedResult.status !== 0 &&
    Object.keys(outdated).length === 0
  ) {
    throw new Error(
      `npm outdated failed (${outdatedResult.status}): ${outdatedResult.stderr || outdatedResult.stdout}`,
    );
  }

  const { updates, majorUpdates } = classifyUpdates(manifest, outdated);
  if (updates.length > 0) {
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  }

  const majorMessage = majorUpdates.length > 0
    ? [
        "Major dependency updates are available for cbmullen/pbem-discord-bot:",
        ...majorUpdates.map(({ name, current, latest }) => `- ${name}: ${current} -> ${latest}`),
      ].join("\n")
    : "";

  await setOutput("has_updates", updates.length > 0);
  await setOutput("has_major_updates", majorUpdates.length > 0);
  await setOutput("major_message", majorMessage);
  console.log(`Dependency updates: ${updates.length}`);
  console.log(`Major updates requiring review: ${majorUpdates.length}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
