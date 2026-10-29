import assert from "node:assert/strict";
import test from "node:test";
import { classifyUpdates } from "./update-dependencies.mjs";

test("classifies same-major updates for automatic bumps", () => {
  const manifest = {
    dependencies: { "@vercel/functions": "^2.2.13" },
  };
  const result = classifyUpdates(manifest, {
    "@vercel/functions": { current: "2.2.13", latest: "2.5.0" },
  });

  assert.deepEqual(result.updates, [
    { name: "@vercel/functions", current: "^2.2.13", latest: "2.5.0" },
  ]);
  assert.equal(manifest.dependencies["@vercel/functions"], "^2.5.0");
  assert.deepEqual(result.majorUpdates, []);
});

test("includes newer major versions for PR and webhook notification", () => {
  const manifest = {
    devDependencies: { typescript: "^5.9.3" },
  };
  const result = classifyUpdates(manifest, {
    typescript: { current: "5.9.3", latest: "6.0.0" },
  });

  assert.deepEqual(result.updates, [
    { name: "typescript", current: "^5.9.3", latest: "6.0.0" },
  ]);
  assert.deepEqual(result.majorUpdates, [
    { name: "typescript", current: "^5.9.3", latest: "6.0.0" },
  ]);
  assert.equal(manifest.devDependencies.typescript, "^6.0.0");
});

test("does not treat a zero-major minor release as a major update", () => {
  const manifest = {
    dependencies: { package: "^0.2.0" },
  };
  const result = classifyUpdates(manifest, {
    package: { current: "0.2.0", latest: "0.3.0" },
  });

  assert.equal(result.majorUpdates.length, 0);
  assert.equal(manifest.dependencies.package, "^0.3.0");
});
