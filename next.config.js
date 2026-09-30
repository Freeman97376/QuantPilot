const path = require('path');

const isStandaloneBuild = process.env.QUANTPILOT_STANDALONE_BUILD === '1';
const projectRoot = __dirname;

function normalizeDistDir(value) {
  const raw = (value ?? '').trim();
  if (!raw) return '';
  if (path.isAbsolute(raw) || raw.split(/[\\/]+/).includes('..')) {
    throw new Error('QUANTPILOT_NEXT_DIST_DIR must be a relative directory inside the repository.');
  }
  return raw.replace(/[\\/]+$/, '');
}

function normalizeBasePath(value) {
  const raw = (value ?? '').trim();
  if (!raw || raw === '/') {
    return '';
  }
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(raw) || raw.includes('?') || raw.includes('#')) {
    throw new Error('NEXT_PUBLIC_BASE_PATH must be a URL path such as /smartstock, not a full URL.');
  }

  const normalized = `/${raw.replace(/^\/+|\/+$/g, '')}`;
  if (normalized.includes('//')) {
    throw new Error('NEXT_PUBLIC_BASE_PATH must not contain repeated slashes.');
  }
  return normalized;
}

const basePath = normalizeBasePath(process.env.NEXT_PUBLIC_BASE_PATH);
const publicApiBase = process.env.NEXT_PUBLIC_API_BASE?.trim() || basePath;
const distDir = normalizeDistDir(process.env.QUANTPILOT_NEXT_DIST_DIR);
const tracingExcludes = [
  './.git/**',
  './.next/**',
  './.next-candidate/**',
  './.next-rollback/**',
  './.turbo/**',
  './.ruff_cache/**',
  './.pytest_cache/**',
  './.pytest-tmp/**',
  './data/**',
  './tmp/**',
  './services/market-data/.venv/**',
  './services/market-data/.pytest_cache/**',
  './services/market-data/.pytest-tmp/**',
  './services/**/.venv/**',
  './services/**/.ruff_cache/**',
  './coverage/**',
  './dist/**',
  './build/**',
  './out/**',
  './node_modules/.cache/**',
];
const tracePluginIgnores = [
  '**/.git/**',
  '**/.next/**',
  '**/.next-candidate/**',
  '**/.next-rollback/**',
  '**/.turbo/**',
  '**/.ruff_cache/**',
  '**/.pytest_cache/**',
  '**/.pytest-tmp/**',
  '**/data/**',
  '**/tmp/**',
  '**/services/market-data/.venv/**',
  '**/services/**/.venv/**',
  '**/services/**/.ruff_cache/**',
];

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  basePath,
  productionBrowserSourceMaps: false,
  devIndicators: false,
  allowedDevOrigins: ['127.0.0.1'],
  ...(isStandaloneBuild ? { output: 'standalone' } : {}),
  ...(distDir ? { distDir } : {}),
  // Agent、数据库和本地进程管理只在 Node.js API Route 中运行，构建时保持外部依赖。
  serverExternalPackages: [
    '@anthropic-ai/claude-agent-sdk',
    '@prisma/client',
    '@quantpilot/prisma-desktop-client',
    '@node-rs/argon2',
    'prisma',
    'ws',
  ],
  // 关闭 critters 的 CSS 优化，避免构建时缺少可选依赖。
  experimental: {
    optimizeCss: false,
    scrollRestoration: true,
    webpackMemoryOptimizations: true,
    webpackBuildWorker: true,
  },
  // Next 16 defaults dev mode to Turbopack and errors when a webpack() hook
  // exists without a turbopack key.
  turbopack: {},
  outputFileTracingRoot: projectRoot,
  // 工作区数据、历史项目、本地缓存和 Git 元数据不属于构建产物，避免 trace 扫全仓库。
  outputFileTracingExcludes: {
    '*': tracingExcludes,
    '/api/**': tracingExcludes,
  },
  webpack(config, { isServer }) {
    if (isServer) {
      config.plugins = (config.plugins || []).filter((plugin) => {
        if (plugin?.constructor?.name !== 'TraceEntryPointsPlugin') {
          return true;
        }
        if (plugin?.constructor?.name === 'TraceEntryPointsPlugin' && Array.isArray(plugin.traceIgnores)) {
          plugin.traceIgnores.push(...tracePluginIgnores);
        }
        return true;
      });
    }
    return config;
  },
  // 注入项目根路径，供前端读取当前工作区信息。避免在配置里调用 process.cwd()，
  // 防止输出追踪误判为需要扫描整个仓库。
  async redirects() { return [{ source: '/observability', destination: '/workspaces?view=trace', permanent: true }]; },
  env: {
    NEXT_PUBLIC_PROJECT_ROOT: process.env.NEXT_PUBLIC_PROJECT_ROOT || '',
    NEXT_PUBLIC_BASE_PATH: basePath,
    NEXT_PUBLIC_API_BASE: publicApiBase,
    NEXT_PUBLIC_RUNTIME_MODE: process.env.NEXT_PUBLIC_RUNTIME_MODE || process.env.QUANTPILOT_RUNTIME_MODE || 'server',
  },
};

module.exports = nextConfig;
