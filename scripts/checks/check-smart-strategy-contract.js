#!/usr/bin/env node

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const ts = require('typescript');

const ROOT = process.cwd();
const moduleCache = new Map();

function resolveTypeScriptModule(request, fromFile) {
  const unresolved = request.startsWith('@/')
    ? path.join(ROOT, 'src', request.slice(2))
    : request.startsWith('.')
      ? path.resolve(path.dirname(fromFile), request)
      : null;
  if (!unresolved) return null;
  for (const candidate of [unresolved, `${unresolved}.ts`, `${unresolved}.tsx`, path.join(unresolved, 'index.ts')]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  throw new Error(`Unable to resolve ${request} from ${fromFile}`);
}

function loadTypeScriptModule(filePath) {
  const absolutePath = path.resolve(filePath);
  if (moduleCache.has(absolutePath)) return moduleCache.get(absolutePath).exports;

  const moduleRecord = { exports: {} };
  moduleCache.set(absolutePath, moduleRecord);
  const source = fs.readFileSync(absolutePath, 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: {
      esModuleInterop: true,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
    fileName: absolutePath,
  }).outputText;
  const localRequire = (request) => {
    const resolved = resolveTypeScriptModule(request, absolutePath);
    return resolved ? loadTypeScriptModule(resolved) : require(request);
  };
  const execute = new Function('require', 'module', 'exports', '__filename', '__dirname', output);
  execute(localRequire, moduleRecord, moduleRecord.exports, absolutePath, path.dirname(absolutePath));
  return moduleRecord.exports;
}

function compilePrompt(prompt, strategyIntent) {
  const intents = strategyIntent.parseStrategyIntent({ prompt });
  return strategyIntent.compileIntentToTechnicalSpec({ prompt, intents, limit: 20 });
}

function meaningfulFields(draft) {
  return draft.spec.conditions
    .map((condition) => condition.field)
    .filter((field) => !['sample_count', 'is_st', 'is_limit_up'].includes(field));
}

async function main() {
  const strategyIntent = loadTypeScriptModule(path.join(ROOT, 'src/lib/quant/strategy-intent.ts'));
  const smartStrategy = loadTypeScriptModule(path.join(ROOT, 'src/lib/quant/smart-strategy.ts'));

  const defaultPrompt = '选出 MACD 金叉，成交额较 20 日均额放大 1.5 倍，收盘价站上 MA20，RSI 不高于 70 的股票';
  const defaultDraft = compilePrompt(defaultPrompt, strategyIntent);
  assert.deepEqual(
    new Set(meaningfulFields(defaultDraft)),
    new Set(['close', 'amount_ratio_20d', 'macd_dif', 'rsi14']),
    'the first-run template must compile to the four expected controlled fields'
  );

  const oralDraft = compilePrompt('寻找站上20日均线、成交额放大、MACD金叉且RSI不过热的股票', strategyIntent);
  const oralFields = meaningfulFields(oralDraft);
  assert(oralFields.includes('close'), 'oral MA wording must map to close versus MA20');
  assert(oralFields.includes('rsi14'), 'RSI overheat wording must map to RSI14');
  assert(!oralFields.includes('strength_20d_pct'), 'RSI overheat must not add a duplicate strength cap');

  const volumeDraft = compilePrompt('寻找成交量较20日均量放大 1.8 倍的股票', strategyIntent);
  assert(meaningfulFields(volumeDraft).includes('volume_ratio_20d'), 'explicit volume wording must use the volume ratio field');
  assert(!meaningfulFields(volumeDraft).includes('amount_ratio_20d'), 'explicit volume wording must not be approximated as amount ratio');
  assert.equal(volumeDraft.spec.sort.field, 'volume_ratio_20d');

  const quickTemplateCases = [
    {
      prompt: '选出 MA5 > MA10 > MA20，收盘价站上 MA5，20日涨幅大于 8%，RSI14 不高于 70 的股票',
      fields: ['ma5', 'ma10', 'close', 'strength_20d_pct', 'rsi14'],
    },
    {
      prompt: '选出均线多头，成交额放大 1.5 倍，不要长上影线，上影线小于 3%，收盘靠近高点',
      fields: ['ma5', 'ma10', 'amount_ratio_20d', 'upper_shadow_pct', 'close_position_pct'],
    },
    {
      prompt: '选出 MA20 斜率大于 2%，同时不是冲高回落的股票',
      fields: ['ma20_slope_5d_pct', 'upper_shadow_pct', 'close_position_pct'],
    },
    {
      prompt: '选出收盘价站上年线，MA120 也在 MA250 上方，成交额活跃且不是 ST 的股票',
      fields: ['close', 'ma120', 'amount_ratio_20d'],
    },
  ];
  for (const testCase of quickTemplateCases) {
    const fields = meaningfulFields(compilePrompt(testCase.prompt, strategyIntent));
    for (const expectedField of testCase.fields) {
      assert(fields.includes(expectedField), `${testCase.prompt} must include ${expectedField}`);
    }
  }

  const unsupportedDraft = compilePrompt('寻找主力资金流入且 KDJ 金叉的股票', strategyIntent);
  assert(unsupportedDraft.unsupportedTerms.includes('资金流'));
  assert(unsupportedDraft.unsupportedTerms.includes('主力'));
  assert(unsupportedDraft.unsupportedTerms.includes('KDJ'));
  assert.equal(meaningfulFields(unsupportedDraft).length, 0, 'unsupported concepts must not be approximated');

  const conflictingDraft = compilePrompt('寻找长上影线，同时不要长上影线的股票', strategyIntent);
  assert.equal(conflictingDraft.clarificationNeeded, true, 'conflicting candle requirements must require clarification');

  const savedEnvironment = {
    DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY,
    DEEPSEEK_BASE_URL: process.env.DEEPSEEK_BASE_URL,
    DEEPSEEK_MODEL: process.env.DEEPSEEK_MODEL,
    DEEPSEEK_TIMEOUT_MS: process.env.DEEPSEEK_TIMEOUT_MS,
  };
  const originalFetch = global.fetch;

  try {
    delete process.env.DEEPSEEK_API_KEY;
    delete process.env.DEEPSEEK_BASE_URL;
    const missingConfig = await smartStrategy.buildDeepSeekStrategyIntents({ prompt: defaultPrompt, limit: 20 });
    assert.equal(missingConfig.generatedBy, 'rule-template', 'missing DeepSeek config must use the local fallback');

    process.env.DEEPSEEK_API_KEY = 'contract-test-key';
    process.env.DEEPSEEK_BASE_URL = 'https://api.deepseek.com/chat/completions/';
    process.env.DEEPSEEK_MODEL = 'contract-test-model';
    process.env.DEEPSEEK_TIMEOUT_MS = '100';
    let capturedRequest = null;
    global.fetch = async (url, options) => {
      capturedRequest = { url: String(url), body: JSON.parse(options.body) };
      return {
        ok: true,
        json: async () => ({
          model: 'contract-test-model',
          choices: [{ message: { content: JSON.stringify({ dataProfile: 'daily_eod', intents: [] }) } }],
        }),
      };
    };
    const deepSeekResult = await smartStrategy.buildDeepSeekStrategyIntents({ prompt: defaultPrompt, limit: 20 });
    assert.equal(deepSeekResult.generatedBy, 'deepseek');
    assert.equal(capturedRequest.url, 'https://api.deepseek.com/chat/completions');
    assert.deepEqual(capturedRequest.body.response_format, { type: 'json_object' });
    assert.deepEqual(capturedRequest.body.thinking, { type: 'disabled' });
    assert.equal(capturedRequest.body.max_tokens, 2048);

    global.fetch = async () => ({ ok: false, status: 500, text: async () => 'provider failed' });
    const providerFailure = await smartStrategy.buildDeepSeekStrategyIntents({ prompt: defaultPrompt });
    assert.equal(providerFailure.generatedBy, 'rule-template', 'provider errors must use the local fallback');

    global.fetch = async () => ({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'not-json' } }] }),
    });
    const invalidJson = await smartStrategy.buildDeepSeekStrategyIntents({ prompt: defaultPrompt });
    assert.equal(invalidJson.generatedBy, 'rule-template', 'invalid provider JSON must use the local fallback');

    process.env.DEEPSEEK_TIMEOUT_MS = '2';
    global.fetch = async (_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      }, { once: true });
    });
    const timeout = await smartStrategy.buildDeepSeekStrategyIntents({ prompt: defaultPrompt });
    assert.equal(timeout.generatedBy, 'rule-template', 'provider timeouts must use the local fallback');

    process.env.DEEPSEEK_BASE_URL = 'https://user:password@api.deepseek.com';
    assert.equal(smartStrategy.getSmartStrategyRuntimeStatus().configured, false, 'embedded endpoint credentials must be rejected');
  } finally {
    global.fetch = originalFetch;
    for (const [key, value] of Object.entries(savedEnvironment)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }

  console.log('Smart strategy contract checks passed.');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
