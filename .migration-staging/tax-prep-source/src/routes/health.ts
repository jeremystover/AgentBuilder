import type { Env } from '../types';
import { jsonOk } from '../types';
import { getClaudeDiagnostics } from '../lib/claude';

export async function handleClaudeHealth(_request: Request, env: Env): Promise<Response> {
  return jsonOk({
    status: 'ok',
    claude: getClaudeDiagnostics(env),
  });
}
