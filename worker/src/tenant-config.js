export function defaultTenantConfig(env) {
  return {
    tenantKey: env.TENANT_KEY || 'default',
    tenantName: env.TENANT_NAME_FALLBACK || 'テナント',
    baseToken: env.BASE_TOKEN || '',
    tables: {
      dept: env.T_DEPT || '',
      member: env.T_MEM || '',
      plan: env.T_PLAN || '',
      op: env.T_OP || '',
      audit: env.T_AUDIT || '',
      csv: env.T_CSV || '',
      chat: env.T_CHAT || '',
      role: env.T_ROLE || ''
    },
    features: {
      chatGroup: true,
      approval: false,
      notification: false
    }
  };
}

export async function getTenantConfig(env, session) {
  const fallback = defaultTenantConfig(env);
  const tenantKey = session && session.tenantKey ? session.tenantKey : fallback.tenantKey;
  // Future multi-tenant path: store JSON at tenant_config:{tenantKey} in KV.
  // Current deployment keeps using environment variables as the default tenant.
  if (env.SESSIONS && tenantKey && tenantKey !== fallback.tenantKey) {
    const raw = await env.SESSIONS.get(`tenant_config:${tenantKey}`).catch(() => null);
    if (raw) {
      try {
        const cfg = JSON.parse(raw);
        return {
          ...fallback,
          ...cfg,
          tenantKey,
          tables: { ...fallback.tables, ...(cfg.tables || {}) },
          features: { ...fallback.features, ...(cfg.features || {}) }
        };
      } catch (_) { /* fall back to env config */ }
    }
  }
  return { ...fallback, tenantKey };
}
