const packageJson = require('./package.json');

const baseConfig = packageJson.build || {};
const releaseSigningRequired = process.env.QUANTPILOT_SIGN_RELEASE === '1';
const azureFields = {
  publisherName: process.env.AZURE_SIGNING_PUBLISHER_NAME,
  endpoint: process.env.AZURE_SIGNING_ENDPOINT,
  certificateProfileName: process.env.AZURE_CERTIFICATE_PROFILE_NAME,
  codeSigningAccountName: process.env.AZURE_CODE_SIGNING_ACCOUNT_NAME,
};
const missingAzureFields = Object.entries(azureFields)
  .filter(([, value]) => !value)
  .map(([name]) => name);
const hasAzureIdentity = Boolean(
  process.env.AZURE_TENANT_ID &&
  process.env.AZURE_CLIENT_ID &&
  process.env.AZURE_CLIENT_SECRET
);
const hasCompleteAzureConfiguration = missingAzureFields.length === 0 && hasAzureIdentity;
const hasOvCertificate = Boolean(
  process.env.WIN_CSC_LINK && process.env.WIN_CSC_KEY_PASSWORD
);

if (releaseSigningRequired && !hasCompleteAzureConfiguration && !hasOvCertificate) {
  const missing = [
    ...missingAzureFields,
    ...(!process.env.AZURE_TENANT_ID ? ['AZURE_TENANT_ID'] : []),
    ...(!process.env.AZURE_CLIENT_ID ? ['AZURE_CLIENT_ID'] : []),
    ...(!process.env.AZURE_CLIENT_SECRET ? ['AZURE_CLIENT_SECRET'] : []),
  ];
  throw new Error(
    'A signed release requires a complete Azure Artifact Signing configuration ' +
    `or WIN_CSC_LINK/WIN_CSC_KEY_PASSWORD. Missing Azure values: ${missing.join(', ')}`
  );
}

const win = {
  ...(baseConfig.win || {}),
  signAndEditExecutable: true,
  signExts: ['.exe'],
};

if (hasCompleteAzureConfiguration) {
  win.azureSignOptions = {
    ...azureFields,
    fileDigest: 'SHA256',
    timestampDigest: 'SHA256',
    timestampRfc3161: 'http://timestamp.acs.microsoft.com',
  };
}

module.exports = {
  ...baseConfig,
  forceCodeSigning: releaseSigningRequired,
  win,
};
