const fs = require('fs');

/**
 * Tiny .env loader for local MCP stdio launches.
 *
 * We intentionally avoid adding dotenv as a runtime dependency. This supports
 * the subset used by this project: KEY=value, optional single/double quotes,
 * blank lines, and # comments. Existing process.env values win so Hermes config
 * can override local files.
 */
function loadEnvFile(filePath, targetEnv = process.env) {
  if (!filePath || !fs.existsSync(filePath)) return { loaded: false, keys: [] };

  const keys = [];
  const text = fs.readFileSync(filePath, 'utf8');
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const eq = line.indexOf('=');
    if (eq <= 0) continue;

    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    if (Object.prototype.hasOwnProperty.call(targetEnv, key)) continue;

    let value = line.slice(eq + 1).trim();
    value = stripInlineComment(value);
    value = stripMatchingQuotes(value);
    value = expandHome(value, targetEnv);
    targetEnv[key] = value;
    keys.push(key);
  }

  return { loaded: true, keys };
}

function stripMatchingQuotes(value) {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1);
    }
  }
  return value;
}

function stripInlineComment(value) {
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    const prev = i > 0 ? value[i - 1] : '';
    if (ch === "'" && !inDouble && prev !== '\\') inSingle = !inSingle;
    if (ch === '"' && !inSingle && prev !== '\\') inDouble = !inDouble;
    if (ch === '#' && !inSingle && !inDouble && (i === 0 || /\s/.test(prev))) {
      return value.slice(0, i).trimEnd();
    }
  }

  return value;
}

function expandHome(value, targetEnv) {
  const home = targetEnv.HOME || process.env.HOME || '';
  if (!home) return value;
  return value
    .replace(/^\$HOME(?=\/|$)/, home)
    .replace(/^\$\{HOME\}(?=\/|$)/, home);
}

module.exports = { loadEnvFile };
