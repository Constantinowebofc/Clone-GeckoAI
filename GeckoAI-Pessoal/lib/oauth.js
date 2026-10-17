// The personal edition uses personal access tokens and has no hosted OAuth broker.
export class OAuthError extends Error { constructor(message, motivo) { super(message); this.name = 'OAuthError'; this.motivo = motivo; } }
export async function renovarSupabase() { throw new OAuthError('Reconecte o Supabase com um token pessoal em Configurações.', 'falhou'); }
export function precisaRenovar(expiresAt, agora = Date.now(), folgaMs = 300000) { return Boolean(expiresAt) && expiresAt - agora < folgaMs; }
