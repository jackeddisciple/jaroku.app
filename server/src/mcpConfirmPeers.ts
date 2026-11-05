export const CONFIRM_ANSWER_CHANNEL = "mcp-confirm-answer";

const BARRED_USERS_KEY = "__barredUsers";

interface HeldAsk {
  workspaceId: string;
  agentSlug: string | null;
  barred: readonly string[];
  expiresAt: number;
  event: Record<string, unknown>;
}

const keyOf = (workspaceId: string, runId: unknown, nonce: unknown): string => `${workspaceId}:${String(runId)}.${String(nonce)}`;

export class PeerConfirms {
  private asks = new Map<string, HeldAsk>();

  observe(workspaceId: string, payload: unknown, now: number = Date.now()): void {
    const message = payload as Record<string, unknown> | null;
    if (!message || message["channel"] !== "mcp") return;
    const key = keyOf(workspaceId, message["runId"], message["nonce"]);
    if (message["type"] === "confirmResolved") {
      this.asks.delete(key);
      return;
    }
    if (message["type"] !== "confirmRequest") return;
    const { channel: _channel, [BARRED_USERS_KEY]: barred, ...event } = message;
    this.sweep(now);
    this.asks.set(key, {
      workspaceId,
      agentSlug: typeof event["agentSlug"] === "string" ? event["agentSlug"] : null,
      barred: Array.isArray(barred) ? (barred as string[]) : [],
      expiresAt: now + Number(event["timeoutS"] ?? 120) * 1000,
      event,
    });
  }

  find(workspaceId: string, runId: string, nonce: string, now: number = Date.now()): { agentSlug: string | null } | null {
    const ask = this.asks.get(keyOf(workspaceId, runId, nonce));
    return ask && ask.expiresAt > now ? { agentSlug: ask.agentSlug } : null;
  }

  listFor(workspaceId: string, userId: string, now: number = Date.now()): Record<string, unknown>[] {
    return [...this.asks.values()]
      .filter((ask) => ask.workspaceId === workspaceId && ask.expiresAt > now && !ask.barred.includes(userId))
      .map((ask) => ask.event);
  }

  private sweep(now: number): void {
    for (const [key, ask] of this.asks) if (ask.expiresAt <= now) this.asks.delete(key);
  }
}
