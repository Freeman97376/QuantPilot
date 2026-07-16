function brokerConfiguration() {
  const url = process.env.QUANTPILOT_SECRET_BROKER_URL?.trim();
  const token = process.env.QUANTPILOT_LAUNCH_TOKEN?.trim();
  if (!url || !token) throw new Error('Desktop secure-storage broker is unavailable.');
  return { url, token };
}

async function callBroker(path: string, body: Record<string, unknown>) {
  const broker = brokerConfiguration();
  const response = await fetch(`${broker.url}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-QuantPilot-Launch-Token': broker.token,
    },
    body: JSON.stringify(body),
    cache: 'no-store',
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || 'Secure storage operation failed.');
  return payload as Record<string, unknown>;
}

export async function putDesktopSecret(value: string, reference?: string | null): Promise<string> {
  const result = await callBroker('/put', { value, reference: reference || undefined });
  if (typeof result.reference !== 'string') throw new Error('Secure storage returned no reference.');
  return result.reference;
}

export async function getDesktopSecret(reference?: string | null): Promise<string | null> {
  if (!reference) return null;
  const result = await callBroker('/get', { reference });
  return typeof result.value === 'string' ? result.value : null;
}

export async function deleteDesktopSecret(reference?: string | null): Promise<void> {
  if (!reference) return;
  await callBroker('/delete', { reference });
}
