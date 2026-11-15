#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DEFAULTS } = require('./lib/config.cjs');
const { toRelativePath, walkFiles } = require('./lib/source.cjs');
const { findColorCandidates } = require('./migrate-design-system.cjs');

/** Parses and validates the exception allowlist into keyed allowances. */
function loadAllowances(allowlistFile) {
  const allowed = JSON.parse(fs.readFileSync(allowlistFile, 'utf8'));
  if (!Array.isArray(allowed)) throw new Error(`Expected an array in ${allowlistFile}`);
  const allowances = new Map();
  for (const item of allowed) {
    if (!item.file || !item.value || !item.context
      || !Number.isInteger(item.maxOccurrences) || item.maxOccurrences < 1) {
      throw new Error(`Invalid color exception entry in ${allowlistFile}`);
    }
    const key = `${item.file}|${item.value.toLowerCase()}|${item.context}`;
    if (allowances.has(key)) throw new Error(`Duplicate color exception entry for ${key}`);
    allowances.set(key, { ...item, used: 0 });
  }
  return allowances;
}

function runLint(root, target, allowlistFile, logger = console) {
  const allowances = loadAllowances(allowlistFile);

  const files = walkFiles(path.resolve(root, target));
  const violations = [];
  const accepted = [];
  for (const file of files) {
    const relativePath = toRelativePath(root, file);
    const candidates = findColorCandidates(file, fs.readFileSync(file, 'utf8'), relativePath);
    for (const candidate of candidates) {
      const key = `${candidate.file}|${candidate.value.toLowerCase()}|${candidate.context}`;
      const allowance = allowances.get(key);
      // Past the documented cap, an allowed value becomes a violation like any
      // other: the cap is what keeps an exception from spreading.
      if (allowance && allowance.used < allowance.maxOccurrences) {
        allowance.used += 1;
        accepted.push(candidate);
      } else {
        violations.push(candidate);
      }
    }
  }

  for (const candidate of accepted) {
    logger.warn(`Allowed existing exception: ${candidate.file}:${candidate.line} ${candidate.value} (${candidate.context})`);
  }
  for (const candidate of violations) {
    logger.error(`Hard-coded color: ${candidate.file}:${candidate.line} ${candidate.value} (${candidate.context})`);
  }

  // An exception that no longer matches anything is stale: it either moved or
  // was already fixed, and leaving it behind quietly re-permits that color.
  const stale = [...allowances].filter(([, allowance]) => allowance.used === 0);
  for (const [key, allowance] of stale) {
    logger.error(`Stale color exception (matched nothing): ${key} -- remove it from ${toRelativePath(root, allowlistFile)}${allowance.reason ? ` ("${allowance.reason}")` : ''}`);
  }

  if (violations.length || stale.length) {
    logger.error(`Color check failed: ${violations.length} hard-coded color(s), ${stale.length} stale exception(s).`);
    return 1;
  }
  logger.log(`Color check passed: ${accepted.length} documented existing exception(s); no new hard-coded colors.`);
  return 0;
}

if (require.main === module) {
  try {
    const root = path.resolve(__dirname, '..');
    const target = process.argv[2] || DEFAULTS.target;
    const allowlist = path.resolve(root, process.argv[3] || DEFAULTS.exceptions);
    process.exitCode = runLint(root, target, allowlist);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { runLint };
