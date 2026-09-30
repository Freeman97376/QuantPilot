const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { isUtf8 } = require('buffer');
const zlib = require('zlib');

const root = process.cwd();
const registryPath = path.join(root, '.claude', 'skills.registry.json');
const skillsDir = path.join(root, '.claude', 'skills');
const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
const packageDir = path.join(root, registry.policy.packageDir || '.claude/skill-packages');
const lockPath = path.join(root, '.claude', 'skills.lock.json');
const SKILL_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const TAR_BLOCK_SIZE = 512;

function fail(message) {
  console.error(`[package-skills] ${message}`);
  process.exit(1);
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function listFiles(dir) {
  if (!fs.existsSync(dir)) {
    return [];
  }

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  return entries.flatMap((entry) => {
    if (entry.name === '.DS_Store') {
      return [];
    }

    const absolutePath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return listFiles(absolutePath);
    }
    if (!entry.isFile()) {
      return [];
    }
    return [absolutePath];
  }).sort();
}

function readPortableSourceFile(filePath) {
  const content = fs.readFileSync(filePath);
  if (content.includes(0) || !isUtf8(content)) {
    return content;
  }
  return Buffer.from(content.toString('utf8').replace(/\r\n/g, '\n'), 'utf8');
}

function hashSkillSource(skillId) {
  const sourceDir = path.join(skillsDir, skillId);
  const files = listFiles(sourceDir);
  const hash = crypto.createHash('sha256');
  for (const filePath of files) {
    const relativePath = path.relative(sourceDir, filePath).replaceAll(path.sep, '/');
    hash.update(relativePath);
    hash.update('\0');
    hash.update(readPortableSourceFile(filePath));
    hash.update('\0');
  }
  return {
    fileCount: files.length,
    sourceSha256: hash.digest('hex'),
  };
}

function readLockFile() {
  try {
    return JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  } catch {
    return {
      schemaVersion: 1,
      packageFormat: registry.policy.packageFormat || 'tgz',
      skills: {},
    };
  }
}

