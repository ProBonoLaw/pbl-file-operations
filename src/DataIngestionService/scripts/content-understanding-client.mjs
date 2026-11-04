import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { API_VERSION } from "./content-understanding-benchmark.mjs";

/** Small REST client for this benchmark. Never mutates resource model defaults. */
export class ContentUnderstandingClient {
  constructor({ endpoint, headers, fetcher = fetch, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
    now = Date.now, timeoutMs = 15 * 60_000, pollMs = 2000, processingLocation = "geography" }) {
    const url = new URL(endpoint);
    assert(url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash
      && ["", "/"].includes(url.pathname), "Use an HTTPS Foundry resource root endpoint");
    assert(timeoutMs > 0 && timeoutMs <= 30 * 60_000 && pollMs >= 0 && pollMs <= 30_000, "Invalid polling limits");
    assert(["geography", "dataZone", "global"].includes(processingLocation), "Invalid processing location");
    Object.assign(this, { endpoint: url.origin, headers, fetcher, sleep, now, timeoutMs, pollMs, processingLocation });
  }

  url(path) { return `${this.endpoint}/contentunderstanding/${path}${path.includes("?") ? "&" : "?"}api-version=${API_VERSION}`; }

  operationUrl(value) {
    const url = new URL(value, this.endpoint);
    assert.equal(url.origin, this.endpoint, "Operation URL has a different origin");
    assert(url.pathname.startsWith("/contentunderstanding/") && !url.username && !url.password && !url.hash,
      "Invalid Content Understanding operation URL");
    return url.toString();
  }

  async request(url, { method = "GET", body, allow404 = false } = {}) {
    const target = this.operationUrl(url);
    const response = await this.fetcher(target, { method, redirect: "error", signal: AbortSignal.timeout(30_000),
      headers: { ...await this.headers(), "Content-Type": "application/json", "x-ms-diagnostics": "true",
        "x-ms-client-request-id": randomUUID() }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const raw = await response.text();
    let data;
    try { data = raw ? JSON.parse(raw) : {}; } catch { throw new Error(`Content Understanding returned non-JSON (HTTP ${response.status})`); }
    if (allow404 && response.status === 404) return null;
    if (!response.ok) {
      // Service messages can echo inputs; preserve them in a private journal,
      // but keep console errors limited to status/code.
      const error = new Error(`Content Understanding HTTP ${response.status}: ${data.error?.code ?? "request failed"}`);
      error.status = response.status; error.serviceResponse = data;
      const retry = Number(response.headers.get("retry-after"));
      error.retryAfterMs = Number.isFinite(retry) && retry > 0 ? Math.min(retry * 1000, 30_000) : this.pollMs;
      throw error;
    }
    return { data, operation: response.headers.get("operation-location") };
  }

  async modelDeployments(overrides = {}) {
    let defaults = {};
    try { defaults = (await this.request(this.url("defaults"))).data.modelDeployments ?? {}; }
    catch (error) {
      const detail = error.serviceResponse?.error;
      if (error.status !== 400 || ![detail?.code, detail?.innererror?.code].includes("DefaultsNotSet")) throw error;
      // An unconfigured resource can use explicit per-request mappings. Do not
      // follow the service error's suggestion to PATCH resource-wide defaults.
    }
    return { ...defaults, ...overrides };
  }

  async poll(operation, save) {
    const deadline = this.now() + this.timeoutMs;
    let failures = 0;
    while (this.now() < deadline) {
      let response;
      try { response = await this.request(operation); failures = 0; }
      catch (error) {
        if (![429, 500, 502, 503, 504].includes(error.status) || failures++ >= 2) throw error;
        await this.sleep(Math.min(error.retryAfterMs, Math.max(0, deadline - this.now()))); continue;
      }
      const status = response.data.status?.toLowerCase();
      assert(["succeeded", "failed", "canceled", "cancelled", "running", "notstarted"].includes(status), "Unknown operation status");
      await save(response.data);
      if (status === "succeeded") return response.data;
      if (["failed", "canceled", "cancelled"].includes(status)) {
        const error = new Error(`Content Understanding operation ${status}`);
        error.serviceResponse = response.data; throw error;
      }
      await this.sleep(Math.min(this.pollMs, Math.max(0, deadline - this.now())));
    }
    throw new Error("Content Understanding polling deadline reached; resume the saved operation without resubmitting");
  }

  async ensureAnalyzer(id, definition) {
    assert(/^[a-zA-Z0-9_-]+$/.test(id), "Invalid analyzer ID");
    const url = this.url(`analyzers/${id}`);
    const existing = await this.request(url, { allow404: true });
    if (existing) {
      const compare = (expected, actual) => {
        for (const [key, value] of Object.entries(expected)) {
          if (value && typeof value === "object" && !Array.isArray(value)) { assert(actual?.[key]); compare(value, actual[key]); }
          else assert.deepEqual(actual?.[key], value, `Existing analyzer differs at ${key}`);
        }
      };
      compare(definition, existing.data);
      assert(!existing.data.status || existing.data.status.toLowerCase() === "ready", "Existing analyzer is not ready");
      return existing.data;
    }
    const created = await this.request(this.url(`analyzers/${id}?allowReplace=false`), { method: "PUT", body: definition });
    if (created.operation) await this.poll(created.operation, async () => {});
    return (await this.request(url)).data;
  }

  /** Persist submission state first. A lost POST response is not safe to retry. */
  async analyze({ analyzerId, input, modelDeployments, identity, journal, save }) {
    if (journal) assert.deepEqual(journal.identity, identity, "Saved operation has different inputs/configuration");
    if (journal?.phase === "completed") return journal;
    if (journal?.phase === "failed") throw new Error("Saved analysis failed; use a new output directory for an explicit new attempt");
    if (journal?.phase === "submitting") throw new Error("Previous submission outcome is unknown; refusing to submit duplicate work");
    let state = journal ?? { identity, phase: "submitting", startedAt: this.now(), activeElapsedMs: 0 };
    const started = this.now();
    if (!journal) {
      await save(state);
      try {
        const response = await this.request(this.url(`analyzers/${analyzerId}:analyze?stringEncoding=utf16&processingLocation=${this.processingLocation}`), {
          method: "POST", body: { inputs: [input], ...(modelDeployments ? { modelDeployments } : {}) },
        });
        assert(response.operation, "Analyze response has no Operation-Location");
        state = { ...state, phase: "polling", operation: this.operationUrl(response.operation) };
        await save(state);
      } catch (error) {
        // Only a definite HTTP error permits marking submission failed. Network
        // errors retain 'submitting' because Azure might have accepted the work.
        if (error.status) { state.phase = "failed"; state.error = error.serviceResponse; }
        state.activeElapsedMs += this.now() - started;
        await save(state); throw error;
      }
    }
    try {
      const response = await this.poll(state.operation, async response => {
        state.response = response; await save(state);
      });
      state = { ...state, phase: "completed", response };
    } catch (error) {
      if (["failed", "canceled", "cancelled"].includes(state.response?.status?.toLowerCase())) state.phase = "failed";
      if (error.serviceResponse) state.error = error.serviceResponse;
      throw error;
    } finally {
      state.activeElapsedMs += this.now() - started;
      await save(state);
    }
    return state;
  }
}
