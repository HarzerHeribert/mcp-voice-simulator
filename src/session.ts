import {
  DEFAULT_LINK_TIMEOUT_MS,
  LinkTimeoutError,
  linkAccount,
  logAuthorizeUrl,
  type LinkOptions,
} from "./link.js";
import type { ElicitationBroker } from "./elicitation.js";
import { connectMcp, type McpSession } from "./mcp.js";

export interface McpSessionManagerOptions {
  mcpUrl: string;
  /** Skip the OAuth flow entirely if you already have a token. */
  bearerToken?: string;
  /** Passed through to linkAccount() when bearerToken isn't set. */
  link?: Omit<LinkOptions, "mcpUrl">;
  /** Advertise MCP Apps (`ui://` views) support to the server. Default true; false tests a server's text fallback. */
  ui?: boolean;
  /** Advertise elicitation and let the person answer confirmations (SIM_ELICITATION=voice). Off by default. */
  elicitation?: ElicitationBroker;
}

/** Where account linking stands, for a UI that shouldn't have to wait on the human. */
export type LinkStatus =
  | { state: "linked" }
  /** Waiting for the human. `url` is absent only if the server gave a login URL that isn't http(s). */
  | { state: "pending"; url?: string; expiresAt: Date }
  | { state: "failed"; error: string; timedOut: boolean };

interface LinkAttempt {
  promise: Promise<string>;
  /** Settles once the login URL exists; the attempt's clock starts then. */
  urlReady: Promise<void>;
  url?: string;
  expiresAt?: Date;
  done: boolean;
}

function isHttpUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

/** Owns account linking + the MCP connection, lazily and once, re-linking on
 *  demand after invalidate() (e.g. a dead session from an expired token). */
export class McpSessionManager {
  private session: McpSession | null = null;
  private attempt: LinkAttempt | null = null;
  /** The last attempt's failure, until linkStatus() reports it once. */
  private failure: { error: string; timedOut: boolean } | null = null;

  constructor(private readonly options: McpSessionManagerOptions) {}

  get mcpUrl(): string {
    return this.options.mcpUrl;
  }

  async accessToken(): Promise<string> {
    if (this.options.bearerToken) return this.options.bearerToken;
    return (this.attempt ?? this.startAttempt()).promise;
  }

  async ensureSession(): Promise<McpSession> {
    if (this.session) return this.session;
    const token = await this.accessToken();
    this.session = await connectMcp(this.options.mcpUrl, token, { ui: this.options.ui, elicitation: this.options.elicitation });
    return this.session;
  }

  /**
   * Where linking stands, without waiting for the human to finish: starts an attempt if
   * there isn't one, then returns as soon as the login URL is known (or the attempt has
   * already ended). A failure is reported once and then forgotten, so the call after it
   * starts a fresh attempt.
   */
  async linkStatus(): Promise<LinkStatus> {
    if (this.options.bearerToken || this.session) return { state: "linked" };

    const failed = this.takeFailure();
    if (failed) return failed;

    const attempt = this.attempt ?? this.startAttempt();
    await Promise.race([attempt.urlReady, attempt.promise]).catch(() => {});

    if (attempt.done) return { state: "linked" };
    const failedMeanwhile = this.takeFailure();
    if (failedMeanwhile) return failedMeanwhile;
    return { state: "pending", url: attempt.url, expiresAt: attempt.expiresAt ?? new Date() };
  }

  /** Call after a request fails with an auth error, so the next call re-links. */
  invalidate(): void {
    this.session = null;
    // A login still waiting on the human isn't stale, and its URL may be on screen; only a finished one is.
    if (this.attempt?.done) this.attempt = null;
  }

  /** Drops whatever attempt is stored (waiting, failed or finished) and starts a new one, e.g. from a "Try again" button. */
  relink(): void {
    if (this.options.bearerToken) return;
    this.session = null;
    this.attempt = null;
    this.startAttempt();
  }

  private takeFailure(): Extract<LinkStatus, { state: "failed" }> | null {
    if (!this.failure) return null;
    const failure = this.failure;
    this.failure = null;
    return { state: "failed", ...failure };
  }

  private startAttempt(): LinkAttempt {
    this.failure = null;
    const { onAuthorizeUrl = logAuthorizeUrl, timeoutMs = DEFAULT_LINK_TIMEOUT_MS, ...link } = this.options.link ?? {};

    let urlKnown!: () => void;
    const attempt: LinkAttempt = {
      urlReady: new Promise<void>((resolve) => (urlKnown = resolve)),
      done: false,
      promise: undefined as unknown as Promise<string>,
    };
    attempt.promise = linkAccount({
      ...link,
      mcpUrl: this.options.mcpUrl,
      timeoutMs,
      onAuthorizeUrl: (url) => {
        // linkAccount starts waiting right after this returns, so this is when the clock starts.
        attempt.expiresAt = new Date(Date.now() + timeoutMs);
        if (isHttpUrl(url)) attempt.url = url;
        urlKnown();
        onAuthorizeUrl(url);
      },
    }).then((result) => {
      attempt.done = true;
      return result.accessToken;
    });

    this.attempt = attempt;
    attempt.promise.catch((err) => {
      // Superseded by relink(): the newer attempt owns the state now.
      if (this.attempt !== attempt) return;
      // Don't keep a failed attempt, or every later call would get the same error until a restart.
      this.attempt = null;
      this.failure = {
        error: err instanceof Error ? err.message : String(err),
        timedOut: err instanceof LinkTimeoutError,
      };
    });
    return attempt;
  }
}