function writeLockFile(lock) {
  fs.writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`, 'utf8');
}

function getSkillVersion(skillId) {
  const coreSkill = registry.coreSkills.find((skill) => skill.id === skillId);
  return coreSkill?.version || null;
}

function writeTarString(buffer, offset, length, value) {
  const encoded = Buffer.from(value, 'utf8');
  if (encoded.length > length) {
    fail(`tar field is too long: ${value}`);
  }
  encoded.copy(buffer, offset);
}

function writeTarOctal(buffer, offset, length, value) {
  const encoded = value.toString(8).padStart(length - 1, '0');
  if (encoded.length > length - 1) {
    fail(`tar numeric field is too large: ${value}`);
  }
  buffer.write(encoded, offset, length - 1, 'ascii');
  buffer[offset + length - 1] = 0;
}

function splitTarPath(archivePath) {
  const normalized = archivePath.replace(/\/$/u, '');
  if (Buffer.byteLength(normalized, 'utf8') <= 100) {
    return { name: normalized, prefix: '' };
  }

  const segments = normalized.split('/');
  for (let index = segments.length - 1; index > 0; index -= 1) {
    const prefix = segments.slice(0, index).join('/');
    const name = segments.slice(index).join('/');
    if (Buffer.byteLength(prefix, 'utf8') <= 155 && Buffer.byteLength(name, 'utf8') <= 100) {
      return { name, prefix };
    }
  }
  fail(`path cannot be represented in ustar: ${archivePath}`);
}

function createTarHeader(archivePath, type, size) {
  const header = Buffer.alloc(TAR_BLOCK_SIZE);
  const { name, prefix } = splitTarPath(archivePath);
  writeTarString(header, 0, 100, name);
  writeTarOctal(header, 100, 8, type === 'directory' ? 0o755 : 0o644);
  writeTarOctal(header, 108, 8, 0);
  writeTarOctal(header, 116, 8, 0);
  writeTarOctal(header, 124, 12, type === 'directory' ? 0 : size);
  writeTarOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header[156] = type === 'directory' ? 0x35 : 0x30;
  writeTarString(header, 257, 6, 'ustar\0');
  writeTarString(header, 263, 2, '00');
  writeTarString(header, 265, 32, 'root');
  writeTarString(header, 297, 32, 'root');
  writeTarOctal(header, 329, 8, 0);
  writeTarOctal(header, 337, 8, 0);
  writeTarString(header, 345, 155, prefix);

  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  const encodedChecksum = checksum.toString(8).padStart(6, '0');
  if (encodedChecksum.length > 6) {
    fail(`tar checksum is too large for ${archivePath}`);
  }
  header.write(encodedChecksum, 148, 6, 'ascii');
  header[154] = 0;
  header[155] = 0x20;
  return header;
}

function buildReproducibleTar(skillId, sourceDir) {
  const files = listFiles(sourceDir).map((filePath) => {
    const relativePath = path.relative(sourceDir, filePath).replaceAll(path.sep, '/');
    return {
      archivePath: `${skillId}/${relativePath}`,
      content: readPortableSourceFile(filePath),
      type: 'file',
    };
  });
  const directoryPaths = new Set([skillId]);
  for (const file of files) {
    const segments = file.archivePath.split('/');
    for (let index = 1; index < segments.length; index += 1) {
      directoryPaths.add(segments.slice(0, index).join('/'));
    }
  }
  const entries = [
    ...Array.from(directoryPaths, (archivePath) => ({ archivePath, content: Buffer.alloc(0), type: 'directory' })),
    ...files,
  ].sort((left, right) => (left.archivePath < right.archivePath ? -1 : left.archivePath > right.archivePath ? 1 : 0));

  const chunks = [];
  for (const entry of entries) {
    chunks.push(createTarHeader(entry.archivePath, entry.type, entry.content.length));
    if (entry.type === 'file') {
      chunks.push(entry.content);
      const padding = (TAR_BLOCK_SIZE - (entry.content.length % TAR_BLOCK_SIZE)) % TAR_BLOCK_SIZE;
      if (padding > 0) chunks.push(Buffer.alloc(padding));
    }
  }
  chunks.push(Buffer.alloc(TAR_BLOCK_SIZE * 2));
  return Buffer.concat(chunks);
}

function packageSkill(skillId) {
  if (!SKILL_ID_PATTERN.test(skillId)) {
    fail(`invalid skill id: ${skillId}`);
  }
  const sourceDir = path.join(skillsDir, skillId);
  const skillFile = path.join(sourceDir, 'SKILL.md');
  if (!fs.existsSync(skillFile)) {
    fail(`SKILL.md not found for ${skillId}`);
  }

  const sourceHash = hashSkillSource(skillId);
  fs.mkdirSync(packageDir, { recursive: true });
  const outputPath = path.join(packageDir, `${skillId}.tgz`);
  const compressed = zlib.gzipSync(buildReproducibleTar(skillId, sourceDir), {
    level: zlib.constants.Z_BEST_COMPRESSION,
    mtime: 0,
  });
  if (compressed.length < 10 || compressed[0] !== 0x1f || compressed[1] !== 0x8b) {
    fail(`gzip failed for ${skillId}`);
  }
  compressed.fill(0, 4, 8);
  compressed[9] = 0xff;
  fs.writeFileSync(outputPath, compressed);
  const packageSha256 = sha256(fs.readFileSync(outputPath));
  return {
    outputPath,
    packageSha256,
    ...sourceHash,
  };
}

const rawArgs = process.argv.slice(2);
const includeLegacy = rawArgs.includes('--include-legacy');
const requested = rawArgs.filter((arg) => arg !== '--include-legacy');
const coreIds = registry.coreSkills.map((skill) => skill.id);
const aliasIds = Object.keys(registry.legacyAliases || {});
function resolvePackageSkillId(skillId) {
  const sourceDir = path.join(skillsDir, skillId);
  if (fs.existsSync(sourceDir)) {
    return skillId;
  }
  const target = registry.legacyAliases?.[skillId];
  if (target && fs.existsSync(path.join(skillsDir, target))) {
    console.log(`[package-skills] alias ${skillId} -> ${target}`);
    return target;
  }
  return skillId;
}

const rawSkillIds = requested.length ? requested : [...coreIds, ...(includeLegacy ? aliasIds : [])];
const skillIds = Array.from(new Set(rawSkillIds.map(resolvePackageSkillId)));
const lock = readLockFile();
lock.schemaVersion = 1;
lock.packageFormat = registry.policy.packageFormat || 'tgz';
lock.skills = lock.skills && typeof lock.skills === 'object' ? lock.skills : {};

for (const skillId of skillIds) {
  const output = packageSkill(skillId);
  lock.skills[skillId] = {
    version: getSkillVersion(skillId),
    packagePath: path.relative(root, output.outputPath).replaceAll(path.sep, '/'),
    sourceSha256: output.sourceSha256,
    packageSha256: output.packageSha256,
    fileCount: output.fileCount,
  };
  console.log(`[package-skills] ${skillId} -> ${path.relative(root, output.outputPath)}`);
}

writeLockFile(lock);
console.log(`[package-skills] lock -> ${path.relative(root, lockPath)}`);
