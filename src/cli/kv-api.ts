// ============================================================================
// AgentCMS — Cloudflare KV REST API
//
// Thin wrapper around the Cloudflare API for bulk KV writes.
// Used by the `migrate` CLI command to push posts without wrangler.
// ============================================================================

export interface KVBulkEntry {
  key: string;
  value: string;
}

export interface KVWriteResult {
  success: boolean;
  errors: Array<{ code: number; message: string }>;
}

/**
 * Write key-value pairs in bulk to a Cloudflare KV namespace.
 * Uses PUT /accounts/{account_id}/storage/kv/namespaces/{namespace_id}/bulk
 * Supports up to 10,000 pairs per request.
 */
export async function kvBulkWrite(
  accountId: string,
  namespaceId: string,
  apiToken: string,
  entries: KVBulkEntry[]
): Promise<KVWriteResult> {
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/storage/kv/namespaces/${namespaceId}/bulk`;

  const response = await fetch(url, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${apiToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(entries),
  });

  const data = (await response.json()) as {
    success: boolean;
    errors: Array<{ code: number; message: string }>;
  };

  return {
    success: data.success,
    errors: data.errors || [],
  };
}
